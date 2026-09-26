// Everything this plugin needs from hap-controller, loaded lazily: requiring
// hap-controller initializes noble (Bluetooth) at module load, which must not
// happen just because Homebridge loaded the plugin - only once discovery
// actually starts. Tests pass their own implementation of this shape instead.
function loadHap() {
  const { BLEDiscovery, GattClient } = require("hap-controller");
  const {
    characteristicFromUuid,
  } = require("hap-controller/lib/model/characteristic");
  const { serviceFromUuid } = require("hap-controller/lib/model/service");
  return { BLEDiscovery, GattClient, characteristicFromUuid, serviceFromUuid };
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
  parseAccessoryDatabase,
  normalizeSetupCode,
  normalizeDeviceId,
  READINGS,
  INFO,
  CATEGORY_SENSOR,
};
