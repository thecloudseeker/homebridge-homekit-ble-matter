const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BleSensor } = require("../lib/bleSensor");
const { ConnectionQueue } = require("../lib/connectionQueue");
const {
  hapDatabase,
  createFakeDevice,
  createFakeHap,
  advertisement,
  createRecordingLog,
  createMemoryStore,
  flush,
} = require("./helpers/fakeHap");

const DEVICE_ID = "41:21:14:E5:C2:25";

function setup(
  t,
  {
    device = createFakeDevice(),
    config = {},
    store,
    lastSeenAt,
    pairableCandidates,
    onReachable,
    configureBroadcasts,
  } = {},
) {
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
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(pairableCandidates ? { pairableCandidates } : {}),
    ...(onReachable ? { onReachable } : {}),
    ...(configureBroadcasts ? { configureBroadcasts } : {}),
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

test("a failed connect that leaves noble's peripheral stuck doesn't block every later read", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  device.failNextConnects = 1;

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(readings.length, 0);
  assert.match(lines.warn.join("\n"), /le-connection-abort-by-local/);

  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.equal(readings.length, 1);
  assert.equal(sensor.advertisement.peripheral.state, "disconnected");
});

test("after the timeout without a successful read, the device is reported unreachable (not with cleared values), and reachable again on the next read", async (t) => {
  const device = createFakeDevice();
  const reachability = [];
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { timeout: 30, pollInterval: 60 },
    onReachable: (r) => reachability.push(r),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  device.failNextReads = 1000;

  t.mock.timers.tick(30 * 60 * 1000);
  await flush();

  assert.deepEqual(reachability, [false]);
  assert.ok(readings.every((r) => r.temperature != null));

  device.failNextReads = 0;
  t.mock.timers.tick(60 * 60 * 1000);
  await flush();
  assert.deepEqual(reachability, [false, true]);
});

test("a sensor never read after a restart is also reported unreachable after the timeout", async (t) => {
  const device = createFakeDevice();
  const reachability = [];
  setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { timeout: 30 },
    onReachable: (r) => reachability.push(r),
  });
  // No advertisement at all: the sensor is out of range.
  t.mock.timers.tick(30 * 60 * 1000);
  await flush();
  assert.deepEqual(reachability, [false]);
});

test("the last readings are stored, so a restart starts with them", async (t) => {
  const device = createFakeDevice();
  const { sensor, store } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.deepEqual(store.load(DEVICE_ID).readings, {
    temperature: 22.4,
    humidity: 60.5,
  });
  assert.equal(sensor.cachedReadings.temperature, 22.4);
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
  assert.equal(
    device.calls.includes("pairSetup"),
    false,
    "one advertisement isn't enough to discard the keys",
  );

  t.mock.timers.tick(30 * 1000);
  await flush();
  assert.ok(lines.warn.some((l) => l.includes("no longer paired")));
  assert.ok(device.calls.includes("pairSetup"));
  assert.equal(device.paired, true);
  assert.equal(
    store.data.get(DEVICE_ID).pairingData.iOSDevicePairingID,
    "ctrl",
  );
  assert.ok(
    store.data.get(`${DEVICE_ID}.bak`).pairingData,
    "the old keys are kept in a backup",
  );
});

