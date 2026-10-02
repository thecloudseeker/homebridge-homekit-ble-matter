const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { createFakeMatter } = require("./helpers/fakeMatter");
const {
  hapDatabase,
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
    configureBroadcasts,
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
      configureBroadcasts,
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

test("end to end: a door sensor with a light sensor becomes a contact device with a light part", async (t) => {
  const device = createFakeDevice({
    database: hapDatabase([
      [
        "sensor.contact",
        [
          ["contact-state", 11, "uint8"],
          ["status-lo-batt", 12, "uint8"],
        ],
      ],
      ["sensor.light", [["light-level.current", 21, "float"]]],
      ["battery", [["battery-level", 31, "uint8"]]],
    ]),
    values: { 4: "Acme", 5: "Door+Light", 11: 1, 12: 0, 21: 250, 31: 77 },
  });
  const { platform, api, lines } = setup(t, { device });
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  assert.equal(api.matter.accessories.size, 1);
  const [accessory] = api.matter.accessories.values();
  assert.equal(accessory.deviceType.name, "ContactSensor");
  assert.equal(accessory.clusters.booleanState.stateValue, false, "open");
  assert.equal(accessory.clusters.powerSource.batPercentRemaining, 154);
  assert.deepEqual(
    accessory.parts.map((part) => [part.id, part.deviceType.name]),
    [["light", "LightSensor"]],
  );
  assert.ok(
    lines.info.some((l) =>
      l.includes("Registered Matter device (contact, battery + light level)"),
    ),
  );

  // The door closes; the next read pushes it, and the light to its part.
  device.values[11] = 0;
  device.values[21] = 1000;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  t.mock.timers.tick(3000);
  await flush();
  const last = (cluster, partId) =>
    api.matter.stateUpdates
      .filter((u) => u.cluster === cluster && u.partId === partId)
      .at(-1)?.attributes;
  assert.deepEqual(last("booleanState", undefined), { stateValue: true });
  assert.deepEqual(last("illuminanceMeasurement", "light"), {
    measuredValue: 30001,
  });
});

test("a device reporting nothing exposable is explained, not registered", async (t) => {
  const device = createFakeDevice({
    database: hapDatabase([["battery", [["battery-level", 31, "uint8"]]]]),
    values: { 4: "Acme", 5: "Remote", 31: 50 },
  });
  const { platform, api, lines } = setup(t, { device });
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush();

  assert.equal(api.matter.accessories.size, 0);
  assert.ok(
    lines.warn.some((l) =>
      l.includes("Reports nothing this plugin can expose"),
    ),
  );
});

test("fast updates: after setup, an encrypted notification is applied the moment it arrives", async (t) => {
  const crypto = require("crypto");
  const { encryptNotification } = require("../lib/broadcast");
  const device = createFakeDevice({
    database: hapDatabase([
      [
        "sensor.contact",
        [["contact-state", 11, "uint8", ["pr", "ev", "ev-broadcast"]]],
      ],
      ["sensor.light", [["light-level.current", 21, "float", ["pr"]]]],
    ]),
    values: { 4: "Acme", 5: "Door", 11: 0, 21: 5 },
  });
  const key = crypto.randomBytes(32);
  const setups = [];
  const { platform, api, lines } = setup(t, {
    device,
    withNoble: true,
    config: {
      fastUpdates: true,
      devices: [
        {
          deviceId: "41:21:14:e5:c2:25",
          name: "Front door",
          setupCode: "12884842",
        },
      ],
    },
    configureBroadcasts: async (client, peripheral, targets) => {
      setups.push(targets.map((target) => target.key));
      return {
        key,
        advertisingId: null,
        gsn: 40,
        configNumber: 1,
        enabled: [11],
      };
    },
  });
  api.emit("didFinishLaunching");
  const noble = platform.hap.noble;
  const adv = advertisement(device, { GSN: 40 });
  t.mock.timers.tick(3000);
  noble.emit("discover", adv.peripheral);
  platform.discovery.emit("serviceUp", adv);
  await flush(10);

  assert.deepEqual(
    setups,
    [["contact"]],
    "only broadcast-capable characteristics",
  );
  assert.ok(lines.info.some((l) => l.includes("Fast updates on: contact")));
  t.mock.timers.tick(3000);
  await flush();

  // The door opens: the device broadcasts contact-state 1 with GSN 41.
  const advertisingId = Buffer.from("412114E5C225", "hex");
  const value = Buffer.alloc(8);
  value.writeUInt8(1, 0);
  const updatesBefore = api.matter.stateUpdates.length;
  adv.peripheral.advertisement = {
    manufacturerData: encryptNotification(key, advertisingId, 41, 11, value),
  };
  noble.emit("discover", adv.peripheral);
  await flush();

  const pushed = api.matter.stateUpdates.slice(updatesBefore);
  assert.deepEqual(pushed, [
    {
      uuid: [...api.matter.accessories.keys()][0],
      cluster: "booleanState",
      attributes: { stateValue: false },
      partId: undefined,
    },
  ]);

  // Repeated for a few seconds: applied once.
  noble.emit("discover", adv.peripheral);
  await flush();
  assert.equal(api.matter.stateUpdates.length, updatesBefore + 1);

  // The plain advertisement's GSN catches up: no extra read for it.
  const readsBefore = device.calls.filter((c) => c.startsWith("read:")).length;
  platform.discovery.emit("serviceChanged", advertisement(device, { GSN: 41 }));
  t.mock.timers.tick(5 * 60 * 1000);
  await flush();
  assert.equal(
    device.calls.filter((c) => c.startsWith("read:")).length,
    readsBefore,
  );
});

test("fast updates: another device's notification, or one with a wrong key, is ignored", async (t) => {
  const crypto = require("crypto");
  const { encryptNotification } = require("../lib/broadcast");
  const device = createFakeDevice({
    database: hapDatabase([
      [
        "sensor.motion",
        [["motion-detected", 11, "bool", ["pr", "ev-broadcast"]]],
      ],
    ]),
    values: { 4: "Acme", 5: "Motion", 11: 0 },
  });
  const key = crypto.randomBytes(32);
  const { platform, api } = setup(t, {
    device,
    withNoble: true,
    config: {
      fastUpdates: true,
      devices: [
        { deviceId: "41:21:14:e5:c2:25", name: "Hall", setupCode: "12884842" },
      ],
    },
    configureBroadcasts: async () => ({
      key,
      advertisingId: null,
      gsn: 7,
      configNumber: 1,
      enabled: [11],
    }),
  });
  api.emit("didFinishLaunching");
  const noble = platform.hap.noble;
  const adv = advertisement(device, { GSN: 7 });
  t.mock.timers.tick(3000);
  noble.emit("discover", adv.peripheral);
  platform.discovery.emit("serviceUp", adv);
  await flush(10);
  t.mock.timers.tick(3000);
  await flush();
  const before = api.matter.stateUpdates.length;

  const value = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);
  for (const data of [
    encryptNotification(
      crypto.randomBytes(32),
      Buffer.from("412114E5C225", "hex"),
      8,
      11,
      value,
    ),
    encryptNotification(key, Buffer.from("AABBCCDDEEFF", "hex"), 8, 11, value),
  ]) {
    adv.peripheral.advertisement = { manufacturerData: data };
    noble.emit("discover", adv.peripheral);
  }
  await flush();
  assert.equal(api.matter.stateUpdates.length, before);
});

