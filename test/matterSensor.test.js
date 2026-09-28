const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createFakeMatter } = require("./helpers/fakeMatter");
const { createSilentLog } = require("./helpers/fakeHap");
const { MatterSensor, capabilitiesOf } = require("../lib/matterSensor");

const ALL = { temperature: true, humidity: true, battery: true };

function build(
  capabilities = ALL,
  info = {},
  matter = createFakeMatter(),
  readings = undefined,
) {
  const sensor = new MatterSensor(matter, createSilentLog(), {
    deviceId: "41:21:14:e5:c2:25",
    name: "Schlafzimmer",
    capabilities,
    info,
    readings,
  });
  return { sensor, matter, device: sensor.toAccessories()[0] };
}

test("a temperature+humidity sensor becomes one endpoint declared as both device types", () => {
  const { device } = build();

  assert.equal(device.parts, undefined);
  assert.equal(device.deviceType.name, "TemperatureSensor");
  assert.ok(device.deviceType.behaviors.relativeHumidityMeasurement);
  assert.deepEqual(device.clusters.descriptor.deviceTypeList, [
    { deviceType: 770, revision: 3 },
    { deviceType: 775, revision: 3 },
  ]);
  assert.ok(device.clusters.temperatureMeasurement);
  assert.ok(device.clusters.relativeHumidityMeasurement);
  assert.ok(device.clusters.powerSource);
});

test("a temperature-only sensor uses the plain TemperatureSensor type, without a humidity cluster", () => {
  const { device, matter } = build({ temperature: true });

  assert.equal(device.deviceType, matter.deviceTypes.TemperatureSensor);
  assert.equal(device.clusters.relativeHumidityMeasurement, undefined);
  assert.equal(device.clusters.descriptor, undefined);
});

test("a humidity-only sensor uses the plain HumiditySensor type", () => {
  const { device, matter } = build({ humidity: true });

  assert.equal(device.deviceType, matter.deviceTypes.HumiditySensor);
  assert.equal(device.clusters.temperatureMeasurement, undefined);
});

test("a sensor without a battery reading gets no PowerSource", () => {
  const { device } = build({ temperature: true, humidity: true });
  assert.equal(device.clusters.powerSource, undefined);
});

test("the device carries the sensor's own accessory information, trimmed to Matter's 32 characters", () => {
  const { device } = build(ALL, {
    manufacturer: "Qingping",
    model: "CGG1H",
    serialNumber: "582D34ABCDEF",
    firmwareRevision: "1.2.3",
  });

  assert.equal(device.manufacturer, "Qingping");
  assert.equal(device.model, "CGG1H");
  assert.equal(device.serialNumber, "582D34ABCDEF");
  assert.equal(device.firmwareRevision, "1.2.3");
  assert.deepEqual(device.context, { deviceId: "41:21:14:E5:C2:25" });

  const long = build(ALL, { model: "x".repeat(40) }).device;
  assert.equal(long.model.length, 32);
});

test("without accessory information it falls back to the DeviceID and generic labels", () => {
  const { device } = build();

  assert.equal(device.serialNumber, "41:21:14:E5:C2:25");
  assert.equal(device.manufacturer, "Unknown");
  assert.equal(device.model, "HomeKit BLE sensor");
});

test("the UUID depends only on the DeviceID, not its case", () => {
  const matter = createFakeMatter();
  assert.equal(
    MatterSensor.uuidFor(matter, "41:21:14:e5:c2:25"),
    MatterSensor.uuidFor(matter, "41:21:14:E5:C2:25"),
  );
});

test("update converts readings to Matter units", async () => {
  const { sensor, matter } = build();
  sensor.markRegistered();

  await sensor.update({
    temperature: 22.4,
    humidity: 60.5,
    batteryLevel: 86,
    lowBattery: false,
  });

  assert.deepEqual(
    matter.stateUpdates.map(({ cluster, attributes }) => [cluster, attributes]),
    [
      ["temperatureMeasurement", { measuredValue: 2240 }],
      ["relativeHumidityMeasurement", { measuredValue: 6050 }],
      [
        "powerSource",
        {
          batPercentRemaining: 172,
          batChargeLevel: 0,
          batReplacementNeeded: false,
        },
      ],
    ],
  );
});