test("a 'not paired' advertisement that is followed by a paired one again keeps the keys", async (t) => {
  const device = createFakeDevice();
  const { sensor, store, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  sensor.handleAdvertisement(advertisement(device, { availableToPair: true }));
  t.mock.timers.tick(5 * 1000);
  sensor.handleAdvertisement(advertisement(device, { availableToPair: false }));
  t.mock.timers.tick(30 * 1000);
  await flush();

  assert.equal(device.calls.includes("pairSetup"), false);
  assert.ok(store.data.get(DEVICE_ID).pairingData);
  assert.equal(
    lines.warn.some((l) => l.includes("no longer paired")),
    false,
  );
});

test("the keys are kept if the device wasn't heard live when the 'not paired' flag is confirmed", async (t) => {
  const device = createFakeDevice();
  let seen = Date.now();
  const { sensor, store } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    lastSeenAt: () => seen,
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  seen = Date.now();
  sensor.handleAdvertisement(advertisement(device, { availableToPair: true }));
  // Then it goes quiet (e.g. out of range).
  t.mock.timers.tick(30 * 1000);
  await flush();

  assert.equal(device.calls.includes("pairSetup"), false);
  assert.ok(store.data.get(DEVICE_ID).pairingData);
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

test("a failed pairing is retried after a minute, without waiting for the advertisement to change", async (t) => {
  const device = createFakeDevice({ failNextPairs: 1 });
  const { sensor, lines, ready } = setup(t, { device });

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(device.paired, false);

  t.mock.timers.tick(60 * 1000);
  await flush();

  assert.equal(device.paired, true);
  assert.equal(ready.length, 1);
  const failure = lines.warn.find((l) => l.includes("Setup failed"));
  assert.ok(
    failure.endsWith("retrying in 1 min: Timeout"),
    `hap-controller's plain-string rejection must be readable, got: ${failure}`,
  );
});

test("a failed read with a plain-string rejection is reported readably", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  device.failNextReads = 1;

  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.ok(lines.warn.some((l) => l.endsWith("Reading failed: Timeout")));
});

test("repeated setup failures back off (1, 2, 5, 10 min) and suggest restarting the sensor after three", async (t) => {
  const device = createFakeDevice({ failNextPairs: 5 });
  const { sensor, lines } = setup(t, { device });
  const attempts = () => device.calls.filter((c) => c === "pairSetup").length;

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(attempts(), 1);

  for (const [minutes, expected] of [
    [1, 2],
    [2, 3],
    [5, 4],
    [10, 5],
    [10, 6],
  ]) {
    t.mock.timers.tick(minutes * 60 * 1000 - 1000);
    await flush();
    assert.equal(attempts(), expected - 1, `not before ${minutes} min`);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(attempts(), expected, `after ${minutes} min`);
  }

  assert.equal(device.paired, true, "the sixth attempt succeeds");
  assert.equal(
    lines.warn.filter((l) => l.includes("take the battery out")).length,
    1,
  );
});

test("a device known only from BlueZ's cache is not connected to: it waits, then pairs once it's heard live", async (t) => {
  let seen = null;
  const { sensor, device, lines } = setup(t, { lastSeenAt: () => seen });

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.deepEqual(device.calls, [], "no connection attempt");
  assert.equal(lines.warn.length, 0, "waiting is not a failure");

  seen = Date.now();
  sensor.handlePresence();
  await flush();
  assert.equal(device.paired, true);
});

test("a stale 'not paired' flag replayed from BlueZ's cache does not throw away the pairing keys", async (t) => {
  const device = createFakeDevice();
  let seen = Date.now();
  const { sensor, store, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    lastSeenAt: () => seen,
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  // Ten seconds later a cached copy of an old, unpaired advertisement shows up.
  t.mock.timers.tick(10 * 1000);
  seen = Date.now() - 10 * 1000;
  sensor.handleAdvertisement(advertisement(device, { availableToPair: true }));
  await flush();

  assert.equal(
    store.data.get(DEVICE_ID).pairingData.iOSDevicePairingID,
    "ctrl",
  );
  assert.equal(
    lines.warn.some((l) => l.includes("no longer paired")),
    false,
  );
});

test("the first successful read is logged at info level with the values", async (t) => {
  const { sensor, device, lines } = setup(t);
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.ok(
    lines.info.includes(
      "[Schlafzimmer] Receiving readings: 22.4 °C, 60.5 %, battery 86 %.",
    ),
  );
});

test("after failures, the first successful read says so; later successes stay quiet", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  device.failNextReads = 2;
  t.mock.timers.tick(10 * 60 * 1000); // poll → fails
  await flush();
  t.mock.timers.tick(60 * 1000); // retry → fails
  await flush();
  t.mock.timers.tick(60 * 1000); // retry → succeeds
  await flush();
  t.mock.timers.tick(10 * 60 * 1000); // next poll → succeeds
  await flush();

  const ok = lines.info.filter((l) => l.includes("Readings OK again"));
  assert.deepEqual(ok, [
    "[Schlafzimmer] Readings OK again after 2 failed attempts: 22.4 °C, 60.5 %.",
  ]);
});

test("after five failed reads in a row the log suggests likely causes, once", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { timeout: 600 },
  });
  device.failNextReads = 7;
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  for (let i = 0; i < 7; i += 1) {
    t.mock.timers.tick(60 * 1000);
    await flush();
  }

  assert.equal(
    lines.warn.filter((l) => l.includes("Other Bluetooth plugins")).length,
    1,
  );
});

