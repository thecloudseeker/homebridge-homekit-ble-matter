const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createFakeMatter } = require("./helpers/fakeMatter");
const {
  createFakeDevice,
  createFakeHap,
  advertisement,
  createRecordingLog,
  flush,
} = require("./helpers/fakeHap");

class FakeAPI extends EventEmitter {
  constructor({ matterEnabled = true, storagePath }) {
    super();
    this.matter = createFakeMatter();
    this.isMatterAvailable = () => true;
    this.isMatterEnabled = () => matterEnabled;
    this.versionGreaterOrEqual = () => true;
    this.user = { storagePath: () => storagePath };
  }
}

function setup(
  t,
  {
    config,
    matterEnabled = true,
    device = createFakeDevice(),
    withNoble = false,
  } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hkblematter-"));
  t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }));
  const hap = createFakeHap(device, { withNoble });
  const { HomeKitBleMatterPlatform } = require("../lib/platform")(
    {},
    {
      loadHap: () => hap,
    },
  );
  const api = new FakeAPI({ matterEnabled, storagePath });
  const { log, lines } = createRecordingLog();
  const platform = new HomeKitBleMatterPlatform(
    log,
    config ?? {
      devices: [
        {
          deviceId: "41:21:14:e5:c2:25",
          name: "Schlafzimmer",
          setupCode: "12884842",
        },
      ],
    },
    api,
  );
  t.after(() => api.emit("shutdown"));
  return { platform, api, lines, device, storagePath };
}

test("without Matter enabled for the bridge it explains why and does not scan", (t) => {
  const { platform, api, lines } = setup(t, { matterEnabled: false });
  api.emit("didFinishLaunching");

  assert.equal(platform.discovery, undefined);
  assert.ok(lines.error.some((l) => l.includes("Enable Matter")));
});

test("end to end: advertisement → pairing → one Matter device with live readings", async (t) => {
  const { platform, api, device, lines } = setup(t);
  api.emit("didFinishLaunching");
  assert.equal(platform.discovery.started, true);

  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  assert.equal(api.matter.accessories.size, 1);
  const [registered] = api.matter.accessories.values();
  assert.equal(registered.displayName, "Schlafzimmer");
  assert.equal(registered.model, "CGG1H");
  assert.ok(registered.deviceType.behaviors.relativeHumidityMeasurement);
  assert.ok(registered.clusters.powerSource);
  assert.ok(
    lines.info.some((l) =>
      l.includes("Registered Matter device (temperature, humidity, battery)"),
    ),
  );

  // The first read happens as soon as the structure is known, possibly
  // before the fire-and-forget registration resolved; the next change
  // signal (after the five-minute gap) must reach Matter.
  t.mock.timers.tick(5 * 60 * 1000 + 1000);
  device.values[257] = 23.1;
  platform.discovery.emit("serviceChanged", advertisement(device, { GSN: 2 }));
  await flush();

  const temps = api.matter.stateUpdates
    .filter((u) => u.cluster === "temperatureMeasurement")
    .map((u) => u.attributes.measuredValue);
  assert.equal(temps.at(-1), 2310);
});

test("the pairing survives a restart: the second run neither pairs nor re-reads the structure, and registers before the sensor is seen", async (t) => {
  const first = setup(t);
  first.api.emit("didFinishLaunching");
  first.platform.discovery.emit("serviceUp", advertisement(first.device));
  await flush();
  first.api.emit("shutdown");

  // Second run, same storage directory and the same (now paired) device.
  const { HomeKitBleMatterPlatform } = require("../lib/platform")(
    {},
    {
      loadHap: () => createFakeHap(first.device),
    },
  );
  const api = new FakeAPI({ storagePath: first.storagePath });
  const platform = new HomeKitBleMatterPlatform(
    createRecordingLog().log,
    { devices: [{ deviceId: "41:21:14:E5:C2:25", name: "Schlafzimmer" }] },
    api,
  );
  t.after(() => api.emit("shutdown"));
  api.emit("didFinishLaunching");
  await flush();

  assert.equal(
    api.matter.accessories.size,
    1,
    "registered from the stored structure",
  );
  // ...with the last readings, not unknown values (Dirigera: 100 °C).
  const [registered] = api.matter.accessories.values();
  assert.equal(registered.clusters.temperatureMeasurement.measuredValue, 2240);

  first.device.calls.length = 0;
  platform.discovery.emit("serviceUp", advertisement(first.device));
  await flush();
  assert.deepEqual(
    first.device.calls.filter((c) => !c.startsWith("scan:")),
    ["read:257,145,59,61"],
  );
});

