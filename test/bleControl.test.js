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

// A controllable device (here a power strip with two outlets): kept
// connected, read and commanded over that connection, its own changes
// passed on, and the connection reopened when it drops.

const DEVICE_ID = "41:21:14:E5:C2:25";
const outlet = (iid) => ({
  serviceUuid: "svc-outlet",
  characteristicUuid: "ch-on",
  iid,
  format: "bool",
  perms: ["pr", "pw", "ev"],
});

function powerStrip() {
  const device = createFakeDevice({ values: { 11: 0, 21: 1 } });
  device.paired = true;
  const store = createMemoryStore({
    [DEVICE_ID]: {
      pairingData: { iOSDevicePairingID: "ctrl" },
      configNumber: 1,
      database: { outletOn: outlet(11), "outletOn.2": outlet(21) },
      info: { model: "Strip" },
      readings: { outletOn: false, "outletOn.2": true },
    },
  });
  return { device, store };
}

function setup(t, { config = {}, heard = () => Date.now() } = {}) {
  const buttons = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { device, store } = powerStrip();
  const hap = createFakeHap(device);
  const { log, lines } = createRecordingLog();
  const readings = [];
  const sensor = new BleSensor({
    config: {
      deviceId: DEVICE_ID,
      name: "Strip",
      setupCode: "1288 4842",
      ...config,
    },
    log,
    hap,
    discovery: new hap.BLEDiscovery(),
    store,
    queue: new ConnectionQueue(),
    onReady: () => {},
    onReadings: (values) => readings.push(values),
    onButton: (key, gesture) => buttons.push([key, gesture]),
    lastSeenAt: heard,
  });
  t.after(() => sensor.stop());
  const calls = (prefix) => device.calls.filter((c) => c.startsWith(prefix));
  return { sensor, device, lines, readings, calls, buttons, hap };
}

async function started(t, options) {
  const context = setup(t, options);
  context.sensor.handleAdvertisement(advertisement(context.device));
  await flush(10);
  return context;
}

test("a controllable device is read over a connection that stays open", async (t) => {
  const { sensor, readings, calls } = await started(t);
  assert.deepEqual(calls("link:"), ["link:open"]);
  assert.equal(sensor.link.isOpen, true);
  // Each outlet by its own instance ID.
  assert.deepEqual(readings.at(-1), { outletOn: false, "outletOn.2": true });
  assert.ok(calls("read:").length === 0, "not through hap-controller's read");
});

test("a command goes out on the open connection and becomes the new reading", async (t) => {
  const { sensor, device, readings, calls } = await started(t);
  await sensor.write({ "outletOn.2": false });
  assert.deepEqual(calls("write:"), ["write:21=0"]);
  assert.equal(device.values[21], 0);
  assert.deepEqual(readings.at(-1), { "outletOn.2": false });
  assert.deepEqual(calls("link:open"), ["link:open"], "no new connection");
});

test("a change made at the device is passed on at once", async (t) => {
  const { sensor, readings } = await started(t);
  sensor.link.announce("outletOn", 1);
  assert.deepEqual(readings.at(-1), { outletOn: true });
});

test("reads go on while connected, though a connected device doesn't advertise", async (t) => {
  let lastHeard = Date.now();
  const { sensor, calls } = await started(t, { heard: () => lastHeard });
  lastHeard = Date.now();
  t.mock.timers.tick(10 * 60 * 1000); // poll, not heard for 10 min
  await flush(10);
  assert.equal(calls("link-read:").length, 2);
  assert.equal(sensor.link.isOpen, true);
});

test("a dropped connection is reopened once the device is heard, then read", async (t) => {
  let lastHeard = Date.now();
  const { sensor, device, calls } = await started(t, {
    heard: () => lastHeard,
  });
  lastHeard = -Infinity; // still connected to it: quiet
  device.links[0].drop();
  t.mock.timers.tick(5000);
  await flush(10);
  assert.deepEqual(calls("link:open"), ["link:open"], "waits to hear it");

  lastHeard = Date.now();
  sensor.handlePresence();
  await flush(10);
  assert.deepEqual(calls("link:open"), ["link:open", "link:open"]);
  assert.equal(sensor.link.isOpen, true);
  assert.equal(calls("link-read:").length, 2, "read again after reconnecting");
});