test("after five failed reads it stops retrying every minute and only tries on the poll interval", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { timeout: 600, pollInterval: 10 },
  });
  device.failNextReads = 1000;
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(60 * 1000);
    await flush();
  }
  const reads = () => device.calls.filter((c) => c.startsWith("read:")).length;
  assert.equal(reads(), 5);

  // Nothing more within the next few minutes...
  t.mock.timers.tick(4 * 60 * 1000);
  await flush();
  assert.equal(reads(), 5);

  // ...but the poll still tries, and a recovered sensor is read again.
  device.failNextReads = 0;
  t.mock.timers.tick(6 * 60 * 1000);
  await flush();
  assert.equal(reads(), 6);
  assert.equal(readings.length, 1);
});

test("the repeated-failure hint names a device available to pair as the likely new DeviceID", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { timeout: 600 },
    pairableCandidates: () => "A9:DF:DB:F9:0D:35 ('Qin')",
  });
  device.failNextReads = 5;
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(60 * 1000);
    await flush();
  }
  const hint = lines.warn.find((l) => l.includes("Other Bluetooth plugins"));
  assert.match(hint, /replace 41:21:14:E5:C2:25 .* A9:DF:DB:F9:0D:35/);
});

test("debug logging shows the signal strength for each connection and read", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  const ad = advertisement(device);
  ad.peripheral.rssi = -78;
  sensor.handleAdvertisement(ad);
  await flush();

  assert.ok(
    lines.debug.some((l) =>
      /Connecting \(RSSI -78 dBm, heard \d+s ago\)/.test(l),
    ),
  );
  assert.ok(lines.debug.some((l) => /Read \(startup, RSSI -78 dBm/.test(l)));
});

test("on the very first setup the Matter device is only registered once a read succeeded, so it never starts with unknown values", async (t) => {
  const { sensor, device, ready, readings } = setup(t);
  device.failNextReads = 1;

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(device.paired, true);
  assert.equal(ready.length, 0, "no readings yet: not registered");

  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.equal(ready.length, 1);
  assert.equal(readings.length, 1);
  assert.equal(sensor.cachedReadings.temperature, 22.4);
});

test("with readings from a previous run the Matter device is registered right away, even if the read fails", async (t) => {
  const device = createFakeDevice();
  const store = storeFromPreviousRun(device);
  store.data.get(DEVICE_ID).readings = { temperature: 21.8, humidity: 68 };
  const { sensor, ready, readings } = setup(t, { device, store });
  device.failNextReads = 1;

  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(ready.length, 1);
  assert.equal(readings.length, 0);
});

test("a change signalled during a read is read afterwards instead of waiting for the next poll", async (t) => {
  const device = createFakeDevice();
  const { sensor, readings } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { pollInterval: 60 },
  });
  sensor.handleAdvertisement(advertisement(device, { GSN: 1 }));
  await flush();
  assert.equal(readings.length, 1);

  t.mock.timers.tick(6 * 60 * 1000);
  let release;
  device.holdReads = new Promise((resolve) => {
    release = resolve;
  });
  sensor.handleAdvertisement(advertisement(device, { GSN: 2 }));
  await flush();
  // The value changes again while that read is still running.
  sensor.handleAdvertisement(advertisement(device, { GSN: 3 }));
  device.holdReads = null;
  release();
  await flush();
  assert.equal(readings.length, 2);

  t.mock.timers.tick(5 * 60 * 1000);
  await flush();
  assert.equal(
    readings.length,
    3,
    "the change is read, after the 5-minute gap",
  );
});

