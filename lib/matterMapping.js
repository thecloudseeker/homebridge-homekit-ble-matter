const { baseKey, instanceOf, instanceKey } = require("./sensorTypes");

// How a HomeKit sensor's readings (lib/sensorTypes.js) become Matter
// endpoints and attribute values.
//
// Readings are grouped into endpoints, each one Matter device type: smoke/CO
// alarm, air quality, contact, leak, motion, occupancy, light, and climate
// (temperature and/or humidity). A device with one group becomes a single
// endpoint - exactly what this plugin exposed before it knew more than
// temperature and humidity. A device with several (e.g. a motion sensor that
// also measures light) gets its first group as the main endpoint and the
// others as parts (child endpoints), since two sensors of the same kind
// can't share an endpoint. A service the device has twice ("temperature.2")
// becomes its own part.
//
// The order below is the priority for the main endpoint: the reading a
// device exists for (a smoke alarm that also reports temperature is a smoke
// alarm) comes first.

// Matter Core spec enums.
const ALARM_NORMAL = 0;
const ALARM_CRITICAL = 2;
const EXPRESSED_NORMAL = 0;
const EXPRESSED_SMOKE = 1;
const EXPRESSED_CO = 2;
const ALARM_WARNING = 1;
const AIR_QUALITY_UNKNOWN = 0;
const AIR_QUALITY_GOOD = 1;
const AIR_QUALITY_POOR = 4;
const UNIT_PPM = 0;
const UNIT_UGM3 = 4;
const MEDIUM_AIR = 0;

// Matches homebridge-plugins/homebridge-matter's TemperatureSensorAccessory
// reference bounds (-50C to 100C). Matter rejects (rather than clamps) a
// value outside the declared range, so the range is set wide.
const MIN_MEASURED_TEMPERATURE = -5000;
const MAX_MEASURED_TEMPERATURE = 10000;

// Readings → Matter attribute values.
function toTemperature(celsius) {
  return celsius == null ? null : Math.round(celsius * 100);
}

function toHumidity(percent) {
  return percent == null
    ? null
    : Math.round(Math.min(100, Math.max(0, percent)) * 100);
}

// Matter: 10000 × log10(lux) + 1, 0 = too dark to measure, null = unknown.
function toIlluminance(lux) {
  if (lux == null) {
    return null;
  }
  if (lux <= 0) {
    return 0;
  }
  return Math.min(0xfffe, Math.max(1, Math.round(10000 * Math.log10(lux) + 1)));
}

// HomeKit 0 unknown / 1 excellent / 2 good / 3 fair / 4 inferior / 5 poor
// → Matter 0 unknown / 1 good / 2 fair / 3 moderate / 4 poor / 5 very poor:
// the same five steps.
function toAirQuality(value) {
  if (value == null || !Number.isInteger(value) || value < 0 || value > 5) {
    return AIR_QUALITY_UNKNOWN;
  }
  return value;
}

// Matter's concentration measurement clusters, by reading. `requirement` is
// the matter.js server behavior's key in a device type's requirements.
const CONCENTRATIONS = {
  carbonDioxideLevel: {
    cluster: "carbonDioxideConcentrationMeasurement",
    requirement: "CarbonDioxideConcentrationMeasurement",
    unit: UNIT_PPM,
  },
  carbonMonoxideLevel: {
    cluster: "carbonMonoxideConcentrationMeasurement",
    requirement: "CarbonMonoxideConcentrationMeasurement",
    unit: UNIT_PPM,
  },
  pm25: {
    cluster: "pm25ConcentrationMeasurement",
    requirement: "Pm25ConcentrationMeasurement",
    unit: UNIT_UGM3,
  },
  pm10: {
    cluster: "pm10ConcentrationMeasurement",
    requirement: "Pm10ConcentrationMeasurement",
    unit: UNIT_UGM3,
  },
  voc: {
    cluster: "totalVolatileOrganicCompoundsConcentrationMeasurement",
    requirement: "TotalVolatileOrganicCompoundsConcentrationMeasurement",
    unit: UNIT_UGM3,
  },
  no2: {
    cluster: "nitrogenDioxideConcentrationMeasurement",
    requirement: "NitrogenDioxideConcentrationMeasurement",
    unit: UNIT_UGM3,
  },
  ozone: {
    cluster: "ozoneConcentrationMeasurement",
    requirement: "OzoneConcentrationMeasurement",
    unit: UNIT_UGM3,
  },
};