test("fast updates: a device without broadcast support says so once and keeps polling", async (t) => {
  const setups = [];
  const { platform, api, device, lines } = setup(t, {
    config: {
      fastUpdates: true,
      devices: [
        {
          deviceId: "41:21:14:e5:c2:25",
          name: "Schlafzimmer",
          setupCode: "12884842",
        },
      ],
    },
    configureBroadcasts: async () => {
      setups.push(1);
    },
  });
  api.emit("didFinishLaunching");
  platform.discovery.emit("serviceUp", advertisement(device));
  await flush(10);
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(10);

  assert.equal(setups.length, 0);
  assert.equal(
    lines.info.filter((l) => l.includes("Doesn't support fast updates")).length,
    1,
  );
});

// Three different sensors, as one home might have them.
function threeSensors() {
  const climate = createFakeDevice();
  const door = createFakeDevice({
    deviceId: "AA:AA:AA:AA:AA:01",
    peripheralId: "aaaaaaaaaa01",
    setupCode: "111-22-333",
    database: hapDatabase([
      ["sensor.contact", [["contact-state", 11, "uint8"]]],
      ["battery", [["battery-level", 31, "uint8"]]],
    ]),
    values: { 4: "Acme", 5: "Door", 11: 0, 31: 90 },
  });
  const hallway = createFakeDevice({
    deviceId: "AA:AA:AA:AA:AA:02",
    peripheralId: "aaaaaaaaaa02",
    setupCode: "444-55-666",
    database: hapDatabase([
      ["sensor.motion", [["motion-detected", 11, "bool"]]],
      ["sensor.light", [["light-level.current", 21, "float"]]],
    ]),
    values: { 4: "Acme", 5: "Motion", 11: false, 21: 100 },
  });
  const config = {
    devices: [
      { deviceId: climate.deviceId, name: "Bedroom", setupCode: "12884842" },
      { deviceId: door.deviceId, name: "Front door", setupCode: "11122333" },
      { deviceId: hallway.deviceId, name: "Hallway", setupCode: "44455666" },
    ],
  };
  return { climate, door, hallway, config };
}

