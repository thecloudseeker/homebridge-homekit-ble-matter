const path = require("path");
const {
  loadHap: defaultLoadHap,
  normalizeDeviceId,
  CATEGORY_SENSOR,
} = require("./hap");
const { BleSensor } = require("./bleSensor");
const { ConnectionQueue } = require("./connectionQueue");
const { DeviceStore } = require("./deviceStore");
const { MatterSensor, capabilitiesOf } = require("./matterSensor");

const PLUGIN_IDENTIFIER = "@thecloudseeker/homebridge-homekit-ble-matter";
const PLATFORM_NAME = "HomeKitBleMatter";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

class HomeKitBleMatterPlatform {
  constructor(log, config, api, { loadHap = defaultLoadHap } = {}) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.loadHap = loadHap;
    this.sensors = new Map();
    this.matterSensors = new Map();
    this.announced = new Set();

    this.devices = new Map();
    for (const device of asArray(this.config.devices)) {
      const deviceId = normalizeDeviceId(device?.deviceId);
      if (deviceId === "") {
        this.log.warn("Ignoring a device entry without deviceId.");
        continue;
      }
      this.devices.set(deviceId, {
        ...device,
        deviceId,
        name: device.name || deviceId,
        pollInterval: device.pollInterval ?? this.config.pollInterval,
        timeout: device.timeout ?? this.config.timeout,
      });
    }

    this.api.on("didFinishLaunching", () => {
      try {
        this.start();
      } catch (error) {
        this.log.error("Failed to start:", error);
      }
    });
    this.api.on("shutdown", () => this.shutdown());
  }

  // Matter only: there is nothing to restore on the HomeKit side.
  configureAccessory() {}

  // Drops cached Matter devices whose sensor is no longer configured -
  // Homebridge publishes every cached Matter accessory whether or not the
  // plugin registers it again.
  configureMatterAccessory(accessory) {
    const deviceId = normalizeDeviceId(accessory.context?.deviceId);
    if (this.devices.has(deviceId)) {
      return;
    }
    this.log.info(
      `Removing Matter device of a no longer configured sensor: ${accessory.displayName}`,
    );
    this.api.matter
      .unregisterPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [
        accessory,
      ])
      .catch((error) =>
        this.log.error("Failed to remove a Matter device:", error),
      );
  }

  // Same conditions as the CGDK2 plugin: Matter available, enabled for this
  // bridge, and Homebridge 2.4.0+ (composed device types re-register
  // correctly over their cached copy only from there).
  get matterEnabled() {
    return Boolean(
      this.api.isMatterAvailable?.() &&
      this.api.isMatterEnabled?.() &&
      this.api.versionGreaterOrEqual?.("2.4.0"),
    );
  }

  start() {
    if (!this.matterEnabled) {
      this.log.error(
        "Matter is not enabled for this bridge (or Homebridge is older than 2.4.0). This plugin only exposes devices over Matter: run it as a child bridge and turn on 'Enable Matter' in its bridge settings.",
      );
      return;
    }
    if (this.devices.size === 0) {
      this.log.info(
        "No devices configured yet. HomeKit Bluetooth devices found nearby are listed below with their DeviceID.",
      );
    }

    this.hap = this.loadHap();
    this.discovery = new this.hap.BLEDiscovery();
    const store = new DeviceStore(
      path.join(this.api.user.storagePath(), "homekit-ble-matter"),
    );
    const queue = new ConnectionQueue();

    for (const config of this.devices.values()) {
      const sensor = new BleSensor({
        config,
        log: this.log,
        hap: this.hap,
        discovery: this.discovery,
        store,
        queue,
        onReady: (database, info) =>
          this.ensureMatterSensor(config, database, info),
        onReadings: (readings) =>
          this.matterSensors.get(config.deviceId)?.update(readings),
      });
      this.sensors.set(config.deviceId, sensor);
      // Known from a previous run: register right away, so the Matter device
      // stays published (as unavailable) even if the sensor is out of range.
      if (sensor.cachedDatabase != null) {
        this.ensureMatterSensor(
          config,
          sensor.cachedDatabase,
          sensor.cachedInfo,
        );
      }
    }

    const route = (service) => {
      const deviceId = normalizeDeviceId(service.DeviceID);
      const sensor = this.sensors.get(deviceId);
      if (sensor != null) {
        sensor.handleAdvertisement(service);
      } else {
        this.announce(service, deviceId);
      }
    };
    this.discovery.on("serviceUp", route);
    this.discovery.on("serviceChanged", route);
    this.discovery.start();
    this.log.info(
      `Scanning for HomeKit Bluetooth devices (${this.devices.size} configured).`,
    );
  }

  // Lists each unconfigured HomeKit BLE device once, so users can find the
  // DeviceID to put in the config.
  announce(service, deviceId) {
    if (this.announced.has(deviceId)) {
      return;
    }
    this.announced.add(deviceId);
    const kind =
      service.ACID === CATEGORY_SENSOR ? "sensor" : `category ${service.ACID}`;
    this.log.info(
      `Found HomeKit Bluetooth ${kind} '${service.name || "unnamed"}' - DeviceID ${deviceId}, ${service.availableToPair ? "available to pair" : "paired with another controller"}. Add it under 'devices' to use it.`,
    );
  }

  ensureMatterSensor(config, database, info) {
    if (this.matterSensors.has(config.deviceId)) {
      return;
    }
    const capabilities = capabilitiesOf(database);
    if (!capabilities.temperature && !capabilities.humidity) {
      this.log.warn(
        `[${config.name}] Has no temperature or humidity reading; this plugin currently only supports temperature/humidity sensors.`,
      );
      return;
    }
    const matterSensor = new MatterSensor(this.api.matter, this.log, {
      deviceId: config.deviceId,
      name: config.name,
      capabilities,
      info,
    });
    this.matterSensors.set(config.deviceId, matterSensor);
    // Fired off: registration is fire-and-forget on Homebridge's side anyway.
    this.api.matter
      .registerPlatformAccessories(
        PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        matterSensor.toAccessories(),
      )
      .then(() => {
        matterSensor.markRegistered();
        matterSensor.syncNodeLabel();
        const what = Object.entries(capabilities)
          .filter(([, has]) => has)
          .map(([key]) => key)
          .join(", ");
        this.log.info(`[${config.name}] Registered Matter device (${what}).`);
      })
      .catch((error) => {
        matterSensor.markRegistrationFailed();
        this.log.error(
          `[${config.name}] Failed to register Matter device:`,
          error,
        );
      });
  }

  shutdown() {
    for (const sensor of this.sensors.values()) {
      sensor.stop();
    }
    try {
      this.discovery?.stop();
    } catch (error) {
      this.log.debug("Stopping Bluetooth discovery failed:", error);
    }
  }
}

module.exports = (homebridge, deps) => {
  if (deps != null) {
    // Tests: bind injected dependencies.
    return {
      HomeKitBleMatterPlatform: class extends HomeKitBleMatterPlatform {
        constructor(log, config, api) {
          super(log, config, api, deps);
        }
      },
      PLUGIN_IDENTIFIER,
      PLATFORM_NAME,
    };
  }
  return { HomeKitBleMatterPlatform, PLUGIN_IDENTIFIER, PLATFORM_NAME };
};