function concentrationBehavior(deviceType, role) {
  return deviceType.requirements.server.optional[
    CONCENTRATIONS[role].requirement
  ].with("NumericMeasurement");
}

function concentrationState(role, value, initial) {
  const { cluster, unit } = CONCENTRATIONS[role];
  const attributes = { measuredValue: value ?? null };
  if (initial) {
    Object.assign(attributes, {
      minMeasuredValue: null,
      maxMeasuredValue: null,
      measurementUnit: unit,
      measurementMedium: MEDIUM_AIR,
    });
  }
  return [cluster, attributes];
}

function deviceTypeEntry(type) {
  return { deviceType: type.deviceType, revision: type.deviceRevision };
}

// Climate readings on any endpoint: temperature and humidity clusters.
function climateState(has, get, initial) {
  const state = {};
  if (has("temperature") && (initial || get("temperature") !== undefined)) {
    state.temperatureMeasurement = {
      measuredValue: toTemperature(get("temperature")),
      ...(initial
        ? {
            minMeasuredValue: MIN_MEASURED_TEMPERATURE,
            maxMeasuredValue: MAX_MEASURED_TEMPERATURE,
          }
        : {}),
    };
  }
  if (has("humidity") && (initial || get("humidity") !== undefined)) {
    state.relativeHumidityMeasurement = {
      measuredValue: toHumidity(get("humidity")),
      ...(initial ? { minMeasuredValue: 0, maxMeasuredValue: 10000 } : {}),
    };
  }
  return state;
}

// A boolean reading pushed as one attribute; skipped until it's known.
function booleanState(cluster, build) {
  return (has, get, initial, role) => {
    const value = get(role);
    if (value === undefined || value === null) {
      return initial ? { [cluster]: build(false) } : {};
    }
    return { [cluster]: build(Boolean(value)) };
  };
}