// The latest state pushed to the Matter device called `name`.
function lastState(api, name, cluster, partId, attribute) {
  const accessory = [...api.matter.accessories.values()].find(
    (candidate) => candidate.displayName === name,
  );
  return api.matter.stateUpdates
    .filter(
      (u) =>
        u.uuid === accessory.UUID &&
        u.cluster === cluster &&
        u.partId === partId &&
        (attribute == null || attribute in u.attributes),
    )
    .at(-1)?.attributes;
}

// Whether the Matter device called `name` was last reported as reachable;
// undefined if nothing was ever reported.
function reachable(api, name) {
  return lastState(
    api,
    name,
    "bridgedDeviceBasicInformation",
    undefined,
    "reachable",
  )?.reachable;
}

test("several sensors: each is paired with its own code and becomes its own Matter device, one connection at a time", async (t) => {
  const { climate, door, hallway, config } = threeSensors();
  const { platform, api } = setup(t, {
    device: [climate, door, hallway],
    config,
  });
  api.emit("didFinishLaunching");
  for (const device of [climate, door, hallway]) {
    platform.discovery.emit("serviceUp", advertisement(device));
  }
  await flush(30);

  assert.deepEqual(
    [climate.paired, door.paired, hallway.paired],
    [true, true, true],
  );
  assert.deepEqual(
    [...api.matter.accessories.values()]
      .map((a) => [a.displayName, a.deviceType.name])
      .sort(),
    [
      ["Bedroom", "TemperatureSensor"],
      ["Front door", "ContactSensor"],
      ["Hallway", "OccupancySensor"],
    ],
  );
  assert.equal(platform.hap.stats.maxOpen, 1);

  // Each sensor's change reaches its own Matter device, and only that one.
  climate.values[257] = 18.5;
  door.values[11] = 1;
  hallway.values[11] = true;
  hallway.values[21] = 1000;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(30);
  t.mock.timers.tick(3000);
  await flush(30);

  assert.deepEqual(lastState(api, "Bedroom", "temperatureMeasurement"), {
    measuredValue: 1850,
  });
  assert.deepEqual(lastState(api, "Front door", "booleanState"), {
    stateValue: false,
  });
  assert.equal(
    lastState(api, "Hallway", "occupancySensing").occupancy.occupied,
    true,
  );
  assert.deepEqual(
    lastState(api, "Hallway", "illuminanceMeasurement", "light"),
    { measuredValue: 30001 },
  );
  assert.equal(lastState(api, "Bedroom", "booleanState"), undefined);
  assert.equal(
    lastState(api, "Front door", "temperatureMeasurement"),
    undefined,
  );
  assert.equal(platform.hap.stats.maxOpen, 1);
});