test("the store is only rewritten when the readings changed", async (t) => {
  const device = createFakeDevice();
  const store = storeFromPreviousRun(device);
  let saves = 0;
  const save = store.save;
  store.save = (...args) => {
    saves += 1;
    return save(...args);
  };
  const { sensor, readings } = setup(t, { device, store });
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  assert.equal(saves, 1, "the first readings are new");

  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  assert.equal(readings.length, 2);
  assert.equal(saves, 1, "same values: not written again");

  device.values[257] = 23.1;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush();
  assert.equal(saves, 2);
});

test("a pairing that times out but then completes keeps its keys", async (t) => {
  const { sensor, device, store, lines } = setup(t);
  let release;
  device.holdPairing = new Promise((resolve) => {
    release = resolve;
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  t.mock.timers.tick(90 * 1000);
  await flush();
  assert.equal(store.data.get(DEVICE_ID)?.pairingData, undefined);

  // The device completes the pairing two minutes later.
  t.mock.timers.tick(60 * 1000);
  release();
  await flush();
  assert.equal(device.paired, true);
  assert.equal(
    store.data.get(DEVICE_ID).pairingData.iOSDevicePairingID,
    "ctrl",
  );
  assert.ok(lines.info.some((l) => l.includes("Pairing finished late")));
  assert.equal(
    device.calls.includes("peripheral:disconnect"),
    false,
    "a pairing is never cut off while it may still complete",
  );
});

test("after a timed-out read the peripheral is disconnected, and the next connection waits until the read has ended", async (t) => {
  const device = createFakeDevice();
  const { sensor } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  device.holdReads = new Promise((resolve, reject) => {
    device.onPeripheralDisconnect = () => reject("Disconnected");
  });
  device.holdReads.catch(() => {});
  sensor.handleAdvertisement(advertisement(device));
  await flush();
  const next = sensor.queue.run(async () => device.calls.push("next"));

  t.mock.timers.tick(45 * 1000);
  await flush();
  await next;
  const disconnectAt = device.calls.indexOf("peripheral:disconnect");
  assert.ok(disconnectAt >= 0, "the peripheral was disconnected");
  assert.ok(disconnectAt < device.calls.indexOf("next"));
});

test("stop() disconnects a connection in progress, so BlueZ doesn't keep it after Homebridge exits", async (t) => {
  const device = createFakeDevice();
  const { sensor } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  device.holdReads = new Promise(() => {});
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  sensor.stop();
  assert.ok(device.calls.includes("peripheral:disconnect"));
});

test("if the pairing keys can't be saved it says so loudly and keeps retrying", async (t) => {
  const store = createMemoryStore();
  const save = store.save;
  let readOnly = true;
  store.save = (...args) => {
    if (readOnly) {
      throw new Error("EROFS: read-only file system");
    }
    return save(...args);
  };
  const { sensor, device, lines } = setup(t, { store });
  sensor.handleAdvertisement(advertisement(device));
  await flush();

  assert.equal(device.paired, true);
  assert.ok(lines.error.some((l) => l.includes("pairing keys")));
  assert.equal(store.data.get(DEVICE_ID), undefined);
  assert.equal(
    lines.error.filter((l) => l.includes("Could not save")).length,
    1,
    "said once, not on every retry",
  );

  readOnly = false;
  t.mock.timers.tick(60 * 1000);
  await flush();
  assert.ok(store.data.get(DEVICE_ID)?.pairingData);
  assert.ok(lines.info.some((l) => l.includes("works again")));
});

test("a sensor not heard recently isn't connected to; it's read the moment it's heard again", async (t) => {
  const device = createFakeDevice();
  // Set once the mocked clock runs (it starts at 0).
  let seen = 0;
  const { sensor, readings, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    lastSeenAt: () => seen,
  });
  seen = Date.now();
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.equal(readings.length, 1);
  const reads = () => device.calls.filter((c) => c.startsWith("read")).length;
  const before = reads();

  // It goes quiet; the next poll doesn't connect.
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(10);
  assert.equal(reads(), before);
  assert.ok(lines.debug.some((l) => l.includes("Not heard for 10 min")));

  // Heard again: read right away, without waiting for the next poll.
  seen = Date.now();
  sensor.handlePresence();
  await flush(10);
  assert.equal(reads(), before + 1);
  assert.equal(readings.length, 2);
});

test("waiting for a sensor that isn't heard counts toward 'unreachable', with the reason", async (t) => {
  const device = createFakeDevice();
  // Set once the mocked clock runs (it starts at 0).
  let seen = 0;
  const states = [];
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    lastSeenAt: () => seen,
    onReachable: (reachable) => states.push(reachable),
  });
  seen = Date.now();
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  seen = Date.now() - 60 * 1000;

  t.mock.timers.tick(60 * 60 * 1000);
  await flush(10);
  assert.deepEqual(states, [false]);
  assert.ok(
    lines.warn.some(
      (l) => l.includes("hasn't been heard for") && l.includes("unreachable"),
    ),
  );
  // No read attempts, so no failure warnings.
  assert.equal(
    lines.warn.some((l) => l.includes("Reading failed")),
    false,
  );
});

