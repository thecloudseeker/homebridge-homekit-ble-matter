const { normalizeDeviceId } = require("./hap");
const { READINGS, baseKey } = require("./sensorTypes");
const {
  planEndpoints,
  endpointType,
  endpointState,
} = require("./matterMapping");

// Matter caps these string fields at 32 characters.
const MAX_MATTER_LABEL_LENGTH = 32;

// PowerSource enum values (Matter Core spec 11.7).
const POWER_SOURCE_STATUS_ACTIVE = 1;
const BAT_CHARGE_LEVEL_OK = 0;
const BAT_CHARGE_LEVEL_WARNING = 1;
// Battery-powered HomeKit BLE sensors (e.g. the CGG1H's coin cell) take a
// battery the user swaps. Homebridge always adds the Rechargeable (not the
// Replaceable) PowerSource feature, so battery type and count can't be set.
const BAT_REPLACEABILITY_USER_REPLACEABLE = 2;

// Matter's switch tells a long press from a short one by how long the
// button is held (2 s by default), and counts presses less than 300 ms
// apart as one multi-press.
const LONG_PRESS_MS = 2500;
const DOUBLE_PRESS_GAP_MS = 100;

function label(value) {
  return String(value).slice(0, MAX_MATTER_LABEL_LENGTH);
}

// Half-percent units (0-200).
function toBatteryPercent(percent) {
  return percent == null
    ? null
    : Math.round(Math.min(100, Math.max(0, percent)) * 2);
}

// The Matter counterpart of one HomeKit BLE sensor: its readings grouped
// into endpoints by lib/matterMapping.js - one endpoint for a single kind of
// sensor (the common case), otherwise a main endpoint plus parts - with the
// battery on the main endpoint.
//
// One endpoint wherever possible, rather than a BridgedNode with a child per
// reading, because some controllers (IKEA Dirigera) list every sensor
// endpoint as its own product. Known Homebridge limitation: a composed type
// is re-created on every restart with a new uniqueId
// (homebridge/homebridge#4018).
class MatterSensor {
  // `matterId`: the device's identity towards Matter controllers - its
  // DeviceID unless configured otherwise. A factory reset gives a HomeKit
  // device a new DeviceID; keeping the old one as matterId keeps the same
  // Matter device (room, name, automations).
  static uuidFor(matter, matterId) {
    return matter.uuid.generate(
      `homebridge-homekit-ble-matter:${normalizeDeviceId(matterId)}`,
    );
  }

  // `capabilities`: the reading keys the sensor has (see capabilitiesOf).
  // `info`: manufacturer/model/serialNumber/firmwareRevision read from it.
  // `readings`: the last readings from a previous run, if any. Used as the
  // initial values: a measurement left at null ("unknown") is shown by IKEA
  // Dirigera as the top of the declared range (100 °C).
  constructor(
    matter,
    log,
    { deviceId, matterId, name, capabilities, info, readings },
  ) {
    this.matter = matter;
    this.log = log;
    this.deviceId = deviceId;
    this.capabilities = normalizeCapabilities(capabilities);
    this.hasBattery = this.capabilities.some(
      (key) => key === "batteryLevel" || key === "lowBattery",
    );
    this.plan = planEndpoints(this.capabilities);
    if (this.plan.length === 0) {
      throw new Error(
        "Nothing this device reports can be exposed over Matter.",
      );
    }

    // See the CGDK2 plugin: registerPlatformAccessories() is fire-and-forget,
    // and pushes are dropped until it resolves, or for good once it rejected.
    this.registered = false;
    this.registrationFailed = false;
    // State pushed before registration completed, per part and cluster (see
    // markRegistered).
    this.pending = new Map();
    // Homebridge creates every bridged device as reachable.
    this.reachable = true;

    const types = matter.deviceTypes;
    const [main, ...parts] = this.plan;
    const mainType = endpointType(types, main);
    const clusters = endpointState(main, readings, { initial: true });
    if (mainType.descriptor != null) {
      clusters.descriptor = { deviceTypeList: mainType.descriptor };
    }
    if (this.hasBattery) {
      clusters.powerSource = {
        status: POWER_SOURCE_STATUS_ACTIVE,
        order: 0,
        description: "Battery",
        endpointList: [],
        batPercentRemaining: toBatteryPercent(readings?.batteryLevel),
        batChargeLevel: readings?.lowBattery
          ? BAT_CHARGE_LEVEL_WARNING
          : BAT_CHARGE_LEVEL_OK,
        batReplacementNeeded: Boolean(readings?.lowBattery),
        batReplaceability: BAT_REPLACEABILITY_USER_REPLACEABLE,
      };
    }

    this.accessory = {
      UUID: MatterSensor.uuidFor(matter, matterId || deviceId),
      displayName: label(name),
      deviceType: mainType.deviceType,
      serialNumber: label(info.serialNumber || normalizeDeviceId(deviceId)),
      manufacturer: label(info.manufacturer || "Unknown"),
      model: label(info.model || "HomeKit BLE sensor"),
      firmwareRevision: info.firmwareRevision || undefined,
      context: {
        deviceId: normalizeDeviceId(deviceId),
        matterId: normalizeDeviceId(matterId || deviceId),
      },
      clusters,
    };
    if (parts.length > 0) {
      this.accessory.parts = parts.map((endpoint, index) => {
        const { deviceType, descriptor } = endpointType(types, endpoint);
        const displayName = `${label(name)} ${endpoint.label}`;
        const partClusters = endpointState(endpoint, readings, {
          initial: true,
        });
        if (descriptor != null) {
          // Homebridge gives every part a descriptor tag (Number namespace,
          // the part's index and name), and a part's own descriptor state
          // replaces Homebridge's - so it's repeated here, or matter.js
          // rejects the part for an empty tag list.
          partClusters.descriptor = {
            deviceTypeList: descriptor,
            tagList: [
              {
                mfgCode: null,
                namespaceId: 7,
                tag: index,
                label: displayName.slice(0, 64),
              },
            ],
          };
        }
        return {
          id: endpoint.id,
          displayName,
          deviceType,
          clusters: partClusters,
        };
      });
    }
  }

