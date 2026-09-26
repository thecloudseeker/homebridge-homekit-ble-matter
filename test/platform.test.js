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
  { config, matterEnabled = true, device = createFakeDevice() } = {},
) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), "hkblematter-"));
  t.after(() => fs.rmSync(storagePath, { recursive: true, force: true }));
  const hap = createFakeHap(device);
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

  first.device.calls.length = 0;
  platform.discovery.emit("serviceUp", advertisement(first.device));
  await flush();
  assert.deepEqual(first.device.calls, ["read:257,145,59,61"]);
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

test("a cached Matter device of a sensor that is no longer configured is removed", (t) => {
  const { platform, api } = setup(t);
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

  assert.deepEqual([...api.matter.accessories.keys()], ["u2"]);
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