const GROUPS = [
  {
    id: "alarm",
    label: "Alarm",
    roles: ["smoke", "carbonMonoxide", "carbonMonoxideLevel"],
    triggers: ["smoke", "carbonMonoxide"],
    deviceType(types, has) {
      const { SmokeSensor } = types;
      return has("carbonMonoxideLevel")
        ? SmokeSensor.with(
            concentrationBehavior(SmokeSensor, "carbonMonoxideLevel"),
          )
        : SmokeSensor;
    },
    // Homebridge picks the SmokeAlarm/CoAlarm features from which of
    // smokeState/coState are declared, so they're only declared when read.
    state(has, get, initial, device) {
      const state = {};
      const alarm = {};
      const smoke = get("smoke");
      const co = get("carbonMonoxide");
      if (has("smoke") && (initial || smoke !== undefined)) {
        alarm.smokeState = smoke ? ALARM_CRITICAL : ALARM_NORMAL;
      }
      if (has("carbonMonoxide") && (initial || co !== undefined)) {
        alarm.coState = co ? ALARM_CRITICAL : ALARM_NORMAL;
      }
      if (initial || smoke !== undefined || co !== undefined) {
        alarm.expressedState = smoke
          ? EXPRESSED_SMOKE
          : co
            ? EXPRESSED_CO
            : EXPRESSED_NORMAL;
      }
      if (device.lowBattery !== undefined || initial) {
        alarm.batteryAlert = device.lowBattery ? ALARM_WARNING : ALARM_NORMAL;
      }
      if (device.fault !== undefined || initial) {
        alarm.hardwareFaultAlert = Boolean(device.fault);
      }
      if (Object.keys(alarm).length > 0) {
        state.smokeCoAlarm = alarm;
      }
      const level = get("carbonMonoxideLevel");
      if (has("carbonMonoxideLevel") && (initial || level !== undefined)) {
        const [cluster, attributes] = concentrationState(
          "carbonMonoxideLevel",
          level,
          initial,
        );
        state[cluster] = attributes;
      }
      return state;
    },
  },
  {
    id: "air",
    label: "Air quality",
    roles: [
      "airQuality",
      "carbonDioxide",
      "carbonDioxideLevel",
      "carbonMonoxideLevel",
      "pm25",
      "pm10",
      "voc",
      "no2",
      "ozone",
      // An air monitor's own temperature/humidity go on the same device.
      "temperature",
      "humidity",
    ],
    triggers: [
      "airQuality",
      "carbonDioxide",
      "carbonDioxideLevel",
      "carbonMonoxideLevel",
      "pm25",
      "pm10",
      "voc",
      "no2",
      "ozone",
    ],
    deviceType(types, has) {
      const { AirQualitySensor } = types;
      const { mandatory, optional } = AirQualitySensor.requirements.server;
      // Without these features the AirQuality cluster only knows unknown,
      // good and poor.
      const behaviors = [
        mandatory.AirQuality.with(
          "Fair",
          "Moderate",
          "VeryPoor",
          "ExtremelyPoor",
        ),
      ];
      for (const role of Object.keys(CONCENTRATIONS)) {
        if (has(role)) {
          behaviors.push(concentrationBehavior(AirQualitySensor, role));
        }
      }
      if (has("temperature")) {
        behaviors.push(optional.TemperatureMeasurement);
      }
      if (has("humidity")) {
        behaviors.push(optional.RelativeHumidityMeasurement);
      }
      return AirQualitySensor.with(...behaviors);
    },
    descriptor(types, has) {
      const list = [deviceTypeEntry(types.AirQualitySensor)];
      if (has("temperature")) {
        list.push(deviceTypeEntry(types.TemperatureSensor));
      }
      if (has("humidity")) {
        list.push(deviceTypeEntry(types.HumiditySensor));
      }
      return list.length > 1 ? list : null;
    },
    // Air quality itself: the device's own rating, or - for a device that
    // only tells whether its CO2 is abnormal - good/poor from that.
    state(has, get, initial) {
      const state = {};
      const rating = get("airQuality");
      const co2Abnormal = get("carbonDioxide");
      if (has("airQuality")) {
        if (initial || rating !== undefined) {
          state.airQuality = { airQuality: toAirQuality(rating) };
        }
      } else if (has("carbonDioxide")) {
        if (initial || co2Abnormal !== undefined) {
          state.airQuality = {
            airQuality:
              co2Abnormal == null
                ? AIR_QUALITY_UNKNOWN
                : co2Abnormal
                  ? AIR_QUALITY_POOR
                  : AIR_QUALITY_GOOD,
          };
        }
      } else if (initial) {
        state.airQuality = { airQuality: AIR_QUALITY_UNKNOWN };
      }
      for (const role of Object.keys(CONCENTRATIONS)) {
        const value = get(role);
        if (has(role) && (initial || value !== undefined)) {
          const [cluster, attributes] = concentrationState(
            role,
            value,
            initial,
          );
          state[cluster] = attributes;
        }
      }
      Object.assign(state, climateState(has, get, initial));
      return state;
    },
  },
  {
    id: "contact",
    label: "Contact",
    roles: ["contact"],
    deviceType: (types) => types.ContactSensor,
    // Matter's BooleanState for a contact sensor: true = contact (closed).
    state: (has, get, initial) =>
      booleanState("booleanState", (value) => ({ stateValue: value }))(
        has,
        get,
        initial,
        "contact",
      ),
  },
  {
    id: "leak",
    label: "Leak",
    roles: ["leak"],
    deviceType: (types) => types.LeakSensor,
    state: (has, get, initial) =>
      booleanState("booleanState", (value) => ({ stateValue: value }))(
        has,
        get,
        initial,
        "leak",
      ),
  },
  {
    id: "motion",
    label: "Motion",
    roles: ["motion"],
    deviceType: (types) => types.MotionSensor,
    state: (has, get, initial) =>
      booleanState("occupancySensing", (value) => ({
        occupancy: { occupied: value },
      }))(has, get, initial, "motion"),
  },
  {
    id: "occupancy",
    label: "Occupancy",
    roles: ["occupancy"],
    deviceType: (types) => types.MotionSensor,
    state: (has, get, initial) =>
      booleanState("occupancySensing", (value) => ({
        occupancy: { occupied: value },
      }))(has, get, initial, "occupancy"),
  },
  {
    id: "light",
    label: "Light",
    roles: ["lightLevel"],
    deviceType: (types) => types.LightSensor,
    state(has, get, initial) {
      const lux = get("lightLevel");
      if (!initial && lux === undefined) {
        return {};
      }
      return { illuminanceMeasurement: { measuredValue: toIlluminance(lux) } };
    },
  },
  {
    id: "climate",
    label: "Climate",
    roles: ["temperature", "humidity"],
    // A sensor measuring both: one endpoint declared as both device types
    // (TemperatureSensor plus the HumiditySensor's measurement behavior), as
    // IKEA Dirigera lists every sensor endpoint as its own product.
    deviceType(types, has) {
      const { TemperatureSensor, HumiditySensor } = types;
      if (has("temperature") && has("humidity")) {
        return TemperatureSensor.with(
          HumiditySensor.behaviors.relativeHumidityMeasurement,
        );
      }
      return has("humidity") ? HumiditySensor : TemperatureSensor;
    },
    descriptor(types, has) {
      return has("temperature") && has("humidity")
        ? [
            deviceTypeEntry(types.TemperatureSensor),
            deviceTypeEntry(types.HumiditySensor),
          ]
        : null;
    },
    state: climateState,
  },
];

