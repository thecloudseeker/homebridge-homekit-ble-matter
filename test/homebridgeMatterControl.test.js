const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startRealMatter } = require("./helpers/realMatter");
const { createSilentLog } = require("./helpers/fakeHap");
const { MatterSensor } = require("../lib/matterSensor");

// Every kind of controllable device, registered on Homebridge's real Matter
// server: matter.js validates the device type, the features Homebridge
// derives from the attributes and handlers, and every attribute value. The
// command handlers are then called as Homebridge would, and what they'd set
// on the HomeKit device is recorded.

let real;
before(async () => {
  real = await startRealMatter();
});
after(async () => {
  await real?.stop();
});

let counter = 0;

async function expose(capabilities, { initial, update } = {}) {
  counter += 1;
  const writes = [];
  const sensor = new MatterSensor(real.matter, createSilentLog(), {
    deviceId: `AA:BB:CC:DD:EF:${String(counter).padStart(2, "0")}`,
    name: `Device ${counter}`,
    capabilities,
    info: { manufacturer: "Test", model: "Control" },
    readings: initial,
    // As on a real device: the write is accepted, and the device then
    // reports its new state.
    write: async (values) => {
      writes.push(values);
      await sensor.update(values);
    },
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
  const handler = (cluster, command) =>
    sensor.accessory.handlers?.[cluster]?.[command];
  return { sensor, state, writes, handler };
}

test("outlet: on/off both ways", async () => {
  const { state, writes, handler, sensor } = await expose(
    ["outletInUse", "outletOn"],
    { initial: { outletOn: false }, update: { outletOn: true } },
  );
  assert.equal(sensor.controllable, true);
  assert.equal((await state("onOff")).onOff, true);
  await handler("onOff", "off")();
  await handler("onOff", "toggle")();
  assert.deepEqual(writes, [{ outletOn: false }, { outletOn: true }]);
});

test("switch: a plug-in unit, not a wall switch", async () => {
  const { state, writes, handler } = await expose(["switchOn"], {
    initial: { switchOn: true },
  });
  assert.equal((await state("onOff")).onOff, true);
  await handler("onOff", "on")(); // already on: nothing to write
  await handler("onOff", "off")();
  assert.deepEqual(writes, [{ switchOn: false }]);
});

test("on/off light", async () => {
  const { state } = await expose(["lightOn"], {
    initial: { lightOn: false },
    update: { lightOn: true },
  });
  assert.equal((await state("onOff")).onOff, true);
});

test("dimmable light: brightness ↔ level, level with on/off", async () => {
  const { state, writes, handler } = await expose(["brightness", "lightOn"], {
    initial: { lightOn: true, brightness: 40 },
    update: { brightness: 100 },
  });
  assert.equal((await state("levelControl")).currentLevel, 254);
  await handler("levelControl", "moveToLevel")({ level: 127 });
  await handler("levelControl", "moveToLevelWithOnOff")({ level: 1 });
  assert.deepEqual(writes, [
    { brightness: 50 },
    { brightness: 0, lightOn: false },
  ]);
});

test("colour temperature light", async () => {
  const { state, writes, handler } = await expose(
    ["brightness", "colorTemperature", "lightOn"],
    {
      initial: { lightOn: true, brightness: 80, colorTemperature: 300 },
      update: { colorTemperature: 450 },
    },
  );
  assert.equal((await state("colorControl")).colorTemperatureMireds, 450);
  await handler(
    "colorControl",
    "moveToColorTemperatureLogic",
  )({
    colorTemperatureMireds: 250,
    transitionTime: 0,
  });
  assert.deepEqual(writes, [{ colorTemperature: 250 }]);
});

test("colour light: hue and saturation, and xy converted to them", async () => {
  const { state, writes, handler } = await expose(
    ["brightness", "colorTemperature", "hue", "lightOn", "saturation"],
    {
      initial: { lightOn: true, brightness: 100, hue: 0, saturation: 0 },
      update: { hue: 120, saturation: 100 },
    },
  );
  const color = await state("colorControl");
  assert.equal(color.currentHue, 85);
  assert.equal(color.currentSaturation, 254);
  await handler(
    "colorControl",
    "moveToHueAndSaturationLogic",
  )({
    hue: 254,
    saturation: 127,
    transitionTime: 0,
  });
  // Pure red in xy (sRGB's red primary).
  await handler(
    "colorControl",
    "moveToColorLogic",
  )({
    targetX: Math.round(0.64 * 65536),
    targetY: Math.round(0.33 * 65536),
    transitionTime: 0,
  });
  assert.deepEqual(writes[0], { hue: 360, saturation: 50 });
  assert.ok(
    writes[1].hue <= 2 || writes[1].hue >= 358,
    `red, not ${writes[1].hue}°`,
  );
  assert.ok(writes[1].saturation >= 98);
});

test("lock: locked, jammed, and lock/unlock commands", async () => {
  const { state, writes, handler } = await expose(
    ["lockCurrent", "lockTarget"],
    {
      initial: { lockCurrent: 1, lockTarget: 1 },
    },
  );
  assert.equal((await state("doorLock")).lockState, 1);
  const { sensor } = await expose(["lockCurrent", "lockTarget"], {
    initial: { lockCurrent: 2, lockTarget: 1 },
  });
  assert.equal(
    (await real.matter.getAccessoryState(sensor.accessory.UUID, "doorLock"))
      .lockState,
    0,
  );
  await handler("doorLock", "unlockDoor")({});
  await handler("doorLock", "lockDoor")({});
  assert.deepEqual(writes, [{ lockTarget: 0 }, { lockTarget: 1 }]);
});

test("blind: HomeKit's open percentage as Matter's closed one, and every command", async () => {
  const { state, writes, handler } = await expose(
    ["coverCurrent", "coverHold", "coverState", "coverTarget"],
    {
      initial: { coverCurrent: 100, coverTarget: 100, coverState: 2 },
      update: { coverCurrent: 25, coverTarget: 0, coverState: 0 },
    },
  );
  const cover = await state("windowCovering");
  assert.equal(cover.currentPositionLiftPercent100ths, 7500);
  assert.equal(cover.targetPositionLiftPercent100ths, 10000);
  assert.equal(cover.operationalStatus.global, 2);
  await handler(
    "windowCovering",
    "goToLiftPercentage",
  )({
    liftPercent100thsValue: 3000,
  });
  await handler("windowCovering", "upOrOpen")();
  await handler("windowCovering", "downOrClose")();
  await handler("windowCovering", "stopMotion")();
  assert.deepEqual(writes, [
    { coverTarget: 70 },
    { coverTarget: 100 },
    { coverTarget: 0 },
    { coverHold: true },
  ]);
});

test("fan with speed: mode and percentage", async () => {
  const { state, writes, handler } = await expose(["fanActive", "fanSpeed"], {
    initial: { fanActive: false, fanSpeed: 0 },
    update: { fanActive: true, fanSpeed: 50 },
  });
  const fan = await state("fanControl");
  assert.equal(fan.percentSetting, 50);
  assert.equal(fan.fanMode, 2);
  await handler("fanControl", "percentSettingChange")({ percentSetting: 80 });
  await handler("fanControl", "fanModeChange")({ fanMode: 0 });
  await handler("fanControl", "fanModeChange")({ fanMode: 1 });
  // Already running: only the speed changes.
  assert.deepEqual(writes, [
    { fanSpeed: 80 },
    { fanActive: false },
    { fanActive: true, fanSpeed: 33 },
  ]);
});

test("fan without speed (HomeKit's older fan service)", async () => {
  const { state } = await expose(["fanOn"], { initial: { fanOn: true } });
  assert.equal((await state("fanControl")).fanMode, 3);
});

test("thermostat: one target temperature, or thresholds in auto", async () => {
  const { state, writes, handler } = await expose(
    [
      "thermostatCoolingThreshold",
      "thermostatCurrentMode",
      "thermostatHeatingThreshold",
      "thermostatTarget",
      "thermostatTargetMode",
      "thermostatTemperature",
    ],
    {
      initial: {
        thermostatTemperature: 19.5,
        thermostatTargetMode: 1,
        thermostatTarget: 21,
        thermostatHeatingThreshold: 18,
        thermostatCoolingThreshold: 25,
      },
    },
  );
  let thermostat = await state("thermostat");
  assert.equal(thermostat.localTemperature, 1950);
  assert.equal(thermostat.systemMode, 4);
  assert.equal(thermostat.occupiedHeatingSetpoint, 2100);
  await handler(
    "thermostat",
    "occupiedHeatingSetpointChange",
  )({
    occupiedHeatingSetpoint: 2250,
  });
  await handler("thermostat", "systemModeChange")({ systemMode: 1 });

  const { sensor } = await expose(
    [
      "thermostatCoolingThreshold",
      "thermostatHeatingThreshold",
      "thermostatTarget",
      "thermostatTargetMode",
      "thermostatTemperature",
    ],
    {
      initial: {
        thermostatTemperature: 22,
        thermostatTargetMode: 3,
        thermostatTarget: 21,
        thermostatHeatingThreshold: 18,
        thermostatCoolingThreshold: 25,
      },
      update: { thermostatCoolingThreshold: 26 },
    },
  );
  thermostat = await real.matter.getAccessoryState(
    sensor.accessory.UUID,
    "thermostat",
  );
  assert.equal(thermostat.systemMode, 1);
  assert.equal(thermostat.occupiedHeatingSetpoint, 1800);
  assert.equal(thermostat.occupiedCoolingSetpoint, 2600);
  assert.deepEqual(writes, [
    { thermostatTarget: 22.5 },
    { thermostatTargetMode: 3 },
  ]);
});

test("air conditioner (heater/cooler): on/off, modes and thresholds", async () => {
  const { state, writes, handler } = await expose(
    [
      "heaterCoolerActive",
      "heaterCoolerCoolingThreshold",
      "heaterCoolerCurrentMode",
      "heaterCoolerHeatingThreshold",
      "heaterCoolerTargetMode",
      "heaterCoolerTemperature",
    ],
    {
      initial: {
        heaterCoolerActive: true,
        heaterCoolerTemperature: 24,
        heaterCoolerTargetMode: 2,
        heaterCoolerHeatingThreshold: 20,
        heaterCoolerCoolingThreshold: 23,
      },
    },
  );
  const thermostat = await state("thermostat");
  assert.equal(thermostat.systemMode, 3);
  assert.equal(thermostat.occupiedCoolingSetpoint, 2300);
  assert.equal((await state("onOff")).onOff, true);
  await handler("thermostat", "systemModeChange")({ systemMode: 4 });
  await handler("onOff", "off")();
  await handler(
    "thermostat",
    "occupiedCoolingSetpointChange",
  )({
    occupiedCoolingSetpoint: 2200,
  });
  assert.deepEqual(writes, [
    { heaterCoolerTargetMode: 1 }, // already on
    { heaterCoolerActive: false },
    { heaterCoolerCoolingThreshold: 22 },
  ]);
});

test("cooling-only air conditioner", async () => {
  const { state } = await expose(
    [
      "heaterCoolerActive",
      "heaterCoolerCoolingThreshold",
      "heaterCoolerTargetMode",
      "heaterCoolerTemperature",
    ],
    {
      initial: {
        heaterCoolerActive: false,
        heaterCoolerTemperature: 26,
        heaterCoolerTargetMode: 2,
        heaterCoolerCoolingThreshold: 22,
      },
    },
  );
  assert.equal((await state("thermostat")).systemMode, 0);
});

test("valve: open and close", async () => {
  const { state, writes, handler } = await expose(
    ["valveActive", "valveInUse"],
    {
      initial: { valveActive: false },
      update: { valveActive: true },
    },
  );
  assert.equal((await state("valveConfigurationAndControl")).currentState, 1);
  await handler("valveConfigurationAndControl", "close")({});
  assert.deepEqual(writes, [{ valveActive: false }]);
});

test("a light that also has a battery and a temperature sensor: the light is the main endpoint", async () => {
  const { sensor } = await expose(["batteryLevel", "lightOn", "temperature"], {
    initial: { lightOn: true, temperature: 20, batteryLevel: 90 },
  });
  assert.equal(sensor.plan[0].group, "lightbulb");
  assert.equal(sensor.accessory.parts.length, 1);
});
