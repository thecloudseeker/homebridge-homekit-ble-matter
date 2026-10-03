const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAccessoryDatabase,
  normalizeSetupCode,
  normalizeDeviceId,
  normalizeAdapter,
  connectedDevices,
  disconnectLeftovers,
} = require("../lib/hap");
const { createFakeHap, createFakeDevice } = require("./helpers/fakeHap");

const hap = createFakeHap(createFakeDevice());

test("parseAccessoryDatabase finds the readings a CGG1H exposes, with their BLE addressing", () => {
  const { readings } = parseAccessoryDatabase(createFakeDevice().database, hap);

  assert.deepEqual(Object.keys(readings).sort(), [
    "batteryLevel",
    "humidity",
    "lowBattery",
    "temperature",
  ]);
  assert.deepEqual(readings.temperature, {
    serviceUuid: "svc-temp",
    characteristicUuid: "ch-temp",
    iid: 257,
    format: "float",
    perms: [],
  });
  assert.equal(readings.humidity.iid, 145);
  assert.equal(readings.batteryLevel.iid, 59);
  assert.equal(readings.lowBattery.iid, 61);
});

test("parseAccessoryDatabase takes accessory information only from the accessory-information service", () => {
  const { info } = parseAccessoryDatabase(createFakeDevice().database, hap);

  assert.deepEqual(
    Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.iid])),
    { manufacturer: 4, model: 5, serialNumber: 6, firmwareRevision: 14 },
  );
});

test("parseAccessoryDatabase tolerates an empty or partial database", () => {
  assert.deepEqual(parseAccessoryDatabase({}, hap), {
    readings: {},
    info: {},
  });
  assert.deepEqual(
    parseAccessoryDatabase({ accessories: [{ aid: 1 }] }, hap).readings,
    {},
  );
});

test("normalizeSetupCode accepts the ways a HomeKit code is printed or typed", () => {
  for (const input of ["12884842", "1288 4842", "128-84-842", " 128 84 842 "]) {
    assert.equal(normalizeSetupCode(input), "128-84-842", input);
  }
});

test("normalizeSetupCode rejects anything that isn't 8 digits", () => {
  for (const input of [undefined, null, "", "1234567", "123456789", "abc"]) {
    assert.equal(normalizeSetupCode(input), null, String(input));
  }
});

test("normalizeDeviceId compares DeviceIDs case-insensitively", () => {
  assert.equal(normalizeDeviceId(" 41:21:14:e5:c2:25 "), "41:21:14:E5:C2:25");
  assert.equal(normalizeDeviceId(undefined), "");
});

// A stand-in for dbus-next's MessageBus that records the calls it would send
// to the bus daemon.
function createRecordingBus() {
  const sent = [];
  return {
    sent,
    _matchRules: {},
    _connection: { stream: { writable: true } },
    call(message) {
      sent.push(`${message.member} ${message.body[0]}`);
      return Promise.resolve();
    },
  };
}

const RULE =
  "type='signal',sender=org.bluez,interface='org.freedesktop.DBus.Properties',path='/org/bluez/hci0/dev_AA',member='PropertiesChanged'";

test("dbus-next 0.10.2 never removes a match rule (the leak fixMatchRuleRefcounts works around)", async () => {
  const MessageBus = require("dbus-next/lib/bus.js");
  const bus = createRecordingBus();
  await MessageBus.prototype._addMatch.call(bus, RULE);
  await MessageBus.prototype._removeMatch.call(bus, RULE);
  assert.deepEqual(bus.sent, [`AddMatch ${RULE}`]);
});

test("fixMatchRuleRefcounts removes a rule once its last listener is gone", async () => {
  const { fixMatchRuleRefcounts } = require("../lib/hap");
  const MessageBus = require("dbus-next/lib/bus.js");
  const bus = createRecordingBus();
  bus._addMatch = MessageBus.prototype._addMatch;
  bus._removeMatch = MessageBus.prototype._removeMatch;
  fixMatchRuleRefcounts(bus);

  await bus._addMatch(RULE);
  await bus._addMatch(RULE);
  await bus._removeMatch(RULE);
  assert.deepEqual(bus.sent, [`AddMatch ${RULE}`]);
  await bus._removeMatch(RULE);
  assert.deepEqual(bus.sent, [`AddMatch ${RULE}`, `RemoveMatch ${RULE}`]);
  // A stray removal sends nothing.
  await bus._removeMatch(RULE);
  assert.equal(bus.sent.length, 2);
});