test("BlueZ's 'interface not found' error is explained", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
  });
  device.failNextReads = 1;
  device.readError = new Error(
    "interface not found in proxy object: org.freedesktop.DBus.Properties",
  );
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.ok(
    lines.warn.some((l) => l.includes("Bluetooth no longer knows the device")),
  );
});

test("a door sensor's change is read within 30 seconds, not 5 minutes", async (t) => {
  const device = createFakeDevice({
    database: hapDatabase([
      ["sensor.contact", [["contact-state", 11, "uint8"]]],
    ]),
    values: { 4: "Acme", 5: "Door", 11: 0 },
  });
  const { sensor, readings } = setup(t, { device });
  sensor.handleAdvertisement(advertisement(device, { GSN: 1 }));
  await flush(10);
  assert.equal(readings.length, 1);

  t.mock.timers.tick(10 * 1000);
  device.values[11] = 1;
  sensor.handleAdvertisement(advertisement(device, { GSN: 2 }));
  await flush();
  assert.equal(readings.length, 1, "deferred: the last read was 10 s ago");

  t.mock.timers.tick(20 * 1000);
  await flush();
  assert.deepEqual(readings.at(-1), { contact: false });
});

test("fast updates aren't set up while the sensor has gone quiet; the next read tries again", async (t) => {
  const device = createFakeDevice();
  const store = storeFromPreviousRun(device);
  const state = store.load(DEVICE_ID);
  for (const address of Object.values(state.database)) {
    address.perms = ["pr", "ev-broadcast"];
  }
  store.save(DEVICE_ID, state);
  let quiet = true;
  let setUps = 0;
  const reads = () => device.calls.filter((c) => c.startsWith("read")).length;
  const { sensor, readings } = setup(t, {
    device,
    store,
    config: { fastUpdates: true },
    // Heard when a read starts; while quiet, not anymore once it's done.
    lastSeenAt: () =>
      quiet && reads() > 0 ? Date.now() - 60 * 1000 : Date.now(),
    configureBroadcasts: async () => {
      setUps += 1;
      return { key: Buffer.alloc(32, 1), gsn: 1, enabled: [257, 145] };
    },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.equal(readings.length, 1);
  assert.equal(setUps, 0);

  quiet = false;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(10);
  assert.equal(readings.length, 2);
  assert.equal(setUps, 1);
});

test("removePairing removes the pairing from the device, keeps the keys as a backup, and stops using it", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines, readings, store } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { removePairing: true },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);

  assert.deepEqual(
    device.calls.filter((c) => !c.startsWith("scan:")),
    ["removePairing:ctrl"],
  );
  assert.equal(device.paired, false);
  assert.equal(store.load(DEVICE_ID).pairingData, null);
  assert.deepEqual(store.data.get(`${DEVICE_ID}.bak`).pairingData, {
    iOSDevicePairingID: "ctrl",
  });
  assert.ok(lines.info.some((l) => l.includes("can be added to Apple Home")));

  // It now advertises "not paired": neither paired again nor read.
  sensor.handleAdvertisement(advertisement(device, { GSN: 2 }));
  t.mock.timers.tick(60 * 60 * 1000);
  await flush(10);
  assert.deepEqual(
    device.calls.filter((c) => !c.startsWith("scan:")),
    ["removePairing:ctrl"],
  );
  assert.equal(readings.length, 0);
});

