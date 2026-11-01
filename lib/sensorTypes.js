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
//
// Controllable devices (plugs, lights, locks, ...): `group` ties a reading to
// the services it belongs to (see GROUP_SERVICES) - an "On" characteristic is
// a plug's on an outlet and a light's on a lightbulb - and numbers repeats by
// service, so a second light's on and brightness are both ".2" even if the
// first light has no brightness. `writable`: it can be set; `encode` turns
// the plain value back into what HomeKit expects.

const number = (value) =>
  value == null || value === "" || Number.isNaN(Number(value))
    ? undefined
    : Number(value);
// HomeKit flags are 0/1 numbers (booleans on some devices).
const flag = (value) =>
  value == null || value === "" ? undefined : Number(value) === 1;
const round = (value, digits = 0) => Number(value.toFixed(digits));

const toFlag = (value) => (value ? 1 : 0);
const toNumber = (value) => Number(value);
const percent = (value) => `${round(value)} %`;
const onOff = (label) => (on) => `${label} ${on ? "on" : "off"}`;

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
  // A button (stateless programmable switch): 0 single, 1 double, 2 long
  // press. `event`: it has no state to read - a press only arrives as a
  // fast update (see BleSensor.handleBroadcast).
  button: {
    hap: "public.hap.characteristic.input-event",
    parse: number,
    event: true,
    describe: (value) =>
      `button ${["single press", "double press", "long press"][value] ?? value}`,
  },
  // Whether the sensor is working. Not active: reported as not responding.
  active: {
    hap: "public.hap.characteristic.status-active",
    parse: flag,
    perDevice: true,
    describe: (active) => (active ? "" : "NOT ACTIVE"),
  },
  // Only logged: Matter has no place for it on these device types.
  tampered: {
    hap: "public.hap.characteristic.status-tampered",
    parse: flag,
    perDevice: true,
    describe: (tampered) => (tampered ? "TAMPERED" : ""),
  },
  fault: {
    hap: "public.hap.characteristic.status-fault",
    parse: flag,
    perDevice: true,
    describe: (fault) => (fault ? "FAULT" : ""),
  },

  // Plugs and switches.
  outletOn: control("outlet", "on", flag, toFlag, onOff("outlet")),
  outletInUse: {
    group: "outlet",
    hap: "public.hap.characteristic.outlet-in-use",
    parse: flag,
    describe: () => "",
  },
  switchOn: control("switch", "on", flag, toFlag, onOff("switch")),

  // Lights.
  lightOn: control("light", "on", flag, toFlag, onOff("light")),
  brightness: control(
    "light",
    "brightness",
    number,
    toNumber,
    (value) => `brightness ${percent(value)}`,
  ),
  hue: control(
    "light",
    "hue",
    number,
    toNumber,
    (value) => `hue ${round(value)}°`,
  ),
  saturation: control(
    "light",
    "saturation",
    number,
    toNumber,
    (value) => `saturation ${percent(value)}`,
  ),
  colorTemperature: control(
    "light",
    "color-temperature",
    number,
    toNumber,
    (value) => `${round(value)} mired`,
  ),

  // Locks: current 0 unsecured, 1 secured, 2 jammed, 3 unknown; target 0/1.
  lockCurrent: {
    group: "lock",
    hap: "public.hap.characteristic.lock-mechanism.current-state",
    parse: number,
    describe: (value) =>
      ["unlocked", "locked", "JAMMED", "lock state unknown"][value] ??
      `lock ${value}`,
  },
  lockTarget: control(
    "lock",
    "lock-mechanism.target-state",
    number,
    toNumber,
    () => "",
  ),

  // Blinds, windows and doors: positions 0 (closed) - 100 (open); state 0
  // closing, 1 opening, 2 stopped. Hold position is write-only.
  coverCurrent: {
    group: "cover",
    hap: "public.hap.characteristic.position.current",
    parse: number,
    describe: (value) => `position ${percent(value)}`,
  },
  coverTarget: control("cover", "position.target", number, toNumber, () => ""),
  coverState: {
    group: "cover",
    hap: "public.hap.characteristic.position.state",
    parse: number,
    describe: () => "",
  },
  coverHold: control("cover", "position.hold", flag, toFlag, () => ""),

  // Fans and air purifiers: on (fan) or active (fanv2, purifier), speed
  // 0-100 %.
  fanOn: control("fan", "on", flag, toFlag, onOff("fan")),
  fanActive: control("fan", "active", flag, toFlag, onOff("fan")),
  fanSpeed: control(
    "fan",
    "rotation.speed",
    number,
    toNumber,
    (value) => `fan ${percent(value)}`,
  ),

  // Thermostats: modes 0 off, 1 heat, 2 cool, 3 auto (target), current
  // 0 off, 1 heating, 2 cooling. Temperatures in °C.
  thermostatTemperature: {
    group: "thermostat",
    hap: "public.hap.characteristic.temperature.current",
    parse: number,
    describe: (value) => `${value.toFixed(1)} °C`,
  },
  thermostatCurrentMode: {
    group: "thermostat",
    hap: "public.hap.characteristic.heating-cooling.current",
    parse: number,
    describe: (value) => ["idle", "heating", "cooling"][value] ?? "",
  },
  thermostatTargetMode: control(
    "thermostat",
    "heating-cooling.target",
    number,
    toNumber,
    (value) => `mode ${["off", "heat", "cool", "auto"][value] ?? value}`,
  ),
  thermostatTarget: control(
    "thermostat",
    "temperature.target",
    number,
    toNumber,
    (value) => `target ${value.toFixed(1)} °C`,
  ),
  thermostatHeatingThreshold: control(
    "thermostat",
    "temperature.heating-threshold",
    number,
    toNumber,
    () => "",
  ),
  thermostatCoolingThreshold: control(
    "thermostat",
    "temperature.cooling-threshold",
    number,
    toNumber,
    () => "",
  ),

  // Heater/coolers (air conditioners): active, target 0 auto, 1 heat,
  // 2 cool; current 0 inactive, 1 idle, 2 heating, 3 cooling.
  heaterCoolerActive: control(
    "heaterCooler",
    "active",
    flag,
    toFlag,
    onOff("heater/cooler"),
  ),
  heaterCoolerTemperature: {
    group: "heaterCooler",
    hap: "public.hap.characteristic.temperature.current",
    parse: number,
    describe: (value) => `${value.toFixed(1)} °C`,
  },
  heaterCoolerCurrentMode: {
    group: "heaterCooler",
    hap: "public.hap.characteristic.heater-cooler.state.current",
    parse: number,
    describe: (value) =>
      ["inactive", "idle", "heating", "cooling"][value] ?? "",
  },
  heaterCoolerTargetMode: control(
    "heaterCooler",
    "heater-cooler.state.target",
    number,
    toNumber,
    (value) => `mode ${["auto", "heat", "cool"][value] ?? value}`,
  ),
  heaterCoolerHeatingThreshold: control(
    "heaterCooler",
    "temperature.heating-threshold",
    number,
    toNumber,
    () => "",
  ),
  heaterCoolerCoolingThreshold: control(
    "heaterCooler",
    "temperature.cooling-threshold",
    number,
    toNumber,
    () => "",
  ),

  // Valves and faucets: active (open/closed), in use (water flowing).
  valveActive: control(
    "valve",
    "active",
    flag,
    toFlag,
    (open) => `valve ${open ? "open" : "closed"}`,
  ),
  valveInUse: {
    group: "valve",
    hap: "public.hap.characteristic.in-use",
    parse: flag,
    describe: () => "",
  },
};

// The HomeKit services each controllable group's readings live on.
const GROUP_SERVICES = {
  outlet: ["outlet"],
  switch: ["switch"],
  light: ["lightbulb"],
  lock: ["lock-mechanism"],
  cover: ["window-covering", "window", "door"],
  fan: ["fan", "fanv2", "air-purifier"],
  thermostat: ["thermostat"],
  heaterCooler: ["heater-cooler"],
  valve: ["valve", "faucet"],
};
for (const [group, services] of Object.entries(GROUP_SERVICES)) {
  GROUP_SERVICES[group] = services.map((name) => `public.hap.service.${name}`);
}

// A characteristic that can be set: `name` without the
// "public.hap.characteristic." prefix.
function control(group, name, parse, encode, describe) {
  return {
    group,
    hap: `public.hap.characteristic.${name}`,
    parse,
    encode,
    writable: true,
    describe,
  };
}

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
  GROUP_SERVICES,
  baseKey,
  instanceOf,
  instanceKey,
  normalizeReadings,
  describeReadings,
};