test("several sensors: one that stops answering is reported as not responding; the others keep updating", async (t) => {
  const { climate, door, hallway, config } = threeSensors();
  const { platform, api, lines } = setup(t, {
    device: [climate, door, hallway],
    config,
  });
  api.emit("didFinishLaunching");
  for (const device of [climate, door, hallway]) {
    platform.discovery.emit("serviceUp", advertisement(device));
  }
  await flush(30);
  assert.equal(api.matter.accessories.size, 3);

  door.failNextReads = Infinity;
  for (let minute = 1; minute <= 65; minute += 1) {
    climate.values[257] = 20 + minute / 10;
    t.mock.timers.tick(60 * 1000);
    await flush(10);
  }

  assert.equal(reachable(api, "Front door"), false);
  assert.equal(reachable(api, "Bedroom"), undefined);
  assert.equal(reachable(api, "Hallway"), undefined);
  // The last poll before minute 65 read 26 °C.
  assert.deepEqual(lastState(api, "Bedroom", "temperatureMeasurement"), {
    measuredValue: 2600,
  });
  const unreachable = lines.warn.filter((l) => l.includes("unreachable"));
  assert.equal(unreachable.length, 1);
  assert.ok(unreachable[0].includes("[Front door]"));

  // It answers again: back without a restart.
  door.failNextReads = 0;
  door.values[11] = 1;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(30);
  t.mock.timers.tick(3000);
  await flush(30);
  assert.equal(reachable(api, "Front door"), true);
  assert.deepEqual(lastState(api, "Front door", "booleanState"), {
    stateValue: false,
  });
});

test("several sensors: one out of range isn't connected to, the others are read, and it's read the moment it's heard again", async (t) => {
  const { climate, door, hallway, config } = threeSensors();
  const { platform, api } = setup(t, {
    device: [climate, door, hallway],
    config,
    withNoble: true,
  });
  api.emit("didFinishLaunching");
  const noble = platform.hap.noble;
  const advertisements = [climate, door, hallway].map((device) =>
    advertisement(device),
  );
  const hear = (...heard) => {
    for (const adv of heard) {
      noble.emit("discover", adv.peripheral);
    }
  };
  t.mock.timers.tick(3000);
  hear(...advertisements);
  for (const adv of advertisements) {
    platform.discovery.emit("serviceUp", adv);
  }
  await flush(30);
  assert.equal(api.matter.accessories.size, 3);
  const reads = (device) =>
    device.calls.filter((c) => c.startsWith("read")).length;
  const before = [climate, door, hallway].map(reads);

  // The hallway sensor goes quiet; the other two are still heard.
  const [climateAdv, doorAdv, hallwayAdv] = advertisements;
  for (let step = 0; step < 61; step += 1) {
    t.mock.timers.tick(10 * 1000);
    hear(climateAdv, doorAdv);
    await flush(5);
  }
  assert.equal(reads(climate), before[0] + 1);
  assert.equal(reads(door), before[1] + 1);
  assert.equal(reads(hallway), before[2]);

  hallway.values[11] = true;
  hear(hallwayAdv);
  await flush(30);
  t.mock.timers.tick(3000);
  await flush(30);
  assert.equal(reads(hallway), before[2] + 1);
  assert.equal(
    lastState(api, "Hallway", "occupancySensing").occupancy.occupied,
    true,
  );
});
