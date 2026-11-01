const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startRealMatter } = require("./helpers/realMatter");
const { createSilentLog } = require("./helpers/fakeHap");
const { MatterSensor } = require("../lib/matterSensor");

// A Homebridge restart: the Matter server restores its cached accessories,
// then the plugin registers them again. With parts, Homebridge compares the
// cached structure to the new one - this runs both through the real thing.

const PLUGIN = "@thecloudseeker/homebridge-homekit-ble-matter";
const PLATFORM = "HomeKitBleMatter";

function build(matter, capabilities, readings) {
  return new MatterSensor(matter, createSilentLog(), {
    deviceId: "AA:BB:CC:DD:EE:77",
    name: "Hallway",
    capabilities,
    info: { manufacturer: "Test", model: "Multi" },
    readings,
  });
}

test("a device with parts survives a Homebridge restart, with its last values", async () => {
  const capabilities = [
    "batteryLevel",
    "humidity",
    "lightLevel",
    "motion",
    "temperature",
  ];
  const first = await startRealMatter();
  let second;
  try {
    const sensor = build(first.matter, capabilities);
    await first.matter.registerPlatformAccessories(
      PLUGIN,
      PLATFORM,
      sensor.toAccessories(),
    );
    sensor.markRegistered();
    await sensor.update({
      motion: true,
      lightLevel: 100,
      temperature: 20,
      humidity: 40,
      batteryLevel: 90,
    });
    await first.stop({ keep: true });

    second = await startRealMatter({ base: first.base });
    const again = build(second.matter, capabilities, {
      motion: true,
      lightLevel: 100,
      temperature: 20,
      humidity: 40,
      batteryLevel: 90,
    });
    await second.matter.registerPlatformAccessories(
      PLUGIN,
      PLATFORM,
      again.toAccessories(),
    );
    again.markRegistered();
    await again.update({ motion: false, lightLevel: 1000 });

    const state = (cluster, partId) =>
      second.matter.getAccessoryState(again.accessory.UUID, cluster, partId);
    assert.equal((await state("occupancySensing")).occupancy.occupied, false);
    assert.equal(
      (await state("illuminanceMeasurement", "light")).measuredValue,
      30001,
    );
    assert.equal(
      (await state("temperatureMeasurement", "climate")).measuredValue,
      2000,
    );
  } finally {
    await second?.stop();
  }
});

test("a temperature and humidity sensor keeps its Matter identity across a Homebridge restart", async () => {
  const capabilities = ["batteryLevel", "humidity", "temperature"];
  const readings = { temperature: 20.2, humidity: 56, batteryLevel: 55 };
  const first = await startRealMatter();
  let second;
  try {
    const sensor = build(first.matter, capabilities);
    await first.matter.registerPlatformAccessories(
      PLUGIN,
      PLATFORM,
      sensor.toAccessories(),
    );
    sensor.markRegistered();
    await sensor.update(readings);
    const before = await first.matter.getAccessoryState(
      sensor.accessory.UUID,
      "bridgedDeviceBasicInformation",
    );
    await first.stop({ keep: true });

    second = await startRealMatter({ base: first.base });
    const again = build(second.matter, capabilities, readings);
    await second.matter.registerPlatformAccessories(
      PLUGIN,
      PLATFORM,
      again.toAccessories(),
    );
    again.markRegistered();
    await again.update({ humidity: 57 });

    const state = (cluster) =>
      second.matter.getAccessoryState(again.accessory.UUID, cluster);
    assert.equal(
      (await state("bridgedDeviceBasicInformation")).uniqueId,
      before.uniqueId,
    );
    assert.equal(
      (await state("relativeHumidityMeasurement")).measuredValue,
      5700,
    );
    assert.equal((await state("temperatureMeasurement")).measuredValue, 2020);
  } finally {
    await second?.stop();
  }
});

for (const [kind, capabilities, readings, cluster, attribute, value] of [
  [
    "colour light",
    ["brightness", "colorTemperature", "hue", "lightOn", "saturation"],
    { lightOn: true, brightness: 50, hue: 120, saturation: 100 },
    "colorControl",
    "currentHue",
    85,
  ],
  [
    "blind",
    ["coverCurrent", "coverHold", "coverState", "coverTarget"],
    { coverCurrent: 40, coverTarget: 40, coverState: 2 },
    "windowCovering",
    "currentPositionLiftPercent100ths",
    6000,
  ],
  [
    "thermostat",
    ["thermostatTarget", "thermostatTargetMode", "thermostatTemperature"],
    {
      thermostatTemperature: 20,
      thermostatTargetMode: 1,
      thermostatTarget: 22,
    },
    "thermostat",
    "occupiedHeatingSetpoint",
    2200,
  ],
]) {
  test(`a ${kind} survives a Homebridge restart, with its handlers and last values`, async () => {
    const first = await startRealMatter();
    let second;
    try {
      const device = build(first.matter, capabilities, readings);
      await first.matter.registerPlatformAccessories(
        PLUGIN,
        PLATFORM,
        device.toAccessories(),
      );
      device.markRegistered();
      await first.stop({ keep: true });

      second = await startRealMatter({ base: first.base });
      const again = build(second.matter, capabilities, readings);
      await second.matter.registerPlatformAccessories(
        PLUGIN,
        PLATFORM,
        again.toAccessories(),
      );
      again.markRegistered();
      assert.equal(
        (await second.matter.getAccessoryState(again.accessory.UUID, cluster))[
          attribute
        ],
        value,
      );
      assert.ok(again.controllable);
    } finally {
      await second?.stop();
    }
  });
}
