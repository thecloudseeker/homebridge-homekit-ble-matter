const { createRequire } = require("module");
const { READINGS, instanceKey } = require("./sensorTypes");

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
//
// `adapter`: the BlueZ adapter to use (e.g. "hci1"), or null for the first.
function injectNoble(adapter) {
  const binding = "dbus";
  const { withBindings } = require("@stoprocent/noble");
  const discoveryFile =
    require.resolve("hap-controller/lib/transport/ble/ble-discovery");
  const noblePath = createRequire(discoveryFile).resolve("@stoprocent/noble");
  const cached = require.cache[noblePath];
  if (cached?.homekitBleMatterBinding != null) {
    return cached.exports;
  }
  // Too late to swap: another plugin in this process already loaded the same
  // hap-controller, and with it noble 1. The swap would do nothing, and two
  // Bluetooth stacks would fight over the adapter.
  if (cached != null || require.cache[discoveryFile] != null) {
    throw new Error(
      "Another plugin in this Homebridge process already loaded hap-controller with its own Bluetooth library, which this plugin can't replace. Run this plugin as a child bridge (Homebridge settings → Bridge Settings → enable Child Bridge).",
    );
  }
  const noble = withBindings(
    binding,
    adapter != null ? { adapterId: adapter } : {},
  );
  guardDbusBinding(noble);
  require.cache[noblePath] = {
    id: noblePath,
    filename: noblePath,
    loaded: true,
    exports: noble,
    homekitBleMatterBinding: binding,
  };
  return noble;
}

// Fixes to noble 2.8.0's D-Bus binding. Relies on its private
// _bindings/_bus/_devices/_state: noble is pinned to 2.8.0.
function guardDbusBinding(noble) {
  const bindings = noble._bindings;
  if (bindings == null || typeof bindings.start !== "function") {
    return;
  }
  // The binding doesn't listen for the D-Bus connection's 'error' event, so
  // on a host without a reachable system bus (e.g. a Docker container
  // without the D-Bus socket) that event is unhandled and crashes the whole
  // child bridge. Before the adapter came up, report it as unsupported,
  // which noble surfaces as an ordinary stateChange (see platform.js).
  // Afterwards, don't: dbus-next also emits 'error' for a single message it
  // fails to parse while the connection keeps working, and 'unsupported'
  // makes noble drop every known device for good - every later connection
  // then hangs ("unknown peripheral ... connected!") until a restart.
  const start = bindings.start.bind(bindings);
  const reportKeptError = rateLimitedWarning(noble, DBUS_ERROR_REPORT_MS);
  bindings.start = () => {
    start();
    fixMatchRuleRefcounts(bindings._bus);
    bindings._bus?.on?.("error", (error) => {
      if (bindings._state === "poweredOn" || bindings._state === "poweredOff") {
        reportKeptError(`D-Bus error (connection kept): ${error.message}`);
        return;
      }
      noble.emit("warning", `D-Bus connection failed: ${error.message}`);
      if (bindings._state !== "unsupported") {
        bindings._state = "unsupported";
        bindings.emit("stateChange", "unsupported");
      }
    });
  };
  // A disconnect for a device the binding holds no connection to (e.g.
  // after a failed connect) returns without emitting 'disconnect', so
  // noble's disconnect never completes: hap-controller waits 30s for it on
  // every failed attempt and leaks a listener each time. Complete it.
  const disconnect = bindings.disconnect?.bind(bindings);
  if (disconnect != null) {
    bindings.disconnect = (peripheralUuid) => {
      const id = String(peripheralUuid ?? "")
        .replace(/:/g, "")
        .toLowerCase();
      if (bindings._devices?.get(id)?.proxy == null) {
        setImmediate(() => bindings.emit("disconnect", id, "local"));
        return;
      }
      disconnect(peripheralUuid);
    };
  }
}

// An error the connection survives is reported once, then summarised at
// most every DBUS_ERROR_REPORT_MS, so a persistent one can't flood the log.
const DBUS_ERROR_REPORT_MS = 10 * 60 * 1000;

