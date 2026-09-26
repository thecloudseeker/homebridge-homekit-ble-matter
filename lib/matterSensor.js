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
const BAT_REPLACEABILITY_UNSPECIFIED = 0;

function label(value) {
  return String(value).slice(0, MAX_MATTER_LABEL_LENGTH);
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
  static uuidFor(matter, deviceId) {
    return matter.uuid.generate(
      `homebridge-homekit-ble-matter:${normalizeDeviceId(deviceId)}`,
    );
  }

  // `capabilities`: which of temperature / humidity / battery the sensor has.
  // `info`: manufacturer/model/serialNumber/firmwareRevision read from it.
  constructor(matter, log, { deviceId, name, capabilities, info }) {
    this.matter = matter;
    this.log = log;
    this.deviceId = deviceId;
    this.capabilities = capabilities;

    // See the CGDK2 plugin: registerPlatformAccessories() is fire-and-forget,
    // and pushes are dropped until it resolves, or for good once it rejected.
    this.registered = false;
    this.registrationFailed = false;

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
        measuredValue: null,
        minMeasuredValue: MIN_MEASURED_TEMPERATURE,
        maxMeasuredValue: MAX_MEASURED_TEMPERATURE,
      };
    }
    if (capabilities.humidity) {
      clusters.relativeHumidityMeasurement = {
        measuredValue: null,
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
        batPercentRemaining: null,
        batChargeLevel: BAT_CHARGE_LEVEL_OK,
        batReplacementNeeded: false,
        batReplaceability: BAT_REPLACEABILITY_UNSPECIFIED,
      };
    }

    this.accessory = {
      UUID: MatterSensor.uuidFor(matter, deviceId),
      displayName: label(name),
      deviceType,
      serialNumber: label(info.serialNumber || normalizeDeviceId(deviceId)),
      manufacturer: label(info.manufacturer || "Unknown"),
      model: label(info.model || "HomeKit BLE sensor"),
      firmwareRevision: info.firmwareRevision || undefined,
      context: { deviceId: normalizeDeviceId(deviceId) },
      clusters,
    };
  }

  toAccessories() {
    return [this.accessory];
  }

  markRegistered() {
    this.registered = true;
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

  // `readings`: {temperature, humidity, batteryLevel, lowBattery}, any of
  // them undefined when not read; null for all when the sensor timed out.
  async update(readings) {
    const { temperature, humidity, batteryLevel, lowBattery } = readings ?? {};
    if (this.capabilities.temperature && temperature !== undefined) {
      await this.pushState("temperatureMeasurement", {
        measuredValue:
          temperature == null ? null : Math.round(temperature * 100),
      });
    }
    if (this.capabilities.humidity && humidity !== undefined) {
      await this.pushState("relativeHumidityMeasurement", {
        measuredValue:
          humidity == null
            ? null
            : Math.round(Math.min(100, Math.max(0, humidity)) * 100),
      });
    }
    if (
      this.capabilities.battery &&
      (batteryLevel !== undefined || lowBattery !== undefined)
    ) {
      const attributes = {};
      if (batteryLevel !== undefined) {
        // Half-percent units (0-200).
        attributes.batPercentRemaining =
          batteryLevel == null
            ? null
            : Math.round(Math.min(100, Math.max(0, batteryLevel)) * 2);
      }
      if (lowBattery !== undefined) {
        attributes.batChargeLevel = lowBattery
          ? BAT_CHARGE_LEVEL_WARNING
          : BAT_CHARGE_LEVEL_OK;
      }
      await this.pushState("powerSource", attributes);
    }
  }

  async pushState(cluster, attributes) {
    if (!this.registered || this.registrationFailed) {
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
