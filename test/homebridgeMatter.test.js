const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startRealMatter } = require("./helpers/realMatter");
const { createSilentLog } = require("./helpers/fakeHap");
const { MatterSensor } = require("../lib/matterSensor");

// Every kind of sensor this plugin exposes, registered on Homebridge's real
// Matter server and updated with readings, which are then read back from
// matter.js. This is where a device type, a feature-gated cluster or an
// attribute value that Homebridge or matter.js would reject shows up.

let real;
before(async () => {
  real = await startRealMatter();
});
after(async () => {
  await real?.stop();
});

let counter = 0;

// Registers a device reporting `capabilities` (reading keys), starting from
// `initial` readings, pushes `update`, and returns a reader for its state.
async function expose(capabilities, { initial, update } = {}) {
  counter += 1;
  const sensor = new MatterSensor(real.matter, createSilentLog(), {
    deviceId: `AA:BB:CC:DD:EE:${String(counter).padStart(2, "0")}`,
    name: `Sensor ${counter}`,
    capabilities,
    info: { manufacturer: "Test", model: "Kind" },
    readings: initial,
  });
  await real.matter.registerPlatformAccessories(
    "@thecloudseeker/homebridge-homekit-ble-matter",
    "HomeKitBleMatter",
    sensor.toAccessories(),
  );
  sensor.markRegistered();
  if (update != null) {
    await sensor.update(update);
  }
  const state = (cluster, partId) =>
    real.matter.getAccessoryState(sensor.accessory.UUID, cluster, partId);
  return { sensor, state };
}

test("CGG1H: temperature + humidity + battery on one endpoint", async () => {
  const { state, sensor } = await expose(
    ["batteryLevel", "humidity", "lowBattery", "temperature"],
    {
      initial: { temperature: 21.8, humidity: 68, batteryLevel: 81 },
      update: {
        temperature: 22.4,
        humidity: 60.5,
        batteryLevel: 80,
        lowBattery: false,
      },
    },
  );
  assert.equal(sensor.accessory.parts, undefined);
  assert.equal((await state("temperatureMeasurement")).measuredValue, 2240);
  assert.equal(
    (await state("relativeHumidityMeasurement")).measuredValue,
    6050,
  );
  assert.equal((await state("powerSource")).batPercentRemaining, 160);
});

test("contact sensor: closed is Matter's contact (true), open false", async () => {
  const { state } = await expose(["contact", "lowBattery"], {
    update: { contact: true },
  });
  assert.equal((await state("booleanState")).stateValue, true);
});

test("leak sensor", async () => {
  const { state } = await expose(["leak"], { update: { leak: true } });
  assert.equal((await state("booleanState")).stateValue, true);
});

test("motion sensor", async () => {
  const { state } = await expose(["motion"], { update: { motion: true } });
  assert.equal((await state("occupancySensing")).occupancy.occupied, true);
});

test("occupancy sensor", async () => {
  const { state } = await expose(["occupancy"], {
    initial: { occupancy: false },
    update: { occupancy: true },
  });
  assert.equal((await state("occupancySensing")).occupancy.occupied, true);
});

test("light sensor: lux in Matter's logarithmic scale", async () => {
  const { state } = await expose(["lightLevel"], {
    update: { lightLevel: 1000 },
  });
  assert.equal((await state("illuminanceMeasurement")).measuredValue, 30001);
});

test("motion + light: motion is the device, light a part of it", async () => {
  const { state, sensor } = await expose(
    ["batteryLevel", "lightLevel", "motion"],
    {
      update: { motion: false, lightLevel: 10, batteryLevel: 50 },
    },
  );
  assert.deepEqual(
    sensor.accessory.parts.map((part) => part.id),
    ["light"],
  );
  assert.equal((await state("occupancySensing")).occupancy.occupied, false);
  assert.equal(
    (await state("illuminanceMeasurement", "light")).measuredValue,
    10001,
  );
  assert.equal((await state("powerSource")).batPercentRemaining, 100);
});

test("smoke + CO alarm with CO level, temperature as a part", async () => {
  const { state, sensor } = await expose(
    [
      "carbonMonoxide",
      "carbonMonoxideLevel",
      "fault",
      "lowBattery",
      "smoke",
      "temperature",
    ],
    {
      update: {
        smoke: false,
        carbonMonoxide: true,
        carbonMonoxideLevel: 45,
        lowBattery: true,
        fault: false,
        temperature: 23,
      },
    },
  );
  const alarm = await state("smokeCoAlarm");
  assert.equal(alarm.smokeState, 0);
  assert.equal(alarm.coState, 2);
  assert.equal(alarm.expressedState, 2);
  assert.equal(alarm.batteryAlert, 1);
  assert.equal(
    (await state("carbonMonoxideConcentrationMeasurement")).measuredValue,
    45,
  );
  assert.deepEqual(
    sensor.accessory.parts.map((part) => part.id),
    ["climate"],
  );
  assert.equal(
    (await state("temperatureMeasurement", "climate")).measuredValue,
    2300,
  );
});

test("smoke-only alarm", async () => {
  const { state } = await expose(["smoke"], { update: { smoke: true } });
  const alarm = await state("smokeCoAlarm");
  assert.equal(alarm.smokeState, 2);
  assert.equal(alarm.expressedState, 1);
});