function rateLimitedWarning(noble, intervalMs, now = Date.now) {
  let lastAt = -Infinity;
  let suppressed = 0;
  return (message) => {
    const at = now();
    if (at - lastAt < intervalMs) {
      suppressed += 1;
      return;
    }
    const repeats =
      suppressed > 0
        ? ` (${suppressed} more in the last ${Math.round((at - lastAt) / 60000)} min)`
        : "";
    lastAt = at;
    suppressed = 0;
    noble.emit("warning", `${message}${repeats}`);
  };
}

// dbus-next 0.10.2 refcounts match rules (signal subscriptions) with
// hasOwnProperty.call(match, this._matchRules), arguments swapped, so the
// check is always false: every listener sends AddMatch, and _removeMatch
// returns early without ever sending RemoveMatch. noble adds a
// PropertiesChanged listener for every device the scan sees - phones rotate
// their addresses - so the connection's rules only grow, until the bus
// refuses more ("not allowed to add more match rules",
// max_match_rules_per_connection=2048) roughly half a day after a start.
// From then on the binding can't subscribe to any new device.
// Replaced with a working refcount; dbus-next is pinned to 0.10.2.
function fixMatchRuleRefcounts(bus) {
  if (
    bus == null ||
    typeof bus._addMatch !== "function" ||
    typeof bus._removeMatch !== "function" ||
    typeof bus.call !== "function"
  ) {
    return;
  }
  const { Message } = require("dbus-next");
  const counts = new Map();
  const send = (member, match) =>
    bus.call(
      new Message({
        path: "/org/freedesktop/DBus",
        destination: "org.freedesktop.DBus",
        interface: "org.freedesktop.DBus",
        member,
        signature: "s",
        body: [match],
      }),
    );
  bus._addMatch = (match) => {
    const count = counts.get(match) ?? 0;
    counts.set(match, count + 1);
    if (count > 0) {
      return Promise.resolve();
    }
    return send("AddMatch", match).catch((error) => {
      // Not registered after all.
      const current = counts.get(match) ?? 0;
      if (current <= 1) {
        counts.delete(match);
      } else {
        counts.set(match, current - 1);
      }
      throw error;
    });
  };
  bus._removeMatch = (match) => {
    const count = counts.get(match) ?? 0;
    if (count === 0) {
      return Promise.resolve();
    }
    if (count > 1) {
      counts.set(match, count - 1);
      return Promise.resolve();
    }
    counts.delete(match);
    if (bus._connection?.stream?.writable === false) {
      return Promise.resolve();
    }
    return send("RemoveMatch", match);
  };
  bus.homekitBleMatterMatchRules = counts;
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

// The name of a BlueZ adapter ("hci0", "hci1", ...), or null if `value`
// isn't one.
function normalizeAdapter(value) {
  const name = String(value ?? "")
    .trim()
    .toLowerCase();
  return /^hci\d+$/.test(name) ? name : null;
}

const BLUEZ_SERVICE = "org.bluez";
const BLUEZ_DEVICE = "org.bluez.Device1";

// The devices among `addresses` (Bluetooth addresses) that BlueZ holds a
// connection to on our adapter, as [address, D-Bus path]. `objects` is
// BlueZ's object tree as noble's D-Bus binding keeps it.
function connectedDevices(objects, adapterPath, addresses) {
  const wanted = new Set(addresses.map((a) => String(a).toUpperCase()));
  const found = [];
  if (!(objects instanceof Map) || !adapterPath) {
    return found;
  }
  for (const [path, interfaces] of objects) {
    const device = interfaces?.[BLUEZ_DEVICE];
    const address = String(device?.Address ?? "").toUpperCase();
    if (
      device?.Connected === true &&
      path.startsWith(`${adapterPath}/`) &&
      wanted.has(address)
    ) {
      found.push([address, path]);
    }
  }
  return found;
}

// BlueZ keeps a connection it made on our behalf when this process dies
// without disconnecting (a crash, a kill), and a connected sensor stops
// advertising: it would stay invisible until its battery is taken out. Right
// after startup no connection to one of our sensors can be ours, so any that
// BlueZ still holds is disconnected. Resolves with the addresses it
// disconnected. Relies on noble 2.8.0's private _objects/_adapterPath/_bus.
async function disconnectLeftovers(noble, addresses) {
  const bindings = noble?._bindings;
  const bus = bindings?._bus;
  const done = [];
  if (typeof bus?.getProxyObject !== "function") {
    return done;
  }
  for (const [address, path] of connectedDevices(
    bindings._objects,
    bindings._adapterPath,
    addresses,
  )) {
    try {
      const proxy = await bus.getProxyObject(BLUEZ_SERVICE, path);
      await proxy.getInterface(BLUEZ_DEVICE).Disconnect();
      done.push(address);
    } catch (error) {
      noble.emit(
        "warning",
        `Could not disconnect ${address}, still connected from before: ${error.message}`,
      );
    }
  }
  return done;
}

// Everything this plugin needs from hap-controller, loaded lazily: requiring
// hap-controller initializes Bluetooth at module load, which must not happen
// just because Homebridge loaded the plugin - only once discovery actually
// starts. Tests pass their own implementation of this shape instead.
//
// `adapter`: the BlueZ adapter to use (e.g. "hci1"); the first one if not
// given.
function loadHap({ adapter = null } = {}) {
  const noble = injectNoble(adapter);
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
    // The adapter actually in use ("hci0"), once Bluetooth is up.
    adapterInUse: () => noble._bindings?._adapterPath?.split("/").pop() ?? null,
    disconnectLeftovers: (addresses) => disconnectLeftovers(noble, addresses),
  };
}

