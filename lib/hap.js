const { createRequire } = require("module");

// Bluetooth access for hap-controller. hap-controller 0.10.2 depends on
// noble 1, which talks to the adapter over raw HCI. On a Raspberry Pi that
// failed to hold a connection to a HomeKit sensor at all (0 of 6 attempts:
// the sensor terminated each link), while noble 2 over BlueZ's D-Bus API
// connected 5 of 5 times at the same spot - and needs neither root nor raw
// socket capabilities, and doesn't fight bluetoothd.
//
// hap-controller requires noble in exactly one place (its BLE discovery) and
// otherwise only uses the peripheral/characteristic objects noble hands out,
// through the async API noble 2 still provides. So instead of forking it,
// the noble 2 instance is placed in the require cache under the path
// hap-controller would load noble 1 from. hap-controller is pinned to an
// exact version in package.json, so this can't silently break on an update.
function injectNoble(binding) {
  const { withBindings } = require("@stoprocent/noble");
  const discoveryFile =
    require.resolve("hap-controller/lib/transport/ble/ble-discovery");
  const noblePath = createRequire(discoveryFile).resolve("@stoprocent/noble");
  const cached = require.cache[noblePath];
  if (cached?.homekitBleMatterBinding != null) {
    return cached.exports;
  }
  const noble = withBindings(binding);
  if (binding === "dbus") {
    guardDbusConnectionErrors(noble);
  }
  require.cache[noblePath] = {
    id: noblePath,
    filename: noblePath,
    loaded: true,
    exports: noble,
    homekitBleMatterBinding: binding,
  };
  return noble;
}

// noble 2.8.0's D-Bus binding doesn't listen for the D-Bus connection's own
// 'error' event, so on a host without a reachable system bus (e.g. a Docker
// container without the D-Bus socket) that event is unhandled and crashes
// the whole child bridge. Catch it and report the adapter as unsupported
// instead, which noble surfaces as an ordinary stateChange (see platform.js).
// Relies on noble's private _bindings/_bus: noble is pinned to 2.8.0.
function guardDbusConnectionErrors(noble) {
  const bindings = noble._bindings;
  if (bindings == null || typeof bindings.start !== "function") {
    return;
  }
  const start = bindings.start.bind(bindings);
  bindings.start = () => {
    start();
    bindings._bus?.on?.("error", (error) => {
      bindings.emit("warning", `D-Bus connection failed: ${error.message}`);
      if (bindings._state !== "unsupported") {
        bindings._state = "unsupported";
        bindings.emit("stateChange", "unsupported");
      }
    });
  };
}

// Clears a connection state noble 2.8.0's D-Bus binding leaves behind and
// never recovers from. A failed connect (e.g. BlueZ's
// "le-connection-abort-by-local") leaves the peripheral in state 'error'.
// hap-controller then disconnects first before reconnecting, but the binding
// drops a disconnect for a device it holds no connection to without emitting
// 'disconnect' - so that disconnect never completes, every later attempt times
// out in state 'disconnecting', and only a restart helped. Called before each
// connection; connections run one at a time (ConnectionQueue), so any state
// other than connected/disconnected at that point is a leftover.
function releaseStalePeripheral(peripheral) {
  if (
    peripheral != null &&
    peripheral.state !== "connected" &&
    peripheral.state !== "disconnected" &&
    peripheral.state != null
  ) {
    const previous = peripheral.state;
    peripheral.state = "disconnected";
    return previous;
  }
  return null;
}

// Everything this plugin needs from hap-controller, loaded lazily: requiring
// hap-controller initializes Bluetooth at module load, which must not happen
// just because Homebridge loaded the plugin - only once discovery actually
// starts. Tests pass their own implementation of this shape instead.
//
// `binding`: "dbus" (BlueZ, default) or "hci" (raw HCI, needs capabilities).
function loadHap({ binding = "dbus" } = {}) {
  const noble = injectNoble(binding);
  const { BLEDiscovery, GattClient } = require("hap-controller");
  const {
    characteristicFromUuid,
  } = require("hap-controller/lib/model/characteristic");
  const { serviceFromUuid } = require("hap-controller/lib/model/service");
  return {
    BLEDiscovery,
    GattClient,
    characteristicFromUuid,
    serviceFromUuid,
    noble,
  };
}

// HomeKit Accessory Protocol names (as returned by hap-controller's
// characteristicFromUuid/serviceFromUuid) for what this plugin reads.
const SERVICES = {
  accessoryInformation: "public.hap.service.accessory-information",
};

const READINGS = {
  temperature: "public.hap.characteristic.temperature.current",
  humidity: "public.hap.characteristic.relative-humidity.current",
  batteryLevel: "public.hap.characteristic.battery-level",
  lowBattery: "public.hap.characteristic.status-lo-batt",
};

const INFO = {
  manufacturer: "public.hap.characteristic.manufacturer",
  model: "public.hap.characteristic.model",
  serialNumber: "public.hap.characteristic.serial-number",
  firmwareRevision: "public.hap.characteristic.firmware.revision",
};

// HomeKit accessory category advertised by sensors (HAP spec table 12-3).
const CATEGORY_SENSOR = 10;

// Reduces hap-controller's accessory database to the characteristics this
// plugin reads, keyed by READINGS/INFO name, each with the addressing a BLE
// read needs ({serviceUuid, characteristicUuid, iid, format}). Info fields
// are only taken from the accessory-information service: `name` and friends
// also appear on every other service.
function parseAccessoryDatabase(
  { accessories },
  { characteristicFromUuid, serviceFromUuid },
) {
  const readings = {};
  const info = {};
  for (const accessory of accessories ?? []) {
    for (const service of accessory.services ?? []) {
      const serviceName = serviceFromUuid(service.type);
      for (const characteristic of service.characteristics ?? []) {
        const name = characteristicFromUuid(characteristic.type);
        const address = {
          serviceUuid: service.type,
          characteristicUuid: characteristic.type,
          iid: characteristic.iid,
          format: characteristic.format,
        };
        for (const [key, hapName] of Object.entries(READINGS)) {
          if (name === hapName && readings[key] == null) {
            readings[key] = address;
          }
        }
        if (serviceName === SERVICES.accessoryInformation) {
          for (const [key, hapName] of Object.entries(INFO)) {
            if (name === hapName) {
              info[key] = address;
            }
          }
        }
      }
    }
  }
  return { readings, info };
}

// Accepts the setup code however it's printed or typed ("12884842",
// "1288 4842", "128-84-842") and returns HomeKit's XXX-YY-ZZZ form, or null.
function normalizeSetupCode(code) {
  const digits = String(code ?? "").replace(/\D/g, "");
  if (digits.length !== 8) {
    return null;
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

// DeviceIDs are compared case-insensitively; hap-controller reports them in
// whatever case the advertisement produced.
function normalizeDeviceId(deviceId) {
  return String(deviceId ?? "")
    .trim()
    .toUpperCase();
}

module.exports = {
  loadHap,
  releaseStalePeripheral,
  parseAccessoryDatabase,
  normalizeSetupCode,
  normalizeDeviceId,
  READINGS,
  INFO,
  CATEGORY_SENSOR,
};