test("fixMatchRuleRefcounts keeps rules bounded while devices come and go", async () => {
  const { fixMatchRuleRefcounts } = require("../lib/hap");
  const MessageBus = require("dbus-next/lib/bus.js");
  const bus = createRecordingBus();
  bus._addMatch = MessageBus.prototype._addMatch;
  bus._removeMatch = MessageBus.prototype._removeMatch;
  fixMatchRuleRefcounts(bus);

  for (let i = 0; i < 3000; i++) {
    const rule = RULE.replace("dev_AA", `dev_${i}`);
    await bus._addMatch(rule);
    await bus._removeMatch(rule);
  }
  assert.equal(bus.homekitBleMatterMatchRules.size, 0);
});

test("fixMatchRuleRefcounts forgets a rule the bus refused, so it is retried", async () => {
  const { fixMatchRuleRefcounts } = require("../lib/hap");
  const MessageBus = require("dbus-next/lib/bus.js");
  const bus = createRecordingBus();
  bus._addMatch = MessageBus.prototype._addMatch;
  bus._removeMatch = MessageBus.prototype._removeMatch;
  const call = bus.call;
  bus.call = () =>
    Promise.reject(new Error("not allowed to add more match rules"));
  fixMatchRuleRefcounts(bus);

  await assert.rejects(bus._addMatch(RULE), /not allowed/);
  bus.call = call;
  await bus._addMatch(RULE);
  assert.deepEqual(bus.sent, [`AddMatch ${RULE}`]);
});

test("rateLimitedWarning reports the first error, then at most one summary per interval", () => {
  const { rateLimitedWarning } = require("../lib/hap");
  const warnings = [];
  const noble = { emit: (event, message) => warnings.push(message) };
  let clock = 0;
  const warn = rateLimitedWarning(noble, 10 * 60 * 1000, () => clock);

  warn("D-Bus error");
  clock = 1000;
  warn("D-Bus error");
  warn("D-Bus error");
  assert.deepEqual(warnings, ["D-Bus error"]);

  clock = 10 * 60 * 1000;
  warn("D-Bus error");
  assert.deepEqual(warnings, [
    "D-Bus error",
    "D-Bus error (2 more in the last 10 min)",
  ]);
});

test("parseAccessoryDatabase reads every supported sensor service, numbering repeated ones", () => {
  const { hapDatabase } = require("./helpers/fakeHap");
  const { readings } = parseAccessoryDatabase(
    hapDatabase([
      [
        "sensor.contact",
        [
          ["contact-state", 11, "uint8"],
          ["status-lo-batt", 12, "uint8"],
        ],
      ],
      [
        "sensor.contact",
        [
          ["contact-state", 21, "uint8"],
          ["status-lo-batt", 22, "uint8"],
        ],
      ],
      ["sensor.light", [["light-level.current", 31, "float"]]],
      ["sensor.motion", [["motion-detected", 41, "bool"]]],
      [
        "sensor.smoke",
        [
          ["smoke-detected", 51, "uint8"],
          ["status-fault", 52, "uint8"],
        ],
      ],
      [
        "sensor.carbon-dioxide",
        [
          ["carbon-dioxide.detected", 61, "uint8"],
          ["carbon-dioxide.level", 62, "float"],
        ],
      ],
      [
        "sensor.air-quality",
        [
          ["air-quality", 71, "uint8"],
          ["density.voc", 72, "float"],
          ["density.pm25", 73, "float"],
        ],
      ],
      ["battery", [["battery-level", 81, "uint8"]]],
    ]),
    hap,
  );
  assert.deepEqual(Object.keys(readings).sort(), [
    "airQuality",
    "batteryLevel",
    "carbonDioxide",
    "carbonDioxideLevel",
    "contact",
    "contact.2",
    "fault",
    "lightLevel",
    "lowBattery",
    "motion",
    "pm25",
    "smoke",
    "voc",
  ]);
  assert.equal(readings["contact.2"].iid, 21);
  assert.equal(readings.lowBattery.iid, 12, "the battery is taken once");
});