// HomeKit Accessory Protocol names (as returned by hap-controller's
// characteristicFromUuid/serviceFromUuid) for what this plugin reads.
const SERVICES = {
  accessoryInformation: "public.hap.service.accessory-information",
};

const INFO = {
  manufacturer: "public.hap.characteristic.manufacturer",
  model: "public.hap.characteristic.model",
  serialNumber: "public.hap.characteristic.serial-number",
  firmwareRevision: "public.hap.characteristic.firmware.revision",
};

// HomeKit accessory category advertised by sensors (HAP spec table 12-3).
const CATEGORY_SENSOR = 10;

// HAP characteristic name → reading key (see lib/sensorTypes.js).
const READING_BY_HAP = new Map(
  Object.entries(READINGS).map(([key, { hap }]) => [hap, key]),
);

// Reduces hap-controller's accessory database to the characteristics this
// plugin reads, keyed by READINGS/INFO name, each with the addressing a BLE
// read needs ({serviceUuid, characteristicUuid, iid, format}). Info fields
// are only taken from the accessory-information service: `name` and friends
// also appear on every other service.
//
// A reading that appears again on a further service gets the next instance
// key ("temperature.2"), except the per-device ones (battery), which are
// taken once. A characteristic that can't be read (no "pr" permission, e.g.
// an event-only one) is skipped.
function parseAccessoryDatabase(
  { accessories },
  { characteristicFromUuid, serviceFromUuid },
) {
  const readings = {};
  const info = {};
  const instances = new Map();
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
          // "ev-broadcast" among them: it can broadcast changes (see
          // lib/broadcast.js).
          perms: Array.isArray(characteristic.perms)
            ? characteristic.perms
            : [],
        };
        const key = READING_BY_HAP.get(name);
        const readable =
          !Array.isArray(characteristic.perms) ||
          characteristic.perms.includes("pr");
        if (key != null && readable) {
          if (READINGS[key].perDevice) {
            if (readings[key] == null) {
              readings[key] = address;
            }
          } else {
            const instance = (instances.get(key) ?? 0) + 1;
            instances.set(key, instance);
            readings[instanceKey(key, instance)] = address;
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
  fixMatchRuleRefcounts,
  rateLimitedWarning,
  connectedDevices,
  disconnectLeftovers,
  normalizeAdapter,
  loadHap,
  releaseStalePeripheral,
  parseAccessoryDatabase,
  normalizeSetupCode,
  normalizeDeviceId,
  READINGS,
  INFO,
  CATEGORY_SENSOR,
};