test("unconfigured HomeKit BLE devices are announced once with their DeviceID", (t) => {
  const { platform, api, lines } = setup(t, { config: {} });
  api.emit("didFinishLaunching");

  const stranger = createFakeDevice({ deviceId: "AA:BB:CC:DD:EE:FF" });
  platform.discovery.emit("serviceUp", advertisement(stranger));
  platform.discovery.emit(
    "serviceChanged",
    advertisement(stranger, { GSN: 5 }),
  );

  const found = lines.info.filter((l) => l.includes("Found HomeKit Bluetooth"));
  assert.equal(found.length, 1);
  assert.ok(
    found[0].includes(
      "sensor 'Qingping Temp RH H' - DeviceID AA:BB:CC:DD:EE:FF, available to pair",
    ),
  );
});

test("a cached Matter device of a sensor that is no longer configured is removed after a day, not right away", (t) => {
  const { platform, api, lines } = setup(t);
  const stale = {
    UUID: "u1",
    displayName: "Old",
    context: { deviceId: "AA:BB:CC:DD:EE:FF" },
  };
  const kept = {
    UUID: "u2",
    displayName: "Kept",
    context: { deviceId: "41:21:14:e5:c2:25" },
  };
  api.matter.accessories.set(stale.UUID, stale);
  api.matter.accessories.set(kept.UUID, kept);

  platform.configureMatterAccessory(stale);
  platform.configureMatterAccessory(kept);
  assert.deepEqual([...api.matter.accessories.keys()], ["u1", "u2"]);
  assert.ok(lines.warn.some((l) => l.includes("no longer in the config")));

  // A restart a day later: still missing, so it goes.
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  platform.pendingRemovalsCache = null;
  platform.configureMatterAccessory(stale);
  platform.configureMatterAccessory(kept);
  assert.deepEqual([...api.matter.accessories.keys()], ["u2"]);
});

test("a device that is back in the config before the day is up is kept", (t) => {
  const { platform, api } = setup(t);
  const device = {
    UUID: "u1",
    displayName: "Bedroom",
    context: { deviceId: "AA:BB:CC:DD:EE:FF" },
  };
  api.matter.accessories.set(device.UUID, device);
  platform.configureMatterAccessory(device);

  // Fixed the config: the device is configured again.
  platform.devices.set("AA:BB:CC:DD:EE:FF", {
    deviceId: "AA:BB:CC:DD:EE:FF",
    matterId: "AA:BB:CC:DD:EE:FF",
  });
  platform.configureMatterAccessory(device);
  assert.deepEqual(platform.pendingRemovals(), {});

  // Removed from the config later: the day starts over.
  platform.devices.delete("AA:BB:CC:DD:EE:FF");
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  platform.configureMatterAccessory(device);
  assert.ok(api.matter.accessories.has("u1"));
});

test("with no valid device configured at all, no cached Matter device is removed", (t) => {
  const { platform, api, lines } = setup(t, { config: { devices: [] } });
  const device = {
    UUID: "u1",
    displayName: "Bedroom",
    context: { deviceId: "41:21:14:E5:C2:25" },
  };
  api.matter.accessories.set(device.UUID, device);
  t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
  platform.configureMatterAccessory(device);

  assert.ok(api.matter.accessories.has("u1"));
  assert.deepEqual(platform.pendingRemovals(), {});
  assert.ok(lines.warn.some((l) => l.includes("No valid devices")));
});

