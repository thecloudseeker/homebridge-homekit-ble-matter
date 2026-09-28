const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeReadings,
  describeReadings,
  baseKey,
  instanceOf,
  instanceKey,
} = require("../lib/sensorTypes");

test("HomeKit values become plain numbers and booleans", () => {
  assert.deepEqual(
    normalizeReadings({
      temperature: "21.5",
      contact: 1,
      motion: 1,
      occupancy: 0,
      leak: true,
      smoke: 0,
      carbonDioxideLevel: 812,
      airQuality: 3,
      lightLevel: 0.5,
      lowBattery: 1,
    }),
    {
      temperature: 21.5,
      contact: false, // 1 = contact not detected: open
      motion: true,
      occupancy: false,
      leak: true,
      smoke: false,
      carbonDioxideLevel: 812,
      airQuality: 3,
      lightLevel: 0.5,
      lowBattery: true,
    },
  );
});

test("a HomeKit contact state of 0 means closed", () => {
  assert.equal(normalizeReadings({ contact: 0 }).contact, true);
});

test("readings a device didn't report stay undefined, unknown keys are dropped", () => {
  assert.deepEqual(
    normalizeReadings({ temperature: null, contact: "", bogus: 3 }),
    { temperature: undefined, contact: undefined },
  );
});

test("repeated readings keep their instance keys", () => {
  assert.deepEqual(normalizeReadings({ "temperature.2": 5, "leak.3": 1 }), {
    "temperature.2": 5,
    "leak.3": true,
  });
});

test("describeReadings names each reading, and marks further instances", () => {
  assert.equal(
    describeReadings({
      temperature: 22.4,
      humidity: 60.5,
      contact: false,
      "temperature.2": -3,
      batteryLevel: 86,
      lowBattery: false,
    }),
    "22.4 °C, 60.5 %, open, -3.0 °C (#2), battery 86 %",
  );
  assert.equal(describeReadings({}), "no values");
});

test("instance keys", () => {
  assert.equal(baseKey("temperature.2"), "temperature");
  assert.equal(baseKey("temperature"), "temperature");
  assert.equal(instanceOf("temperature.3"), 3);
  assert.equal(instanceOf("temperature"), 1);
  assert.equal(instanceKey("leak", 1), "leak");
  assert.equal(instanceKey("leak", 2), "leak.2");
});
