// What this plugin can read from a HomeKit sensor: one entry per HomeKit
// characteristic, keyed by the name the rest of the plugin uses for the
// reading. `hap` is the characteristic's name as hap-controller reports it
// (characteristicFromUuid), `parse` turns the raw HAP value into a plain
// number/boolean, and `describe` formats it for the log.
//
// A device can have a service more than once (e.g. two temperature sensors):
// the first occurrence of a characteristic is stored under its plain key, the
// next under "key.2", "key.3", ... (see instanceKey). Only the `perDevice`
// readings - the battery - are taken once per device.

const number = (value) =>
  value == null || value === "" || Number.isNaN(Number(value))
    ? undefined
    : Number(value);
// HomeKit flags are 0/1 numbers (booleans on some devices).
const flag = (value) =>
  value == null || value === "" ? undefined : Number(value) === 1;
const round = (value, digits = 0) => Number(value.toFixed(digits));

const yesNo = (label, onText, offText) => (value) =>
  `${label} ${value ? onText : offText}`;
const withUnit =
  (unit, digits = 0) =>
  (value) =>
    `${round(value, digits)} ${unit}`;

const READINGS = {
  temperature: {
    hap: "public.hap.characteristic.temperature.current",
    parse: number,
    describe: (value) => `${value.toFixed(1)} °C`,
  },
  humidity: {
    hap: "public.hap.characteristic.relative-humidity.current",
    parse: number,
    describe: (value) => `${value.toFixed(1)} %`,
  },
  contact: {
    // HomeKit: 0 = contact detected (closed), 1 = not detected (open).
    hap: "public.hap.characteristic.contact-state",
    parse: (value) =>
      number(value) === undefined ? undefined : Number(value) === 0,
    describe: (closed) => (closed ? "closed" : "open"),
  },
  motion: {
    hap: "public.hap.characteristic.motion-detected",
    parse: flag,
    describe: yesNo("motion", "detected", "none"),
  },
  occupancy: {
    hap: "public.hap.characteristic.occupancy-detected",
    parse: flag,
    describe: yesNo("occupancy", "detected", "none"),
  },
  leak: {
    hap: "public.hap.characteristic.leak-detected",
    parse: flag,
    describe: yesNo("leak", "DETECTED", "none"),
  },
  smoke: {
    hap: "public.hap.characteristic.smoke-detected",
    parse: flag,
    describe: yesNo("smoke", "DETECTED", "none"),
  },
  carbonMonoxide: {
    hap: "public.hap.characteristic.carbon-monoxide.detected",
    parse: flag,
    describe: yesNo("CO", "DETECTED", "normal"),
  },
  carbonMonoxideLevel: {
    hap: "public.hap.characteristic.carbon-monoxide.level",
    parse: number,
    describe: withUnit("ppm CO", 1),
  },
  carbonDioxide: {
    hap: "public.hap.characteristic.carbon-dioxide.detected",
    parse: flag,
    describe: yesNo("CO₂", "abnormal", "normal"),
  },
  carbonDioxideLevel: {
    hap: "public.hap.characteristic.carbon-dioxide.level",
    parse: number,
    describe: withUnit("ppm CO₂"),
  },
  airQuality: {
    // 0 unknown, 1 excellent, 2 good, 3 fair, 4 inferior, 5 poor.
    hap: "public.hap.characteristic.air-quality",
    parse: number,
    describe: (value) =>
      `air quality ${["unknown", "excellent", "good", "fair", "inferior", "poor"][value] ?? value}`,
  },
  pm25: {
    hap: "public.hap.characteristic.density.pm25",
    parse: number,
    describe: withUnit("µg/m³ PM2.5"),
  },
  pm10: {
    hap: "public.hap.characteristic.density.pm10",
    parse: number,
    describe: withUnit("µg/m³ PM10"),
  },
  voc: {
    hap: "public.hap.characteristic.density.voc",
    parse: number,
    describe: withUnit("µg/m³ VOC"),
  },
  no2: {
    hap: "public.hap.characteristic.density.no2",
    parse: number,
    describe: withUnit("µg/m³ NO₂"),
  },
  ozone: {
    hap: "public.hap.characteristic.density.ozone",
    parse: number,
    describe: withUnit("µg/m³ O₃"),
  },
  lightLevel: {
    hap: "public.hap.characteristic.light-level.current",
    parse: number,
    describe: withUnit("lx", 1),
  },
  batteryLevel: {
    hap: "public.hap.characteristic.battery-level",
    parse: number,
    perDevice: true,
    describe: (value) => `battery ${value} %`,
  },
  lowBattery: {
    hap: "public.hap.characteristic.status-lo-batt",
    parse: flag,
    perDevice: true,
    describe: (low) => (low ? "battery low" : ""),
  },
  fault: {
    hap: "public.hap.characteristic.status-fault",
    parse: flag,
    perDevice: true,
    describe: (fault) => (fault ? "FAULT" : ""),
  },
};

// "temperature.2" → "temperature"; "temperature" → "temperature".
function baseKey(key) {
  return String(key).replace(/\.\d+$/, "");
}

// "temperature.2" → 2; "temperature" → 1.
function instanceOf(key) {
  const match = /\.(\d+)$/.exec(String(key));
  return match == null ? 1 : Number(match[1]);
}

function instanceKey(key, instance) {
  return instance <= 1 ? key : `${key}.${instance}`;
}

// Raw HAP values, keyed like the database, → plain numbers/booleans.
// Characteristics the device doesn't have stay out; ones it has but didn't
// report are undefined.
function normalizeReadings(values) {
  const readings = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const entry = READINGS[baseKey(key)];
    if (entry != null) {
      readings[key] = entry.parse(value);
    }
  }
  return readings;
}

// "22.4 °C, 60.5 %, battery 86 %" - only what the device reported.
function describeReadings(readings) {
  const parts = [];
  for (const [key, value] of Object.entries(readings ?? {})) {
    const entry = READINGS[baseKey(key)];
    if (entry == null || value == null) {
      continue;
    }
    const text = entry.describe(value);
    if (text !== "") {
      parts.push(instanceOf(key) > 1 ? `${text} (#${instanceOf(key)})` : text);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "no values";
}

module.exports = {
  READINGS,
  baseKey,
  instanceOf,
  instanceKey,
  normalizeReadings,
  describeReadings,
};