test("after a factory reset, the old DeviceID as matterId keeps the same Matter device", async (t) => {
  const device = createFakeDevice({ deviceId: "AA:BB:CC:DD:EE:FF" });
  const { platform, api } = setup(t, {
    device,
    config: {
      devices: [
        {
          deviceId: "AA:BB:CC:DD:EE:FF",
          matterId: "41:21:14:e5:c2:25",
          name: "Schlafzimmer",
          setupCode: "12884842",
        },
      ],
    },
  });
  // The Matter device from before the reset, under the old DeviceID.
  const before = {
    UUID: "matter-uuid:homebridge-homekit-ble-matter:41:21:14:E5:C2:25",
    displayName: "Schlafzimmer",
    context: { deviceId: "41:21:14:E5:C2:25" },
  };
  api.matter.accessories.set(before.UUID, before);
  platform.configureMatterAccessory(before);
  assert.ok(api.matter.accessories.has(before.UUID), "not removed");

  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  assert.deepEqual([...api.matter.accessories.keys()], [before.UUID]);
  assert.equal(
    api.matter.accessories.get(before.UUID).context.deviceId,
    "AA:BB:CC:DD:EE:FF",
  );
});

test("a device entry without deviceId is ignored with a warning", (t) => {
  const { platform, lines } = setup(t, {
    config: { devices: [{ name: "x" }] },
  });
  assert.equal(platform.devices.size, 0);
  assert.ok(lines.warn.some((l) => l.includes("without deviceId")));
});

test("shutdown stops discovery", (t) => {
  const { platform, api } = setup(t);
  api.emit("didFinishLaunching");
  api.emit("shutdown");
  assert.equal(platform.discovery.stopped, true);
});

test("a configured sensor unseen after two minutes is reported, naming an unconfigured pairable sensor as its likely new DeviceID", async (t) => {
  const { platform, api, lines } = setup(t);
  api.emit("didFinishLaunching");
  const reset = createFakeDevice({ deviceId: "E4:DB:61:5C:0E:27" });
  platform.discovery.emit("serviceUp", advertisement(reset));

  t.mock.timers.tick(2 * 60 * 1000);

  const warning = lines.warn.find((l) => l.includes("Not seen since startup"));
  assert.ok(warning.includes("DeviceID 41:21:14:E5:C2:25"));
  assert.ok(
    warning.includes("likely E4:DB:61:5C:0E:27 ('Qingping Temp RH H')"),
  );
});

test("without a pairable candidate the unseen warning gives no DeviceID hint", (t) => {
  const { api, lines } = setup(t);
  api.emit("didFinishLaunching");

  t.mock.timers.tick(2 * 60 * 1000);

  const warning = lines.warn.find((l) => l.includes("Not seen since startup"));
  assert.ok(warning);
  assert.equal(warning.includes("factory reset"), false);
});

test("a configured sensor that was seen is not reported as unseen", async (t) => {
  const { platform, api, lines, device } = setup(t);
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  t.mock.timers.tick(2 * 60 * 1000);

  assert.equal(
    lines.warn.some((l) => l.includes("Not seen since startup")),
    false,
  );
});

test("scanning is paused for every connection and resumed afterwards, as BlueZ aborts connections while discovery runs", async (t) => {
  const { platform, api, device } = setup(t);
  api.emit("didFinishLaunching");
  // Like BlueZ: any connection attempt while scanning fails.
  device.scanningDuringConnect = () => platform.discovery.scanning;

  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  assert.equal(device.paired, true, "pairing must not run while scanning");
  assert.equal(api.matter.accessories.size, 1);
  assert.equal(platform.discovery.scanning, true, "scanning resumes");
  const calls = device.calls.filter((c) => c !== "getAccessories");
  const pairAt = calls.indexOf("pairSetup");
  assert.equal(calls[pairAt - 1], "scan:stop");
});

test("scanning resumes even when a connection fails", async (t) => {
  const device = createFakeDevice({ failNextPairs: 1 });
  const { platform, api } = setup(t, { device });
  api.emit("didFinishLaunching");

  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  assert.equal(device.paired, false);
  assert.equal(platform.discovery.scanning, true);
});

