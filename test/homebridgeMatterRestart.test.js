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
