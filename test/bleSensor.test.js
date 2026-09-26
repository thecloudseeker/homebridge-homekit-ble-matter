const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BleSensor } = require("../lib/bleSensor");
const { ConnectionQueue } = require("../lib/connectionQueue");
const {
  createFakeDevice,
  createFakeHap,
  advertisement,
  createRecordingLog,
  createMemoryStore,
  flush,
} = require("./helpers/fakeHap");

const DEVICE_ID = "41:21:14:E5:C2:25";

function setup(t, { device = createFakeDevice(), config = {}, store } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const hap = createFakeHap(device);
  const { log, lines } = createRecordingLog();
  const ready = [];
  const readings = [];
  const sensor = new BleSensor({
    config: {
      deviceId: DEVICE_ID,
      name: "Schlafzimmer",
      setupCode: "1288 4842",
      ...config,
    },
    log,
    hap,
    discovery: new hap.BLEDiscovery(),
    store: store ?? createMemoryStore(),
    queue: new ConnectionQueue(),
    onReady: (database, info) => ready.push({ database, info }),
    onReadings: (values) => readings.push(values),
  });
  t.after(() => sensor.stop());
  return { sensor, device, lines, ready, readings, store: sensor.store };
}

// A store that already holds what a previous run paired and learned.
function storeFromPreviousRun(device) {
  device.paired = true;
  return createMemoryStore({
    [DEVICE_ID]: {
      pairingData: { iOSDevicePairingID: "ctrl" },
      configNumber: 1,
      database: {
        temperature: {
          serviceUuid: "svc-temp",
          characteristicUuid: "ch-temp",
          iid: 257,
          format: "float",
        },
        humidity: {
          serviceUuid: "svc-hum",
          characteristicUuid: "ch-hum",
          iid: 145,
          format: "float",
        },
      },
      info: { model: "CGG1H" },
    },
  });
}

test("an unpaired sensor is paired with the configured setup code, in whatever format it was typed", async (t) => {
  const { sensor, device, store } = setup(t);

  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.equal(device.paired, true);
  assert.equal(
    store.data.get(DEVICE_ID).pairingData.iOSDevicePairingID,
    "ctrl",
    "the pairing keys must be persisted",
  );
});

test("after pairing it learns the structure and accessory information, then reads the values", async (t) => {
  const { sensor, device, ready, readings, store } = setup(t);

  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.deepEqual(Object.keys(ready[0].database).sort(), [
    "batteryLevel",
    "humidity",
    "lowBattery",
    "temperature",
  ]);
  assert.deepEqual(ready[0].info, {
    manufacturer: "Qingping",
    model: "CGG1H",
    serialNumber: "582D34ABCDEF",
    firmwareRevision: "1.2.3",
  });
  assert.equal(store.data.get(DEVICE_ID).configNumber, 1);
  assert.deepEqual(readings, [
    { temperature: 22.4, humidity: 60.5, batteryLevel: 86, lowBattery: false },
  ]);
});

test("a sensor already paired with another controller is not touched, with one clear warning", async (t) => {
  const device = createFakeDevice({ paired: true });
  const { sensor, lines, ready } = setup(t, { device });

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  sensor.handleAdvertisement(advertisement(device, { GSN: 2 }));
  await flush();

  assert.deepEqual(device.calls, []);
  assert.equal(ready.length, 0);
  assert.equal(
    lines.warn.filter((l) => l.includes("another HomeKit controller")).length,
    1,
  );
});

test("without a valid setup code it warns instead of pairing", async (t) => {
  const { sensor, device, lines } = setup(t, { config: { setupCode: "123" } });

  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.deepEqual(device.calls, []);
  assert.ok(lines.warn.some((l) => l.includes("no valid setupCode")));
});

test("a wrong setup code fails setup without storing anything, and is retried on the next advertisement", async (t) => {
  const device = createFakeDevice({ setupCode: "111-11-111" });
  const { sensor, lines, store } = setup(t, { device });

  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.equal(store.data.has(DEVICE_ID), false);
  assert.ok(lines.warn.some((l) => l.includes("Setup failed")));

  device.setupCode = "128-84-842";
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(device.paired, true);
});

test("a restart reuses the stored pairing and structure: no pairing, no structure read", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });

  assert.deepEqual(Object.keys(sensor.cachedDatabase), [
    "temperature",
    "humidity",
  ]);
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.deepEqual(device.calls, ["read:257,145"]);
  assert.deepEqual(readings, [
    {
      temperature: 22.4,
      humidity: 60.5,
      batteryLevel: undefined,
      lowBattery: undefined,
    },
  ]);
});

test("a change in the advertisement's state number triggers a read, at most once every five minutes", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device, { GSN: 1 }));
  await flush();
  assert.equal(readings.length, 1);

  t.mock.timers.tick(60 * 1000);
  sensor.handleAdvertisement(advertisement(device, { GSN: 2 }));
  await flush();
  assert.equal(readings.length, 1, "deferred: the last read was 1 min ago");

  t.mock.timers.tick(4 * 60 * 1000);
  await flush();
  assert.equal(
    readings.length,
    2,
    "the deferred read runs once five minutes are up",
  );
});

test("an unchanged advertisement does not trigger a read", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  t.mock.timers.tick(5 * 60 * 1000);
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.equal(readings.length, 1);
});

test("values are polled on the configured interval", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { pollInterval: 5 },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  t.mock.timers.tick(5 * 60 * 1000);
  await flush();
  t.mock.timers.tick(5 * 60 * 1000);
  await flush();

  assert.equal(readings.length, 3);
});

test("a configuration number change re-reads the structure", async (t) => {
  const device = createFakeDevice();
  const { sensor, store } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device, { CN: 1 }));
  await flush();

  sensor.handleAdvertisement(advertisement(device, { CN: 2 }));
  await flush();

  assert.ok(device.calls.includes("getAccessories"));
  assert.equal(store.data.get(DEVICE_ID).configNumber, 2);
  assert.ok(
    store.data.get(DEVICE_ID).database.batteryLevel,
    "the full structure is now known",
  );
});

test("a failed read warns once and is retried after a minute", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  device.failNextReads = 2;

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.equal(readings.length, 0);

  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.equal(readings.length, 1);
  assert.equal(
    lines.warn.filter((l) => l.includes("Reading failed")).length,
    1,
  );
});

test("after the timeout without a successful read, readings are reported as unavailable", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { timeout: 30, pollInterval: 60 },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  device.failNextReads = 1000;

  t.mock.timers.tick(30 * 60 * 1000);
  await flush();

  assert.deepEqual(readings.at(-1), {
    temperature: null,
    humidity: null,
    batteryLevel: null,
    lowBattery: null,
  });
});

test("a sensor that was reset (advertises unpaired although keys are stored) is paired again", async (t) => {
  const device = createFakeDevice();
  const { sensor, store, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  device.paired = false; // factory reset
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.ok(lines.warn.some((l) => l.includes("no longer paired")));
  assert.ok(device.calls.includes("pairSetup"));
  assert.equal(device.paired, true);
  assert.equal(
    store.data.get(DEVICE_ID).pairingData.iOSDevicePairingID,
    "ctrl",
  );
});

test("stop() ends polling", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  sensor.stop();

  t.mock.timers.tick(60 * 60 * 1000);
  await flush();

  assert.equal(readings.length, 1);
});