  // What it reports, for the log: "temperature, humidity, battery", with
  // parts after "+": "motion, battery + light level".
  describe() {
    const words = (key) =>
      key
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .replace(/\./, " #");
    return this.plan
      .map((endpoint, index) => {
        const readings = Object.values(endpoint.roles).map(words);
        if (index === 0 && this.hasBattery) {
          readings.push("battery");
        }
        return readings.join(", ");
      })
      .join(" + ");
  }

  toAccessories() {
    return [this.accessory];
  }

  // Also sends whatever was pushed while not yet registered (the latest
  // value per cluster), so a reading that arrives during registration isn't
  // lost until the next one.
  markRegistered() {
    this.registered = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const { partId, cluster, attributes } of pending) {
      this.pushState(cluster, attributes, partId);
    }
  }

  markRegistrationFailed() {
    this.registrationFailed = true;
  }

  // Homebridge restores a cached accessory onto its existing endpoint and
  // only swaps in new metadata, so a renamed device would never reach
  // controllers. NodeLabel may change at runtime, so push it explicitly.
  async syncNodeLabel() {
    await this.pushState("bridgedDeviceBasicInformation", {
      nodeLabel: this.accessory.displayName,
    });
  }

  // Controllers show an unreachable bridged device as not responding, while
  // it keeps its last values (see BleSensor.checkTimeout).
  async setReachable(reachable) {
    if (this.reachable === reachable) {
      return;
    }
    this.reachable = reachable;
    await this.pushState("bridgedDeviceBasicInformation", { reachable });
  }

  // `readings`: reading key → value (see lib/sensorTypes.js); undefined for
  // one that wasn't read. Only what the device has is pushed.
  async update(readings) {
    for (const [index, endpoint] of this.plan.entries()) {
      const partId = index === 0 ? undefined : endpoint.id;
      for (const [cluster, attributes] of Object.entries(
        endpointState(endpoint, readings),
      )) {
        await this.pushState(cluster, attributes, partId);
      }
    }
    const { batteryLevel, lowBattery } = readings ?? {};
    if (
      this.hasBattery &&
      (batteryLevel !== undefined || lowBattery !== undefined)
    ) {
      const attributes = {};
      if (batteryLevel !== undefined) {
        // Half-percent units (0-200).
        attributes.batPercentRemaining = toBatteryPercent(batteryLevel);
      }
      if (lowBattery !== undefined) {
        attributes.batChargeLevel = lowBattery
          ? BAT_CHARGE_LEVEL_WARNING
          : BAT_CHARGE_LEVEL_OK;
        attributes.batReplacementNeeded = Boolean(lowBattery);
      }
      await this.pushState("powerSource", attributes);
    }
  }

  // A button press: `key` is the button's reading key ("button",
  // "button.2"), `gesture` HomeKit's 0 single / 1 double / 2 long press.
  // Sent as the press/release sequence Matter's switch turns into its
  // events (short release, long release, multi-press), like Homebridge's
  // own switch helper does.
  async press(key, gesture) {
    const index = this.plan.findIndex(
      (endpoint) => endpoint.roles.button === key,
    );
    if (index < 0) {
      return;
    }
    const partId = index === 0 ? undefined : this.plan[index].id;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const down = () => this.pushState("switch", { currentPosition: 1 }, partId);
    const up = () => this.pushState("switch", { currentPosition: 0 }, partId);
    await down();
    if (gesture === 2) {
      await wait(LONG_PRESS_MS);
    }
    await up();
    if (gesture === 1) {
      await wait(DOUBLE_PRESS_GAP_MS);
      await down();
      await up();
    }
  }

  // `partId`: the part (child endpoint) the cluster is on; undefined for
  // the main endpoint.
  async pushState(cluster, attributes, partId) {
    if (this.registrationFailed) {
      return;
    }
    if (!this.registered) {
      const key = JSON.stringify([partId ?? null, cluster]);
      this.pending.set(key, {
        partId,
        cluster,
        attributes: { ...this.pending.get(key)?.attributes, ...attributes },
      });
      return;
    }
    try {
      await this.matter.updateAccessoryState(
        this.accessory.UUID,
        cluster,
        attributes,
        partId,
      );
    } catch (error) {
      this.log.error(
        `[${this.deviceId}] Failed to update Matter ${cluster} state${partId == null ? "" : ` (${partId})`}:`,
        error,
      );
    }
  }
}

// What a parsed accessory database (see parseAccessoryDatabase) can report:
// its reading keys, sorted.
function capabilitiesOf(readings) {
  return Object.keys(readings ?? {})
    .filter((key) => READINGS[baseKey(key)] != null)
    .sort();
}

// Also accepts the older {temperature, humidity, battery} flags.
function normalizeCapabilities(capabilities) {
  if (Array.isArray(capabilities)) {
    return capabilities;
  }
  const keys = [];
  for (const [key, has] of Object.entries(capabilities ?? {})) {
    if (!has) {
      continue;
    }
    if (key === "battery") {
      keys.push("batteryLevel", "lowBattery");
    } else {
      keys.push(key);
    }
  }
  return keys.sort();
}

// Whether a device reporting these readings can be exposed over Matter.
function canExpose(capabilities) {
  return planEndpoints(normalizeCapabilities(capabilities)).length > 0;
}

module.exports = { MatterSensor, capabilitiesOf, canExpose };