test("parseAccessoryDatabase skips characteristics that can't be read", () => {
  const { hapDatabase } = require("./helpers/fakeHap");
  const { readings } = parseAccessoryDatabase(
    hapDatabase([
      ["sensor.motion", [["motion-detected", 41, "bool", ["ev"]]]],
      ["sensor.leak", [["leak-detected", 51, "uint8", ["pr", "ev"]]]],
    ]),
    hap,
  );
  assert.deepEqual(Object.keys(readings), ["leak"]);
});

test("normalizeAdapter accepts BlueZ adapter names only", () => {
  assert.equal(normalizeAdapter("hci1"), "hci1");
  assert.equal(normalizeAdapter(" HCI0 "), "hci0");
  for (const value of [undefined, "", "1", "usb", "hci", "hci1; rm"]) {
    assert.equal(normalizeAdapter(value), null);
  }
});

// BlueZ's object tree as noble's D-Bus binding keeps it.
function bluezObjects() {
  const device = (Address, Connected) => ({
    "org.bluez.Device1": { Address, Connected },
  });
  return new Map([
    ["/org/bluez/hci0", { "org.bluez.Adapter1": {} }],
    ["/org/bluez/hci0/dev_CB_81", device("CB:81:D1:B0:00:A5", true)],
    ["/org/bluez/hci0/dev_AA_01", device("AA:AA:AA:AA:AA:01", false)],
    ["/org/bluez/hci0/dev_BB_02", device("BB:BB:BB:BB:BB:02", true)],
    ["/org/bluez/hci1/dev_CC_03", device("CC:CC:CC:CC:CC:03", true)],
  ]);
}

test("connectedDevices: only our sensors, only connected ones, only on our adapter", () => {
  assert.deepEqual(
    connectedDevices(bluezObjects(), "/org/bluez/hci0", [
      "cb:81:d1:b0:00:a5",
      "AA:AA:AA:AA:AA:01",
      "CC:CC:CC:CC:CC:03",
    ]),
    [["CB:81:D1:B0:00:A5", "/org/bluez/hci0/dev_CB_81"]],
  );
  assert.deepEqual(connectedDevices(undefined, "/org/bluez/hci0", ["x"]), []);
  assert.deepEqual(connectedDevices(bluezObjects(), null, ["x"]), []);
});

test("disconnectLeftovers disconnects them through BlueZ and reports a failure as a warning", async () => {
  const { EventEmitter } = require("events");
  const disconnected = [];
  const noble = new EventEmitter();
  noble._bindings = {
    _objects: bluezObjects(),
    _adapterPath: "/org/bluez/hci0",
    _bus: {
      getProxyObject: async (service, path) => ({
        getInterface: () => ({
          Disconnect: async () => {
            if (path.endsWith("BB_02")) {
              throw new Error("org.bluez.Error.Failed");
            }
            disconnected.push(path);
          },
        }),
      }),
    },
  };
  const warnings = [];
  noble.on("warning", (message) => warnings.push(message));

  const done = await disconnectLeftovers(noble, [
    "CB:81:D1:B0:00:A5",
    "BB:BB:BB:BB:BB:02",
  ]);
  assert.deepEqual(done, ["CB:81:D1:B0:00:A5"]);
  assert.deepEqual(disconnected, ["/org/bluez/hci0/dev_CB_81"]);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("BB:BB:BB:BB:BB:02"));

  // Without a D-Bus connection there is nothing to do.
  assert.deepEqual(await disconnectLeftovers({}, ["CB:81:D1:B0:00:A5"]), []);
});

test("parseAccessoryDatabase finds buttons (which can't be read) and the status flags", () => {
  const { hapDatabase } = require("./helpers/fakeHap");
  const { readings } = parseAccessoryDatabase(
    hapDatabase([
      [
        "stateless-programmable-switch",
        [["input-event", 11, "uint8", ["ev", "ev-broadcast"]]],
      ],
      [
        "stateless-programmable-switch",
        [["input-event", 21, "uint8", ["ev", "ev-broadcast"]]],
      ],
      [
        "sensor.motion",
        [
          ["motion-detected", 31, "bool", ["pr", "ev"]],
          ["status-active", 32, "bool", ["pr", "ev"]],
          ["status-tampered", 33, "uint8", ["pr", "ev"]],
        ],
      ],
    ]),
    hap,
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(readings).map(([k, v]) => [k, v.iid])),
    { button: 11, "button.2": 21, motion: 31, active: 32, tampered: 33 },
  );
});
