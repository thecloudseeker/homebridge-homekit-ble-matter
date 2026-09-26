const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAccessoryDatabase,
  normalizeSetupCode,
  normalizeDeviceId,
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
