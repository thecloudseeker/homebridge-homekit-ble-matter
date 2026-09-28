const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  planEndpoints,
  endpointState,
  toIlluminance,
  toAirQuality,
} = require("../lib/matterMapping");

const ids = (keys) => planEndpoints(keys).map((endpoint) => endpoint.id);

test("a temperature/humidity sensor is one climate endpoint, as before", () => {
  assert.deepEqual(planEndpoints(["batteryLevel", "humidity", "temperature"]), [
    {
      id: "climate",
      group: "climate",
      instance: 1,
      label: "Climate",
      roles: { temperature: "temperature", humidity: "humidity" },
    },
  ]);
});

test("the reading a device exists for is its main endpoint", () => {
  assert.deepEqual(ids(["temperature", "smoke"]), ["alarm", "climate"]);
  assert.deepEqual(ids(["lightLevel", "motion"]), ["motion", "light"]);
  assert.deepEqual(ids(["temperature", "contact"]), ["contact", "climate"]);
});

test("an air monitor's temperature and humidity join its air quality endpoint", () => {
  assert.deepEqual(ids(["airQuality", "voc", "temperature", "humidity"]), [
    "air",
  ]);
});

test("a CO level goes with the CO alarm, or to air quality without one", () => {
  const alarm = planEndpoints(["carbonMonoxide", "carbonMonoxideLevel"]);
  assert.deepEqual(
    alarm.map((e) => e.id),
    ["alarm"],
  );
  assert.ok(alarm[0].roles.carbonMonoxideLevel);
  assert.deepEqual(ids(["carbonMonoxideLevel"]), ["air"]);
});

test("a repeated service becomes its own endpoint", () => {
  assert.deepEqual(ids(["contact", "contact.2", "temperature"]), [
    "contact",
    "climate",
    "contact2",
  ]);
});

test("motion and occupancy can't share an endpoint", () => {
  assert.deepEqual(ids(["motion", "occupancy"]), ["motion", "occupancy"]);
});

test("nothing exposable: an empty plan", () => {
  assert.deepEqual(ids(["batteryLevel", "lowBattery", "fault"]), []);
});

test("lux on Matter's logarithmic scale", () => {
  assert.equal(toIlluminance(null), null);
  assert.equal(toIlluminance(0), 0);
  assert.equal(toIlluminance(0.0001), 1);
  assert.equal(toIlluminance(1), 1);
  assert.equal(toIlluminance(1000), 30001);
  assert.equal(toIlluminance(100000), 50001);
  assert.equal(toIlluminance(1e12), 0xfffe);
});

test("HomeKit's five air quality steps map onto Matter's", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, null, 2.5].map(toAirQuality),
    [0, 1, 2, 3, 4, 5, 0, 0, 0],
  );
});

test("an update only carries what was read", () => {
  const [contact, climate] = planEndpoints(["contact", "temperature"]);
  assert.deepEqual(endpointState(contact, { temperature: 20 }), {});
  assert.deepEqual(endpointState(climate, { temperature: 20 }), {
    temperatureMeasurement: { measuredValue: 2000 },
  });
});

test("the initial state has every cluster, with safe defaults for unknown values", () => {
  const [alarm] = planEndpoints(["smoke"]);
  assert.deepEqual(endpointState(alarm, {}, { initial: true }), {
    smokeCoAlarm: {
      smokeState: 0,
      expressedState: 0,
      batteryAlert: 0,
      hardwareFaultAlert: false,
    },
  });
  const [contact] = planEndpoints(["contact"]);
  assert.deepEqual(endpointState(contact, {}, { initial: true }), {
    booleanState: { stateValue: false },
  });
});

test("the smoke alarm shows smoke over CO, and the battery warning", () => {
  const [alarm] = planEndpoints(["smoke", "carbonMonoxide"]);
  assert.deepEqual(
    endpointState(alarm, {
      smoke: true,
      carbonMonoxide: true,
      lowBattery: true,
    }),
    {
      smokeCoAlarm: {
        smokeState: 2,
        coState: 2,
        expressedState: 1,
        batteryAlert: 1,
      },
    },
  );
});