test("reconnecting backs off while it keeps failing", async (t) => {
  const { device, calls } = await started(t);
  device.failNextLinks = 2;
  device.links[0].drop();
  t.mock.timers.tick(5000); // fails
  await flush(10);
  t.mock.timers.tick(5000); // not yet: 15 s now
  await flush(10);
  assert.equal(calls("link:open").length, 2);
  t.mock.timers.tick(10000); // fails again
  await flush(10);
  t.mock.timers.tick(60000); // succeeds
  await flush(10);
  assert.equal(calls("link:open").length, 4);
  assert.equal(device.links.at(-1).isOpen, true);
});

test("a command while disconnected connects first", async (t) => {
  const { sensor, device, calls } = await started(t);
  device.links[0].isOpen = false;
  sensor.link = null;
  await sensor.write({ outletOn: true });
  assert.equal(calls("link:open").length, 2);
  assert.deepEqual(calls("write:"), ["write:11=1"]);
});

test("a refused command rejects, warns, and changes nothing", async (t) => {
  const { sensor, device, readings, lines } = await started(t);
  const before = readings.length;
  device.refuseNextWrite = true;
  await assert.rejects(sensor.write({ outletOn: true }), /refused/);
  assert.equal(readings.length, before);
  assert.ok(lines.warn.some((l) => l.includes("Couldn't set")));
});

test("a command that doesn't finish in 15 seconds fails, and the connection is replaced", async (t) => {
  const { sensor, device, calls } = await started(t);
  device.holdWrites = new Promise(() => {});
  const command = sensor.write({ outletOn: true });
  const result = assert.rejects(command, /timed out/);
  t.mock.timers.tick(15000);
  await result;
  assert.ok(calls("link:close").length >= 1);
  assert.equal(sensor.link, null);
});

test("a command for a device that isn't heard and isn't connected fails without trying", async (t) => {
  let lastHeard = Date.now();
  const { sensor, calls } = await started(t, { heard: () => lastHeard });
  sensor.link.isOpen = false;
  sensor.link = null;
  lastHeard = -Infinity;
  await assert.rejects(sensor.write({ outletOn: true }), /hasn't been heard/);
  assert.equal(calls("link:open").length, 1);
});

test("keepConnected off: a connection for each read and command, closed after", async (t) => {
  const { sensor, calls } = await started(t, {
    config: { keepConnected: false },
  });
  assert.deepEqual(calls("link:"), ["link:open-once", "link:close"]);
  assert.equal(sensor.link, undefined);
  await sensor.write({ outletOn: true });
  assert.deepEqual(calls("link:").slice(2), ["link:open-once", "link:close"]);
});

test("shutdown closes the kept connection", async (t) => {
  const { sensor, calls } = await started(t);
  sensor.stop();
  assert.deepEqual(calls("link:close"), ["link:close"]);
});

test("a write-only characteristic (a blind's hold position) isn't read", async (t) => {
  const { sensor } = setup(t);
  sensor.state.database = {
    coverTarget: { iid: 1, perms: ["pr", "pw", "ev"] },
    coverHold: { iid: 2, perms: ["pw"] },
  };
  assert.deepEqual(
    sensor.readable.map(([key]) => key),
    ["coverTarget"],
  );
});

test("a button press over the kept connection is a press, not a reading", async (t) => {
  const { sensor, readings, buttons } = await started(t);
  const before = readings.length;
  sensor.link.emit("change", { button: 2 });
  assert.deepEqual(buttons, [["button", 2]]);
  assert.equal(readings.length, before);
});

test("a kept-connected device doesn't set up fast updates, which would cut the connection", async (t) => {
  const { sensor, calls } = await started(t, { config: { fastUpdates: true } });
  // An outlet that could broadcast its changes.
  sensor.state.database.outletOn.perms.push("ev-broadcast");
  delete sensor.state.broadcast;
  sensor.maybeSetUpBroadcasts(sensor.advertisement);
  await flush(10);
  assert.equal(sensor.settingUpBroadcasts, undefined);
  assert.equal(sensor.link.isOpen, true);
  assert.deepEqual(calls("link:"), ["link:open"]);
});