test("removePairing on a device that failed to answer is retried", async (t) => {
  const device = createFakeDevice();
  device.failNextPairs = 1;
  const { sensor, lines } = setup(t, {
    device,
    store: storeFromPreviousRun(device),
    config: { removePairing: true },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.equal(device.paired, true);
  assert.ok(lines.warn.some((l) => l.includes("retrying in 1 min")));

  t.mock.timers.tick(60 * 1000);
  await flush(10);
  assert.equal(device.paired, false);
});

test("removePairing on a device this plugin never paired with does nothing but say so, once", async (t) => {
  const device = createFakeDevice();
  const { sensor, lines } = setup(t, {
    device,
    config: { removePairing: true },
  });
  sensor.handleAdvertisement(advertisement(device));
  sensor.handleAdvertisement(advertisement(device, { GSN: 2 }));
  await flush(10);
  assert.deepEqual(
    device.calls.filter((c) => !c.startsWith("scan:")),
    [],
  );
  assert.equal(
    lines.info.filter((l) => l.includes("Not paired with this plugin")).length,
    1,
  );
});

test("the Bluetooth address is remembered with the pairing, for the next startup", async (t) => {
  const { sensor, device, store } = setup(t);
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.equal(store.load(DEVICE_ID).address, "cb:81:d1:b0:00:a5");
  assert.equal(sensor.bluetoothAddress, "cb:81:d1:b0:00:a5");
});

test("temperatureOffset and humidityOffset correct what the sensor measures", async (t) => {
  const device = createFakeDevice();
  device.values[257] = 21.799999237060547;
  device.values[145] = 98;
  const { sensor, readings, store } = setup(t, {
    device,
    config: { temperatureOffset: -0.5, humidityOffset: 3 },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);

  // Humidity stays within 0-100 %; battery is untouched.
  assert.deepEqual(readings.at(-1), {
    temperature: 21.3,
    humidity: 100,
    batteryLevel: 86,
    lowBattery: false,
  });
  // Also what a restart starts from.
  assert.equal(store.load(DEVICE_ID).readings.temperature, 21.3);
});

test("an offset that isn't a number is ignored", async (t) => {
  const { sensor, device, readings } = setup(t, {
    config: { temperatureOffset: "warm", humidityOffset: null },
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.equal(readings.at(-1).temperature, 22.4);
  assert.equal(readings.at(-1).humidity, 60.5);
});

test("a sensor that says it isn't working is reported as not responding until it works again; tampering is logged", async (t) => {
  const device = createFakeDevice({
    database: hapDatabase([
      [
        "sensor.motion",
        [
          ["motion-detected", 11, "bool"],
          ["status-active", 12, "bool"],
          ["status-tampered", 13, "uint8"],
        ],
      ],
    ]),
    values: { 4: "Acme", 5: "Motion", 11: false, 12: true, 13: 0 },
  });
  const states = [];
  const { sensor, lines } = setup(t, {
    device,
    onReachable: (reachable) => states.push(reachable),
  });
  sensor.handleAdvertisement(advertisement(device));
  await flush(10);
  assert.deepEqual(states, []);

  device.values[12] = false;
  device.values[13] = 1;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(10);
  assert.deepEqual(states, [false]);
  assert.ok(lines.warn.some((l) => l.includes("isn't working")));
  assert.equal(lines.warn.filter((l) => l.includes("tampered with")).length, 1);

  // Unchanged on the next read: said once.
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(10);
  assert.deepEqual(states, [false]);
  assert.equal(lines.warn.filter((l) => l.includes("tampered with")).length, 1);

  device.values[12] = true;
  device.values[13] = 0;
  t.mock.timers.tick(10 * 60 * 1000);
  await flush(10);
  assert.deepEqual(states, [false, true]);
  assert.ok(lines.info.some((l) => l.includes("working again")));
});