test("after shutdown, a finishing connection does not restart scanning", async (t) => {
  const { platform, api, device } = setup(t);
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  api.emit("shutdown");
  await flush();

  assert.equal(platform.discovery.scanning, false);
});

test("cache replays right after a scan start don't trigger pairing; the first live advertisement does", async (t) => {
  const { platform, api, device } = setup(t, { withNoble: true });
  api.emit("didFinishLaunching");
  const noble = platform.hap.noble;
  const adv = advertisement(device);

  // The replay burst: scan starts, BlueZ's cached copy is reported at once.
  noble.emit("scanStart");
  noble.emit("discover", adv.peripheral);
  platform.discovery.emit("serviceUp", adv);
  await flush();
  assert.equal(device.calls.includes("pairSetup"), false);

  // Seconds later the sensor is actually heard.
  t.mock.timers.tick(3000);
  noble.emit("discover", adv.peripheral);
  await flush();
  assert.equal(device.paired, true);
  assert.equal(api.matter.accessories.size, 1);
});

test("after registration, state is only sent once Homebridge had time to finish replacing the device", async (t) => {
  const { platform, api, device } = setup(t);
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  // Registered and already read once, but nothing sent yet.
  assert.equal(api.matter.accessories.size, 1);
  assert.equal(api.matter.stateUpdates.length, 0);

  t.mock.timers.tick(3000);
  await flush();

  const clusters = api.matter.stateUpdates.map((u) => u.cluster);
  assert.ok(
    clusters.includes("temperatureMeasurement"),
    "the held reading is sent",
  );
  assert.ok(
    clusters.includes("bridgedDeviceBasicInformation"),
    "then the name",
  );
});

test("pausing leaves no scanStop listener behind, even when no scanStop comes", async (t) => {
  const { platform, api } = setup(t, { withNoble: true });
  api.emit("didFinishLaunching");
  const noble = platform.hap.noble;
  const before = noble.listenerCount("scanStop");

  // Scanning already stopped (e.g. after a failed resume): stop() emits
  // nothing, so only the 3-second fallback ends the wait.
  platform.discovery.stop = () => {};
  for (let i = 0; i < 20; i += 1) {
    const paused = platform.pauseScanning();
    t.mock.timers.tick(3000);
    await paused;
  }
  assert.equal(noble.listenerCount("scanStop"), before);

  platform.discovery.stop = () => {
    throw new Error("adapter gone");
  };
  await platform.pauseScanning();
  assert.equal(noble.listenerCount("scanStop"), before);
});

test("when the readings a device reports change, its Matter device is re-registered with the new clusters", async (t) => {
  const { platform, api, device, lines } = setup(t);
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();
  const [before] = api.matter.accessories.values();
  assert.ok(before.clusters.relativeHumidityMeasurement);

  const [config] = platform.devices.values();
  const sensor = platform.sensors.get(config.deviceId);
  const { humidity, ...withoutHumidity } = sensor.cachedDatabase;
  assert.ok(humidity);
  platform.ensureMatterSensor(config, withoutHumidity, sensor.cachedInfo);
  await flush();

  assert.equal(api.matter.accessories.size, 1);
  const [after] = api.matter.accessories.values();
  assert.equal(after.clusters.relativeHumidityMeasurement, undefined);
  assert.ok(after.clusters.temperatureMeasurement);
  assert.ok(lines.info.some((l) => l.includes("re-registering")));
});

test("the same readings don't re-register the Matter device", async (t) => {
  const { platform, api, device } = setup(t);
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();
  const [config] = platform.devices.values();
  const existing = platform.matterSensors.get(config.deviceId);
  const sensor = platform.sensors.get(config.deviceId);

  platform.ensureMatterSensor(config, sensor.cachedDatabase, sensor.cachedInfo);
  await flush();
  assert.equal(platform.matterSensors.get(config.deviceId), existing);
});