// The endpoints for a device reporting `keys` (reading keys, possibly with
// instance suffixes): [{id, group, instance, label, roles: {role → key}}],
// main endpoint first. Empty if nothing it reports can be exposed.
function planEndpoints(keys) {
  const byInstance = new Map();
  for (const key of keys) {
    const instance = instanceOf(key);
    if (!byInstance.has(instance)) {
      byInstance.set(instance, new Set());
    }
    byInstance.get(instance).add(baseKey(key));
  }
  const plan = [];
  for (const instance of [...byInstance.keys()].sort((a, b) => a - b)) {
    const available = byInstance.get(instance);
    for (const group of GROUPS) {
      const triggers = group.triggers ?? group.roles;
      if (!triggers.some((role) => available.has(role))) {
        continue;
      }
      const roles = {};
      for (const role of group.roles) {
        if (available.has(role)) {
          roles[role] = instanceKey(role, instance);
          available.delete(role);
        }
      }
      plan.push({
        id: instance > 1 ? `${group.id}${instance}` : group.id,
        group: group.id,
        instance,
        label: instance > 1 ? `${group.label} ${instance}` : group.label,
        roles,
      });
    }
  }
  return plan;
}

function groupOf(endpoint) {
  return GROUPS.find((group) => group.id === endpoint.group);
}

// The Matter device type and descriptor for one planned endpoint.
function endpointType(types, endpoint) {
  const group = groupOf(endpoint);
  const has = (role) => endpoint.roles[role] != null;
  return {
    deviceType: group.deviceType(types, has),
    descriptor: group.descriptor?.(types, has) ?? null,
  };
}

// Cluster attributes for one endpoint from `readings`. `initial`: the full
// state to register with (unknown values as null or their default);
// otherwise only what `readings` carries.
function endpointState(endpoint, readings, { initial = false } = {}) {
  const group = groupOf(endpoint);
  const has = (role) => endpoint.roles[role] != null;
  const get = (role) =>
    has(role) ? (readings ?? {})[endpoint.roles[role]] : undefined;
  const device = {
    lowBattery: readings?.lowBattery,
    fault: readings?.fault,
  };
  return group.state(has, get, initial, device);
}

module.exports = {
  planEndpoints,
  endpointType,
  endpointState,
  toTemperature,
  toHumidity,
  toIlluminance,
  toAirQuality,
  GROUPS,
};
