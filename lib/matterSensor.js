const { normalizeDeviceId } = require("./hap");

// Matches homebridge-plugins/homebridge-matter's TemperatureSensorAccessory
// reference bounds (-50C to 100C). Matter rejects (rather than clamps) a
// value outside the declared range, so the range is set wide.
const MIN_MEASURED_TEMPERATURE = -5000;
const MAX_MEASURED_TEMPERATURE = 10000;

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

function label(value) {
  return String(value).slice(0, MAX_MATTER_LABEL_LENGTH);
}

// Readings → Matter attribute values (0.01 °C, 0.01 %, half-percent battery).
function toTemperature(celsius) {
  return celsius == null ? null : Math.round(celsius * 100);
}

function toHumidity(percent) {
  return percent == null
    ? null
    : Math.round(Math.min(100, Math.max(0, percent)) * 100);
}

function toBatteryPercent(percent) {
  return percent == null
    ? null
    : Math.round(Math.min(100, Math.max(0, percent)) * 2);
}

// The Matter counterpart of one HomeKit BLE sensor: ONE endpoint carrying
// whatever it measures (temperature and/or humidity) plus its battery.
//
// A single endpoint, rather than a BridgedNode with a child endpoint per
// reading, because some controllers (IKEA Dirigera) list every sensor
// endpoint as its own product. For a sensor measuring both, that needs a
// composed device type (TemperatureSensor plus the HumiditySensor's
// relativeHumidityMeasurement behavior) and a descriptor naming both device
// types. Known Homebridge limitation: a composed type is re-created on every
// restart with a new uniqueId (homebridge/homebridge#4018).
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

  // `capabilities`: which of temperature / humidity / battery the sensor has.
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
    this.capabilities = capabilities;

    // See the CGDK2 plugin: registerPlatformAccessories() is fire-and-forget,
    // and pushes are dropped until it resolves, or for good once it rejected.
    this.registered = false;
    this.registrationFailed = false;
    // State pushed before registration completed, per cluster (see
    // markRegistered).
    this.pending = new Map();
    // Homebridge creates every bridged device as reachable.
    this.reachable = true;

    const { TemperatureSensor, HumiditySensor } = matter.deviceTypes;
    const clusters = {};
    let deviceType;
    if (capabilities.temperature && capabilities.humidity) {
      deviceType = TemperatureSensor.with(
        HumiditySensor.behaviors.relativeHumidityMeasurement,
      );
      clusters.descriptor = {
        deviceTypeList: [
          {
            deviceType: TemperatureSensor.deviceType,
            revision: TemperatureSensor.deviceRevision,
          },
          {
            deviceType: HumiditySensor.deviceType,
            revision: HumiditySensor.deviceRevision,
          },
        ],
      };
    } else if (capabilities.humidity) {
      deviceType = HumiditySensor;
    } else {
      deviceType = TemperatureSensor;
    }
    if (capabilities.temperature) {
      clusters.temperatureMeasurement = {
        measuredValue: toTemperature(readings?.temperature),
        minMeasuredValue: MIN_MEASURED_TEMPERATURE,
        maxMeasuredValue: MAX_MEASURED_TEMPERATURE,
      };
    }
    if (capabilities.humidity) {
      clusters.relativeHumidityMeasurement = {
        measuredValue: toHumidity(readings?.humidity),
        minMeasuredValue: 0,
        maxMeasuredValue: 10000,
      };
    }
    if (capabilities.battery) {
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
      deviceType,
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
  }

  toAccessories() {
    return [this.accessory];
  }

  // Also sends whatever was pushed while not yet registered (the latest
  // value per cluster), so a reading that arrives during registration isn't
  // lost until the next one.
  markRegistered() {
    this.registered = true;
    const pending = [...this.pending];
    this.pending.clear();
    for (const [cluster, attributes] of pending) {
      this.pushState(cluster, attributes);
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

  // `readings`: {temperature, humidity, batteryLevel, lowBattery}, any of
  // them undefined when not read.
  async update(readings) {
    const { temperature, humidity, batteryLevel, lowBattery } = readings ?? {};
    if (this.capabilities.temperature && temperature !== undefined) {
      await this.pushState("temperatureMeasurement", {
        measuredValue: toTemperature(temperature),
      });
    }
    if (this.capabilities.humidity && humidity !== undefined) {
      await this.pushState("relativeHumidityMeasurement", {
        measuredValue: toHumidity(humidity),
      });
    }
    if (
      this.capabilities.battery &&
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

  async pushState(cluster, attributes) {
    if (this.registrationFailed) {
      return;
    }
    if (!this.registered) {
      this.pending.set(cluster, {
        ...this.pending.get(cluster),
        ...attributes,
      });
      return;
    }
    try {
      await this.matter.updateAccessoryState(
        this.accessory.UUID,
        cluster,
        attributes,
      );
    } catch (error) {
      this.log.error(
        `[${this.deviceId}] Failed to update Matter ${cluster} state:`,
        error,
      );
    }
  }
}

// What a parsed accessory database (see parseAccessoryDatabase) can report.
function capabilitiesOf(readings) {
  return {
    temperature: readings.temperature != null,
    humidity: readings.humidity != null,
    battery: readings.batteryLevel != null || readings.lowBattery != null,
  };
}

module.exports = { MatterSensor, capabilitiesOf };