test("update reports the sensor's low-battery flag as a battery warning and a replacement need", async () => {
  const { sensor, matter } = build();
  sensor.markRegistered();

  await sensor.update({ lowBattery: true });

  assert.deepEqual(matter.stateUpdates[0].attributes, {
    batChargeLevel: 1,
    batReplacementNeeded: true,
  });
});

test("the battery is declared user-replaceable", () => {
  const { device } = build();
  assert.equal(device.clusters.powerSource.batReplaceability, 2);
  assert.equal(device.clusters.powerSource.batReplacementNeeded, false);
});

test("update pushes null for readings that became unavailable, and skips ones never read", async () => {
  const { sensor, matter } = build();
  sensor.markRegistered();

  await sensor.update({ temperature: null, humidity: undefined });

  assert.deepEqual(matter.stateUpdates, [
    {
      uuid: sensor.accessory.UUID,
      cluster: "temperatureMeasurement",
      attributes: { measuredValue: null },
      partId: undefined,
    },
  ]);
});

test("update ignores readings the device doesn't have", async () => {
  const { sensor, matter } = build({ temperature: true });
  sensor.markRegistered();

  await sensor.update({ temperature: 20, humidity: 50, batteryLevel: 80 });

  assert.deepEqual(
    matter.stateUpdates.map((u) => u.cluster),
    ["temperatureMeasurement"],
  );
});

test("readings pushed before registration are held and sent, latest per cluster, once registered", async () => {
  const { sensor, matter } = build();
  await sensor.update({ temperature: 20 });
  await sensor.update({ temperature: 21, humidity: 50 });
  assert.equal(matter.stateUpdates.length, 0);

  sensor.markRegistered();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    matter.stateUpdates.map(({ cluster, attributes }) => [cluster, attributes]),
    [
      ["temperatureMeasurement", { measuredValue: 2100 }],
      ["relativeHumidityMeasurement", { measuredValue: 5000 }],
    ],
  );
});

test("nothing is pushed after registration failed", async () => {
  const { sensor, matter } = build();
  sensor.markRegistrationFailed();
  await sensor.update({ temperature: 20 });
  sensor.markRegistered();

  assert.equal(matter.stateUpdates.length, 0);
});

test("capabilitiesOf derives what a parsed database can report", () => {
  assert.deepEqual(capabilitiesOf({ temperature: {}, lowBattery: {} }), {
    temperature: true,
    humidity: false,
    battery: true,
  });
});

test("a new device starts with the last stored readings instead of unknown (Dirigera shows unknown as 100 °C)", () => {
  const { device } = build(ALL, {}, createFakeMatter(), {
    temperature: 21.6,
    humidity: 61,
    batteryLevel: 83,
    lowBattery: true,
  });
  assert.equal(device.clusters.temperatureMeasurement.measuredValue, 2160);
  assert.equal(device.clusters.relativeHumidityMeasurement.measuredValue, 6100);
  assert.equal(device.clusters.powerSource.batPercentRemaining, 166);
  assert.equal(device.clusters.powerSource.batChargeLevel, 1);
  assert.equal(device.clusters.powerSource.batReplacementNeeded, true);
});

test("setReachable pushes the bridged device's reachable flag, only when it changes", async () => {
  const { sensor, matter } = build();
  sensor.markRegistered();

  await sensor.setReachable(true);
  await sensor.setReachable(false);
  await sensor.setReachable(false);
  await sensor.setReachable(true);

  assert.deepEqual(
    matter.stateUpdates.map(({ cluster, attributes }) => [cluster, attributes]),
    [
      ["bridgedDeviceBasicInformation", { reachable: false }],
      ["bridgedDeviceBasicInformation", { reachable: true }],
    ],
  );
});
