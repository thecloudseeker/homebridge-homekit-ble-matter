// Fakes Homebridge's api.matter surface (registerPlatformAccessories,
// unregisterPlatformAccessories, updateAccessoryState, uuid.generate,
// deviceTypes) closely enough to exercise this plugin's Matter registration
// and state-push logic without a real Matter server.
//
// `registrationError`, when set, makes registerPlatformAccessories reject
// with it instead of succeeding - mirroring Homebridge's own MatterAPIImpl,
// which rejects with e.g. "Matter is not enabled for this bridge" when
// api.matter is defined only because a *different*, unrelated bridge has
// Matter configured (verified against Homebridge 2.4.0's real source).
// A stand-in for a matter.js device type: enough of its shape (name, code,
// revision, behaviors, .with()) for lib/matterSensor.js to compose a
// combined temperature/humidity type from, the way it does with Homebridge's
// real api.matter.deviceTypes.
// A stand-in for a matter.js server behavior: an id, the features chosen
// with .with(...), like the real ones.
function fakeBehavior(id, features = []) {
  return {
    id,
    features,
    with: (...chosen) => fakeBehavior(id, chosen),
  };
}

// `requirements`: {mandatory: [ClusterName], optional: [ClusterName]}, as
// matter.js exposes a device type's clusters under
// requirements.server.mandatory/optional.
function fakeDeviceType(
  name,
  deviceType,
  behaviorNames,
  { mandatory = [], optional = [] } = {},
) {
  const behaviors = Object.fromEntries(
    behaviorNames.map((behavior) => [behavior, `${name}.${behavior}`]),
  );
  const camel = (cluster) => cluster[0].toLowerCase() + cluster.slice(1);
  const requirementsOf = (list) =>
    Object.fromEntries(
      list.map((cluster) => [cluster, fakeBehavior(camel(cluster))]),
    );
  const type = {
    name,
    deviceType,
    deviceRevision: 3,
    behaviors,
    requirements: {
      server: {
        mandatory: requirementsOf(mandatory),
        optional: requirementsOf(optional),
      },
    },
    with(...added) {
      return {
        ...type,
        behaviors: {
          ...type.behaviors,
          ...Object.fromEntries(
            added.map((b) =>
              typeof b === "string" ? [b.split(".").pop(), b] : [b.id, b],
            ),
          ),
        },
      };
    },
  };
  return type;
}

const CONCENTRATIONS = [
  "CarbonMonoxideConcentrationMeasurement",
  "CarbonDioxideConcentrationMeasurement",
  "NitrogenDioxideConcentrationMeasurement",
  "OzoneConcentrationMeasurement",
  "Pm25ConcentrationMeasurement",
  "Pm10ConcentrationMeasurement",
  "TotalVolatileOrganicCompoundsConcentrationMeasurement",
];

function createFakeMatter({ registrationError } = {}) {
  // Keyed by UUID, mirroring how the real Matter server tracks accessories.
  const accessories = new Map();
  // Every updateAccessoryState call ever made, in order, so tests can assert
  // on both the latest value and the full push history (e.g. dedup, or that
  // a stale reading did not push anything).
  const stateUpdates = [];

  return {
    accessories,
    stateUpdates,
    uuid: {
      generate: (seed) => `matter-uuid:${seed}`,
    },
    deviceTypes: {
      BridgedNode: fakeDeviceType("BridgedNode", 19, []),
      TemperatureSensor: fakeDeviceType("TemperatureSensor", 770, [
        "identify",
        "temperatureMeasurement",
      ]),
      HumiditySensor: fakeDeviceType("HumiditySensor", 775, [
        "identify",
        "relativeHumidityMeasurement",
      ]),
      ContactSensor: fakeDeviceType("ContactSensor", 21, [
        "identify",
        "booleanState",
      ]),
      LeakSensor: fakeDeviceType("WaterLeakDetector", 67, [
        "identify",
        "booleanState",
      ]),
      MotionSensor: fakeDeviceType("OccupancySensor", 263, [
        "identify",
        "occupancySensing",
      ]),
      LightSensor: fakeDeviceType("LightSensor", 262, [
        "identify",
        "illuminanceMeasurement",
      ]),
      SmokeSensor: fakeDeviceType("SmokeCoAlarm", 118, ["identify"], {
        mandatory: ["SmokeCoAlarm"],
        optional: ["CarbonMonoxideConcentrationMeasurement"],
      }),
      AirQualitySensor: fakeDeviceType(
        "AirQualitySensor",
        44,
        ["identify", "airQuality"],
        {
          mandatory: ["AirQuality"],
          optional: [
            "TemperatureMeasurement",
            "RelativeHumidityMeasurement",
            ...CONCENTRATIONS,
          ],
        },
      ),
    },
    async registerPlatformAccessories(
      pluginIdentifier,
      platformName,
      accessoryList,
    ) {
      if (registrationError != null) {
        throw registrationError;
      }
      for (const accessory of accessoryList) {
        accessories.set(accessory.UUID, accessory);
      }
    },
    async unregisterPlatformAccessories(
      pluginIdentifier,
      platformName,
      accessoryList,
    ) {
      for (const accessory of accessoryList) {
        accessories.delete(accessory.UUID);
      }
    },
    async updateAccessoryState(uuid, cluster, attributes, partId) {
      stateUpdates.push({ uuid, cluster, attributes, partId });
    },
    async getAccessoryState(uuid, cluster, partId) {
      for (let i = stateUpdates.length - 1; i >= 0; i -= 1) {
        const update = stateUpdates[i];
        if (
          update.uuid === uuid &&
          update.cluster === cluster &&
          update.partId === partId
        ) {
          return update.attributes;
        }
      }
      return undefined;
    },
  };
}

module.exports = { createFakeMatter };