test("air quality monitor with every concentration, temperature and humidity on one endpoint", async () => {
  const readings = {
    airQuality: 3,
    carbonDioxide: false,
    carbonDioxideLevel: 812,
    pm25: 12,
    pm10: 20,
    voc: 150,
    no2: 8,
    ozone: 30,
    temperature: 21.5,
    humidity: 45,
  };
  const { state, sensor } = await expose(Object.keys(readings), {
    initial: readings,
    update: { ...readings, airQuality: 5, carbonDioxideLevel: 1300 },
  });
  assert.equal(sensor.accessory.parts, undefined);
  assert.equal((await state("airQuality")).airQuality, 5);
  assert.equal(
    (await state("carbonDioxideConcentrationMeasurement")).measuredValue,
    1300,
  );
  assert.equal((await state("pm25ConcentrationMeasurement")).measuredValue, 12);
  assert.equal((await state("pm10ConcentrationMeasurement")).measuredValue, 20);
  assert.equal(
    (await state("totalVolatileOrganicCompoundsConcentrationMeasurement"))
      .measuredValue,
    150,
  );
  assert.equal(
    (await state("nitrogenDioxideConcentrationMeasurement")).measuredValue,
    8,
  );
  assert.equal(
    (await state("ozoneConcentrationMeasurement")).measuredValue,
    30,
  );
  assert.equal((await state("temperatureMeasurement")).measuredValue, 2150);
  assert.equal(
    (await state("relativeHumidityMeasurement")).measuredValue,
    4500,
  );
});

test("a CO2 sensor without an air quality rating gets good/poor from its 'abnormal' flag", async () => {
  const { state } = await expose(["carbonDioxide", "carbonDioxideLevel"], {
    update: { carbonDioxide: true, carbonDioxideLevel: 2100 },
  });
  assert.equal((await state("airQuality")).airQuality, 4);
  assert.equal(
    (await state("carbonDioxideConcentrationMeasurement")).measuredValue,
    2100,
  );
});

test("a device with two temperature sensors: the second is a part", async () => {
  const { state, sensor } = await expose(["temperature", "temperature.2"], {
    update: { temperature: 20, "temperature.2": -5.5 },
  });
  assert.deepEqual(
    sensor.accessory.parts.map((part) => part.id),
    ["climate2"],
  );
  assert.equal((await state("temperatureMeasurement")).measuredValue, 2000);
  assert.equal(
    (await state("temperatureMeasurement", "climate2")).measuredValue,
    -550,
  );
});

test("a registration from cached readings of an older version (missing keys) is accepted", async () => {
  await expose(["contact", "humidity", "leak", "lightLevel", "temperature"], {
    initial: { temperature: 20 },
  });
});

test("a part with temperature and humidity keeps both device types", async () => {
  const { state, sensor } = await expose(
    ["contact", "humidity", "temperature"],
    {
      update: { contact: false, temperature: 19, humidity: 55 },
    },
  );
  const [part] = sensor.accessory.parts;
  assert.equal(part.id, "climate");
  assert.equal(part.clusters.descriptor.deviceTypeList.length, 2);
  assert.equal((await state("booleanState")).stateValue, false);
  assert.equal(
    (await state("relativeHumidityMeasurement", "climate")).measuredValue,
    5500,
  );
});

test("several sensors registered together stay separate devices with their own values", async () => {
  const make = (name, capabilities, readings) => {
    counter += 1;
    return new MatterSensor(real.matter, createSilentLog(), {
      deviceId: `AA:BB:CC:DD:EE:${String(counter).padStart(2, "0")}`,
      name,
      capabilities,
      info: { manufacturer: "Test", model: "Kind" },
      readings,
    });
  };
  const bedroom = make("Bedroom", ["humidity", "temperature"], {
    temperature: 20,
    humidity: 50,
  });
  const door = make("Front door", ["batteryLevel", "contact"], {
    contact: true,
    batteryLevel: 90,
  });
  const hallway = make("Hallway", ["lightLevel", "motion"], {
    motion: false,
    lightLevel: 100,
  });
  await real.matter.registerPlatformAccessories(
    "@thecloudseeker/homebridge-homekit-ble-matter",
    "HomeKitBleMatter",
    [bedroom, door, hallway].flatMap((sensor) => sensor.toAccessories()),
  );
  for (const sensor of [bedroom, door, hallway]) {
    sensor.markRegistered();
  }
  await Promise.all([
    bedroom.update({ temperature: 18.5, humidity: 61 }),
    door.update({ contact: false, batteryLevel: 89 }),
    hallway.update({ motion: true, lightLevel: 1000 }),
  ]);
  const state = (sensor, cluster, partId) =>
    real.matter.getAccessoryState(sensor.accessory.UUID, cluster, partId);

  assert.equal(
    (await state(bedroom, "temperatureMeasurement")).measuredValue,
    1850,
  );
  assert.equal((await state(door, "booleanState")).stateValue, false);
  assert.equal((await state(door, "powerSource")).batPercentRemaining, 178);
  assert.equal(
    (await state(hallway, "occupancySensing")).occupancy.occupied,
    true,
  );
  assert.equal(
    (await state(hallway, "illuminanceMeasurement", "light")).measuredValue,
    30001,
  );

  // One going unreachable leaves the others reachable.
  await door.setReachable(false);
  const reachable = async (sensor) =>
    (await state(sensor, "bridgedDeviceBasicInformation")).reachable;
  assert.deepEqual(
    [await reachable(bedroom), await reachable(door), await reachable(hallway)],
    [true, false, true],
  );
});
