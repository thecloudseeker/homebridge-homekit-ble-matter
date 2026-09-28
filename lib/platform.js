const fs = require("fs");
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

// How long after startup a configured sensor may stay unseen before that's
// reported. HomeKit sensors advertise every few seconds.
const UNSEEN_AFTER = 2 * 60 * 1000;

// Right after a scan starts, noble's D-Bus binding re-reports every device in
// BlueZ's cache - with its last stored advertisement, present or not. Discover
// events this soon after a scan start are treated as such replays.
const CACHE_REPLAY_WINDOW = 2 * 1000;

// registerPlatformAccessories() resolves before Homebridge has finished the
// registration (it's fire-and-forget), and for a device type restored from
// cache Homebridge is still replacing the old endpoint at that moment
// (homebridge/homebridge#4018). State pushed right away lands on the closing
// endpoint and Homebridge logs "Failed to update state ... is closed" as an
// error. Waiting briefly avoids that; pushes in between are kept and sent
// when the wait is over (see markRegistered).
const REGISTRATION_SETTLE_MS = 3000;

// A cached Matter device whose sensor isn't in the config any more is only
// removed once it has been missing for this long: removing it also deletes
// its room, name and automations in the controller, and a half-saved config
// or a typo in a DeviceID shouldn't do that.
const REMOVAL_DELAY = 24 * 60 * 60 * 1000;

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
    // Unconfigured sensors available to pair, DeviceID → name: candidates
    // for a configured sensor that was factory-reset (see reportUnseen).
    this.pairable = new Map();

    this.devices = new Map();
    const matterIds = new Set();
    for (const device of asArray(this.config.devices)) {
      const deviceId = normalizeDeviceId(device?.deviceId);
      if (deviceId === "") {
        this.log.warn("Ignoring a device entry without deviceId.");
        continue;
      }
      const matterId = normalizeDeviceId(device.matterId) || deviceId;
      if (this.devices.has(deviceId) || matterIds.has(matterId)) {
        this.log.warn(
          `Ignoring a second device entry for DeviceID/Matter ID ${deviceId === matterId ? deviceId : `${deviceId}/${matterId}`}.`,
        );
        continue;
      }
      matterIds.add(matterId);
      this.devices.set(deviceId, {
        ...device,
        deviceId,
        matterId,
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
  // plugin registers it again. Carefully (see REMOVAL_DELAY): never while no
  // device is configured at all, and otherwise only after a day.
  configureMatterAccessory(accessory) {
    const matterId = normalizeDeviceId(
      accessory.context?.matterId || accessory.context?.deviceId,
    );
    const pending = this.pendingRemovals();
    const configured = [...this.devices.values()].some(
      (device) => device.matterId === matterId,
    );
    if (configured) {
      if (pending[matterId] != null) {
        delete pending[matterId];
        this.savePendingRemovals(pending);
      }
      return;
    }
    if (this.devices.size === 0) {
      this.log.warn(
        `No valid devices are configured; keeping the Matter device '${accessory.displayName}' from before. Remove it in your Matter controller if it's no longer wanted.`,
      );
      return;
    }
    const since = pending[matterId] ?? Date.now();
    if (Date.now() - since < REMOVAL_DELAY) {
      if (pending[matterId] == null) {
        pending[matterId] = since;
        this.savePendingRemovals(pending);
      }
      this.log.warn(
        `The Matter device '${accessory.displayName}' (${matterId}) is no longer in the config. It's kept for now and removed with the first restart after ${new Date(since + REMOVAL_DELAY).toLocaleString()}. If it should stay, add it back - after a factory reset, with its old DeviceID as matterId.`,
      );
      return;
    }
    delete pending[matterId];
    this.savePendingRemovals(pending);
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

  // Matter IDs of cached devices found missing from the config, and since
  // when: {matterId: timestamp}.
  get pendingRemovalsFile() {
    return path.join(
      this.api.user.storagePath(),
      "homekit-ble-matter",
      "pending-removals.json",
    );
  }

  pendingRemovals() {
    if (this.pendingRemovalsCache == null) {
      try {
        this.pendingRemovalsCache = JSON.parse(
          fs.readFileSync(this.pendingRemovalsFile, "utf8"),
        );
      } catch {
        this.pendingRemovalsCache = {};
      }
    }
    return this.pendingRemovalsCache;
  }

  savePendingRemovals(pending) {
    this.pendingRemovalsCache = pending;
    try {
      fs.mkdirSync(path.dirname(this.pendingRemovalsFile), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(this.pendingRemovalsFile, JSON.stringify(pending));
    } catch (error) {
      this.log.debug("Could not save pending Matter device removals:", error);
    }
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

    const binding = this.config.bluetoothBinding === "hci" ? "hci" : "dbus";
    this.hap = this.loadHap({ binding });
    this.log.debug(`Using Bluetooth via ${binding}.`);
    this.hap.noble?.on?.("stateChange", (state) => {
      if (state === "poweredOn") {
        this.log.debug("Bluetooth adapter ready.");
      } else if (state === "unsupported" || state === "unauthorized") {
        this.log.error(
          binding === "dbus"
            ? `Bluetooth via BlueZ (D-Bus) is not available (${state}). Check that the bluetooth service is running and the Homebridge user may use it (member of the 'bluetooth' group), or set Bluetooth Access to 'Raw HCI'.`
            : `Bluetooth via raw HCI is not available (${state}). Homebridge needs the network capabilities for this, or set Bluetooth Access to 'BlueZ (D-Bus)'.`,
        );
      } else {
        this.log.warn(`Bluetooth adapter state: ${state}.`);
      }
    });
    this.hap.noble?.on?.("warning", (message) =>
      this.log.debug(`Bluetooth: ${message}`),
    );
    // Live-advertisement tracking (see noteDiscover). Registered before
    // hap-controller's discovery, so for each discover event this runs first.
    this.trackPresence = typeof this.hap.noble?.on === "function";
    this.seenAt = new Map();
    this.scanStartedAt = 0;
    if (this.trackPresence) {
      this.hap.noble.on("scanStart", () => {
        this.scanStartedAt = Date.now();
      });
      this.hap.noble.on("discover", (peripheral) =>
        this.noteDiscover(peripheral),
      );
    }
    this.discovery = new this.hap.BLEDiscovery();
    const store = new DeviceStore(
      path.join(this.api.user.storagePath(), "homekit-ble-matter"),
    );
    const queue = new ConnectionQueue({
      pause: () => this.pauseScanning(),
      resume: () => this.resumeScanning(),
    });

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
        onReachable: (reachable) =>
          this.matterSensors.get(config.deviceId)?.setReachable(reachable),
        lastSeenAt: (peripheral) => this.lastSeenAt(peripheral),
        pairableCandidates: () => this.pairableCandidates(),
      });
      this.sensors.set(config.deviceId, sensor);
      // Known from a previous run: register right away, so the Matter device
      // stays published (as unavailable) even if the sensor is out of range.
      // Not without readings: its values would start unknown (see
      // BleSensor.doPrepare), so it's registered with the first read.
      if (sensor.cachedDatabase != null && sensor.cachedReadings != null) {
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
    this.unseenTimer = setTimeout(() => this.reportUnseen(), UNSEEN_AFTER);
    this.log.info(
      `Scanning for HomeKit Bluetooth devices (${this.devices.size} configured).`,
    );
  }

  noteDiscover(peripheral) {
    if (Date.now() - this.scanStartedAt < CACHE_REPLAY_WINDOW) {
      return;
    }
    this.seenAt.set(peripheral.id, Date.now());
    for (const sensor of this.sensors.values()) {
      if (sensor.advertisement?.peripheral?.id === peripheral.id) {
        sensor.handlePresence();
      }
    }
  }

  lastSeenAt(peripheral) {
    if (!this.trackPresence) {
      return Date.now();
    }
    return this.seenAt.get(peripheral?.id) ?? null;
  }

  // Stops discovery for the duration of a connection (see ConnectionQueue).
  // Through BLEDiscovery.stop(), not noble directly: hap-controller restarts
  // scanning on every scanStop while its discovery is enabled. Waits for the
  // scan to actually stop (at most 3s) before connecting.
  async pauseScanning() {
    const noble = this.hap.noble;
    // Removed again in every case: if scanning was already stopped, no
    // scanStop comes, and a leftover listener per connection would add up.
    let onStop = null;
    let timer = null;
    const stopped =
      noble?.once != null
        ? new Promise((resolve) => {
            onStop = resolve;
            timer = setTimeout(resolve, 3000);
            noble.once("scanStop", onStop);
          })
        : Promise.resolve();
    const cleanUp = () => {
      clearTimeout(timer);
      if (onStop != null) {
        noble.off?.("scanStop", onStop);
      }
    };
    try {
      this.discovery.stop();
    } catch (error) {
      cleanUp();
      this.log.debug("Pausing Bluetooth discovery failed:", error);
      return;
    }
    await stopped;
    cleanUp();
  }

  resumeScanning() {
    if (this.shuttingDown) {
      return;
    }
    try {
      this.discovery.start();
    } catch (error) {
      this.log.debug("Resuming Bluetooth discovery failed:", error);
    }
  }

  // Lists each unconfigured HomeKit BLE device once, so users can find the
  // DeviceID to put in the config.
  announce(service, deviceId) {
    if (service.availableToPair) {
      this.pairable.set(deviceId, service.name || "unnamed");
    } else {
      this.pairable.delete(deviceId);
    }
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

  // HomeKit gives an accessory a new random DeviceID on every factory reset,
  // so a reset sensor stops matching its config and shows up as a new,
  // unconfigured one. Point that out instead of leaving users to guess.
  pairableCandidates() {
    return [...this.pairable]
      .map(([deviceId, name]) => `${deviceId} ('${name}')`)
      .join(", ");
  }

  reportUnseen() {
    const candidates = this.pairableCandidates();
    for (const [deviceId, sensor] of this.sensors) {
      if (sensor.advertisement != null) {
        continue;
      }
      this.log.warn(
        `[${sensor.config.name}] Not seen since startup (DeviceID ${deviceId}). Check that it's in range and has battery.` +
          (candidates === ""
            ? ""
            : ` A factory reset gives a HomeKit device a new DeviceID: if it was reset, replace ${deviceId} in the config with the new one, likely ${candidates}.`),
      );
    }
  }

  ensureMatterSensor(config, database, info) {
    const capabilities = capabilitiesOf(database);
    const existing = this.matterSensors.get(config.deviceId);
    if (existing != null) {
      if (sameCapabilities(existing.capabilities, capabilities)) {
        return;
      }
      // The sensor's configuration changed (e.g. after a firmware update) and
      // it now reports different readings: the Matter device needs other
      // clusters, which only a new registration gives it.
      this.log.info(
        `[${config.name}] Readings the device reports changed; re-registering its Matter device.`,
      );
      this.matterSensors.delete(config.deviceId);
      this.api.matter
        .unregisterPlatformAccessories(
          PLUGIN_IDENTIFIER,
          PLATFORM_NAME,
          existing.toAccessories(),
        )
        .catch((error) =>
          this.log.debug(
            `[${config.name}] Unregistering the old Matter device failed:`,
            error,
          ),
        )
        .then(() => {
          if (!this.shuttingDown) {
            this.ensureMatterSensor(config, database, info);
          }
        });
      return;
    }
    if (!capabilities.temperature && !capabilities.humidity) {
      this.log.warn(
        `[${config.name}] Has no temperature or humidity reading; this plugin currently only supports temperature/humidity sensors.`,
      );
      return;
    }
    const sensor = this.sensors.get(config.deviceId);
    const matterSensor = new MatterSensor(this.api.matter, this.log, {
      deviceId: config.deviceId,
      matterId: config.matterId,
      name: config.name,
      capabilities,
      info,
      readings: sensor?.cachedReadings,
    });
    this.matterSensors.set(config.deviceId, matterSensor);
    if (sensor?.timedOut) {
      // Timed out before its Matter device existed; sent once registered.
      matterSensor.setReachable(false);
    }
    // Fired off: registration is fire-and-forget on Homebridge's side anyway.
    this.api.matter
      .registerPlatformAccessories(
        PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        matterSensor.toAccessories(),
      )
      .then(() => {
        setTimeout(() => {
          if (!this.shuttingDown) {
            matterSensor.markRegistered();
            matterSensor.syncNodeLabel();
          }
        }, REGISTRATION_SETTLE_MS).unref?.();
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
    this.shuttingDown = true;
    clearTimeout(this.unseenTimer);
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

function sameCapabilities(a, b) {
  return (
    a.temperature === b.temperature &&
    a.humidity === b.humidity &&
    a.battery === b.battery
  );
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
