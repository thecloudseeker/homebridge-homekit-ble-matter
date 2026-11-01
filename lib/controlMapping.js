const { hsToXy, xyToHs } = require("./color");

// How a controllable HomeKit device (lib/sensorTypes.js, the readings with a
// `group`) becomes a Matter endpoint: the device type, its attributes, and
// the command handlers that set the HomeKit characteristics.
//
// Same shape as the sensor groups in lib/matterMapping.js, plus:
// - `handlers(has, get, write)`: Matter cluster → command → handler.
//   `write({role: value})` sets the device's characteristics (plain values,
//   as in the readings) and resolves once the device accepted them.
// - `merged`: `get` returns the latest known value of a role, not only one
//   in the readings at hand - an attribute like a thermostat's setpoint
//   depends on several characteristics (mode and target), which don't
//   always arrive together. `changed(role)` says whether this update has it.
//
// Homebridge also calls some handlers when the plugin itself sets an
// attribute (fan and thermostat ones react to attribute changes), so a
// handler often asks for what the device already has: the write skips that
// (see BleSensor.write).

// Matter enums.
const LOCK_LOCKED = 1;
const LOCK_UNLOCKED = 2;
const LOCK_NOT_FULLY_LOCKED = 0;
const LOCK_TYPE_OTHER = 2;
const OPERATING_MODE_NORMAL = 0;
const COVER_TYPE_ROLLERSHADE = 0;
const COVER_STOPPED = 0;
const COVER_OPENING = 1;
const COVER_CLOSING = 2;
const FAN_OFF = 0;
const FAN_LOW = 1;
const FAN_MEDIUM = 2;
const FAN_HIGH = 3;
const FAN_ON = 4;
const FAN_AUTO = 5;
const FAN_SEQUENCE_OFF_LOW_MED_HIGH = 0;
const FAN_SEQUENCE_OFF_HIGH = 5;
const SYSTEM_OFF = 0;
const SYSTEM_AUTO = 1;
const SYSTEM_COOL = 3;
const SYSTEM_HEAT = 4;
const SEQUENCE_COOLING_ONLY = 0;
const SEQUENCE_HEATING_ONLY = 2;
const SEQUENCE_COOLING_AND_HEATING = 4;
const COLOR_MODE_HUE_SATURATION = 0;
const COLOR_MODE_TEMPERATURE = 2;
const VALVE_CLOSED = 0;
const VALVE_OPEN = 1;

// HomeKit's ranges, used as the Matter limits.
const MIN_MIREDS = 140;
const MAX_MIREDS = 500;
const MIN_SETPOINT = 1000; // 10 °C
const MAX_SETPOINT = 3800; // 38 °C

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Brightness 0-100 % ↔ Matter level 1-254 (0 is reserved for lights).
const toLevel = (percent) =>
  percent == null ? null : clamp(Math.round(percent * 2.54), 1, 254);
const fromLevel = (level) => clamp(Math.round(level / 2.54), 0, 100);
// Hue 0-360° and saturation 0-100 % ↔ Matter 0-254.
const toMatterHue = (degrees) =>
  clamp(Math.round((degrees / 360) * 254), 0, 254);
const fromMatterHue = (hue) => (hue / 254) * 360;
const toMatterSaturation = (percent) =>
  clamp(Math.round(percent * 2.54), 0, 254);
const fromMatterSaturation = (saturation) => (saturation / 254) * 100;
// CIE xy 0-1 ↔ Matter 0-65279.
const toMatterXy = (value) => clamp(Math.round(value * 65536), 0, 65279);
// Temperatures: °C ↔ hundredths.
const toCenti = (celsius) =>
  celsius == null ? null : Math.round(celsius * 100);
const fromCenti = (centi) => centi / 100;
// Cover positions: HomeKit 0 closed - 100 open; Matter 0 open - 10000
// closed (hundredths of a percent closed).
const toClosed100ths = (open) =>
  open == null ? null : clamp(Math.round((100 - open) * 100), 0, 10000);
const fromClosed100ths = (closed) =>
  clamp(Math.round(100 - closed / 100), 0, 100);

// Whether this update has any of the roles: a merged state is only sent
// along with a change of one of its inputs.
const any = (changed, roles) => roles.some((role) => changed(role));

// The device's on/off: lights and plugs say "on", fanv2/purifiers "active".
function onOffState(has, get, initial, changed, role) {
  if (!has(role) || (!initial && !changed(role))) {
    return {};
  }
  return { onOff: { onOff: Boolean(get(role)) } };
}

function onOffHandlers(get, write, role) {
  return {
    onOff: {
      on: () => write({ [role]: true }),
      off: () => write({ [role]: false }),
      toggle: () => write({ [role]: !get(role) }),
    },
  };
}

const PLUG = (id, label, role) => ({
  id,
  label,
  control: true,
  merged: true,
  roles: [role, ...(id === "outlet" ? ["outletInUse"] : [])],
  triggers: [role],
  // A HomeKit switch is something to turn on and off, not a wall switch
  // controlling other devices (Matter's OnOffLightSwitch): a plug-in unit.
  deviceType: (types) => types.OnOffOutlet,
  state: (has, get, initial, device, changed) =>
    onOffState(has, get, initial, changed, role),
  handlers: (has, get, write) => onOffHandlers(get, write, role),
});

const LIGHT = {
  id: "lightbulb",
  label: "Light",
  control: true,
  merged: true,
  roles: ["lightOn", "brightness", "hue", "saturation", "colorTemperature"],
  triggers: ["lightOn"],
  deviceType(types, has) {
    if (has("hue") || has("saturation")) {
      return types.ExtendedColorLight;
    }
    if (has("colorTemperature")) {
      return types.ColorTemperatureLight;
    }
    return has("brightness") ? types.DimmableLight : types.OnOffLight;
  },
  state(has, get, initial, device, changed) {
    const state = onOffState(has, get, initial, changed, "lightOn");
    if (has("brightness") && (initial || changed("brightness"))) {
      state.levelControl = { currentLevel: toLevel(get("brightness")) ?? 254 };
      if (initial) {
        Object.assign(state.levelControl, { minLevel: 1, maxLevel: 254 });
      }
    }
    const color = {};
    const colorful = has("hue") || has("saturation");
    if (colorful && (initial || any(changed, ["hue", "saturation"]))) {
      const hue = get("hue") ?? 0;
      const saturation = get("saturation") ?? 0;
      const { x, y } = hsToXy(hue, saturation);
      Object.assign(color, {
        currentHue: toMatterHue(hue),
        currentSaturation: toMatterSaturation(saturation),
        currentX: toMatterXy(x),
        currentY: toMatterXy(y),
      });
      if (changed("hue") || changed("saturation")) {
        color.colorMode = COLOR_MODE_HUE_SATURATION;
      }
    }
    if (has("colorTemperature") && (initial || changed("colorTemperature"))) {
      color.colorTemperatureMireds = clamp(
        Math.round(get("colorTemperature") ?? 370),
        MIN_MIREDS,
        MAX_MIREDS,
      );
      if (changed("colorTemperature") && !initial) {
        color.colorMode = COLOR_MODE_TEMPERATURE;
      }
    }
    if (initial && (colorful || has("colorTemperature"))) {
      color.colorMode = colorful
        ? COLOR_MODE_HUE_SATURATION
        : COLOR_MODE_TEMPERATURE;
      if (has("colorTemperature")) {
        Object.assign(color, {
          colorTempPhysicalMinMireds: MIN_MIREDS,
          colorTempPhysicalMaxMireds: MAX_MIREDS,
          // Defaults to 0, outside the physical range, which matter.js refuses.
          coupleColorTempToLevelMinMireds: MIN_MIREDS,
        });
      }
    }
    if (Object.keys(color).length > 0) {
      state.colorControl = color;
    }
    return state;
  },
  handlers(has, get, write) {
    const handlers = onOffHandlers(get, write, "lightOn");
    if (has("brightness")) {
      const toBrightness = ({ level }) => fromLevel(level);
      handlers.levelControl = {
        moveToLevel: (request) => write({ brightness: toBrightness(request) }),
        // Brightness and on/off together: the level's "with on/off" turns
        // the light off at the lowest level and on above it.
        moveToLevelWithOnOff: (request) =>
          write({
            brightness: toBrightness(request),
            lightOn: request.level > 1,
          }),
      };
    }
    const color = {};
    if (has("colorTemperature")) {
      color.moveToColorTemperatureLogic = ({ colorTemperatureMireds }) =>
        write({
          colorTemperature: clamp(
            colorTemperatureMireds,
            MIN_MIREDS,
            MAX_MIREDS,
          ),
        });
    }
    if (has("hue") || has("saturation")) {
      const hueSaturation = (hue, saturation) => {
        const values = {};
        if (has("hue") && hue != null) {
          values.hue = Math.round(hue);
        }
        if (has("saturation") && saturation != null) {
          values.saturation = Math.round(saturation);
        }
        return write(values);
      };
      color.moveToHueAndSaturationLogic = ({ hue, saturation }) =>
        hueSaturation(fromMatterHue(hue), fromMatterSaturation(saturation));
      color.moveToHueLogic = ({ targetHue }) =>
        hueSaturation(fromMatterHue(targetHue), null);
      color.moveToSaturationLogic = ({ targetSaturation }) =>
        hueSaturation(null, fromMatterSaturation(targetSaturation));
      color.moveToColorLogic = ({ targetX, targetY }) => {
        const { hue, saturation } = xyToHs(targetX / 65536, targetY / 65536);
        return hueSaturation(hue, saturation);
      };
    }
    if (Object.keys(color).length > 0) {
      handlers.colorControl = color;
    }
    return handlers;
  },
};

const LOCK = {
  id: "lock",
  label: "Lock",
  control: true,
  merged: true,
  roles: ["lockCurrent", "lockTarget"],
  triggers: ["lockTarget"],
  deviceType: (types) => types.DoorLock,
  state(has, get, initial, device, changed) {
    if (!initial && !changed("lockCurrent")) {
      return {};
    }
    // HomeKit 0 unsecured, 1 secured, 2 jammed, 3 unknown.
    const current = get("lockCurrent");
    const lockState =
      current === 1
        ? LOCK_LOCKED
        : current === 0
          ? LOCK_UNLOCKED
          : current === 2
            ? LOCK_NOT_FULLY_LOCKED
            : null;
    const doorLock = { lockState };
    if (initial) {
      Object.assign(doorLock, {
        lockType: LOCK_TYPE_OTHER,
        actuatorEnabled: true,
        operatingMode: OPERATING_MODE_NORMAL,
      });
    }
    return { doorLock };
  },
  handlers: (has, get, write) => ({
    doorLock: {
      lockDoor: () => write({ lockTarget: 1 }),
      unlockDoor: () => write({ lockTarget: 0 }),
    },
  }),
};

const COVER = {
  id: "cover",
  label: "Cover",
  control: true,
  merged: true,
  roles: ["coverCurrent", "coverTarget", "coverState", "coverHold"],
  triggers: ["coverTarget"],
  deviceType: (types) => types.WindowCovering,
  state(has, get, initial, device, changed) {
    if (
      !initial &&
      !any(changed, ["coverCurrent", "coverTarget", "coverState"])
    ) {
      return {};
    }
    const current = toClosed100ths(get("coverCurrent")) ?? 0;
    const target = toClosed100ths(get("coverTarget")) ?? current;
    // HomeKit 0 decreasing (closing), 1 increasing (opening), 2 stopped.
    const moving = get("coverState");
    const status =
      moving === 0
        ? COVER_CLOSING
        : moving === 1
          ? COVER_OPENING
          : COVER_STOPPED;
    const windowCovering = {
      currentPositionLiftPercent100ths: current,
      targetPositionLiftPercent100ths: target,
      operationalStatus: { global: status, lift: status, tilt: COVER_STOPPED },
    };
    if (initial) {
      Object.assign(windowCovering, {
        type: COVER_TYPE_ROLLERSHADE,
        endProductType: 0,
        configStatus: {
          operational: true,
          onlineReserved: true,
          liftMovementReversed: false,
          liftPositionAware: true,
          tiltPositionAware: false,
          liftEncoderControlled: false,
          tiltEncoderControlled: false,
        },
      });
    }
    return { windowCovering };
  },
  handlers: (has, get, write) => ({
    windowCovering: {
      upOrOpen: () => write({ coverTarget: 100 }),
      downOrClose: () => write({ coverTarget: 0 }),
      // Hold position where the device can; otherwise aim for where it is.
      stopMotion: () =>
        has("coverHold")
          ? write({ coverHold: true })
          : write({ coverTarget: get("coverCurrent") ?? 0 }),
      goToLiftPercentage: ({ liftPercent100thsValue }) =>
        write({ coverTarget: fromClosed100ths(liftPercent100thsValue) }),
    },
  }),
};

// Fan speed in Matter's three steps, for its fan mode.
function fanModeFor(on, speed, hasSpeed) {
  if (!on) {
    return FAN_OFF;
  }
  if (!hasSpeed || speed == null) {
    return FAN_HIGH;
  }
  return speed <= 33 ? FAN_LOW : speed <= 66 ? FAN_MEDIUM : FAN_HIGH;
}

const FAN = {
  id: "fan",
  label: "Fan",
  control: true,
  merged: true,
  roles: ["fanOn", "fanActive", "fanSpeed"],
  triggers: ["fanOn", "fanActive"],
  deviceType: (types) => types.Fan,
  state(has, get, initial, device, changed) {
    const power = has("fanActive") ? "fanActive" : "fanOn";
    if (!initial && !any(changed, [power, "fanSpeed"])) {
      return {};
    }
    const on = Boolean(get(power));
    const speed = get("fanSpeed");
    const percent = on ? (has("fanSpeed") ? Math.round(speed ?? 100) : 100) : 0;
    const fanControl = {
      fanMode: fanModeFor(on, speed, has("fanSpeed")),
      percentSetting: percent,
      percentCurrent: percent,
    };
    if (initial) {
      fanControl.fanModeSequence = has("fanSpeed")
        ? FAN_SEQUENCE_OFF_LOW_MED_HIGH
        : FAN_SEQUENCE_OFF_HIGH;
    }
    return { fanControl };
  },
  handlers(has, get, write) {
    const power = has("fanActive") ? "fanActive" : "fanOn";
    const setPercent = (percent) => {
      const values = { [power]: percent > 0 };
      if (has("fanSpeed") && percent > 0) {
        values.fanSpeed = percent;
      }
      return write(values);
    };
    return {
      fanControl: {
        fanModeChange: ({ fanMode }) => {
          // Also called for the mode the plugin itself set from the
          // device's speed: three steps can't say 50 %, so the mode it was
          // derived from isn't written back as 66 %.
          if (
            fanMode ===
            fanModeFor(Boolean(get(power)), get("fanSpeed"), has("fanSpeed"))
          ) {
            return undefined;
          }
          switch (fanMode) {
            case FAN_OFF:
              return write({ [power]: false });
            case FAN_LOW:
              return setPercent(33);
            case FAN_MEDIUM:
              return setPercent(66);
            case FAN_HIGH:
              return setPercent(100);
            case FAN_ON:
            case FAN_AUTO:
            default:
              return write({ [power]: true });
          }
        },
        percentSettingChange: ({ percentSetting }) =>
          percentSetting == null ? undefined : setPercent(percentSetting),
      },
    };
  },
};

// Thermostat setpoint limits, the same for heating and cooling: HomeKit
// has one range (10-38 °C) for all of its target temperatures. With no
// deadband, heating and cooling may share a setpoint, which is how a
// thermostat in heat or cool mode shows its single target temperature.
const SETPOINT_LIMITS = {
  absMinHeatSetpointLimit: MIN_SETPOINT,
  absMaxHeatSetpointLimit: MAX_SETPOINT,
  minHeatSetpointLimit: MIN_SETPOINT,
  maxHeatSetpointLimit: MAX_SETPOINT,
  absMinCoolSetpointLimit: MIN_SETPOINT,
  absMaxCoolSetpointLimit: MAX_SETPOINT,
  minCoolSetpointLimit: MIN_SETPOINT,
  maxCoolSetpointLimit: MAX_SETPOINT,
  minSetpointDeadBand: 0,
};

const setpoint = (celsius) =>
  celsius == null ? null : clamp(toCenti(celsius), MIN_SETPOINT, MAX_SETPOINT);

// HomeKit thermostat target mode 0 off, 1 heat, 2 cool, 3 auto ↔ Matter.
const THERMOSTAT_MODES = [SYSTEM_OFF, SYSTEM_HEAT, SYSTEM_COOL, SYSTEM_AUTO];

const THERMOSTAT = {
  id: "thermostat",
  label: "Thermostat",
  control: true,
  merged: true,
  roles: [
    "thermostatTemperature",
    "thermostatCurrentMode",
    "thermostatTargetMode",
    "thermostatTarget",
    "thermostatHeatingThreshold",
    "thermostatCoolingThreshold",
  ],
  triggers: ["thermostatTargetMode", "thermostatTarget"],
  deviceType: (types) => types.Thermostat,
  state(has, get, initial, device, changed) {
    const thermostat = {};
    if (initial || changed("thermostatTemperature")) {
      thermostat.localTemperature = toCenti(get("thermostatTemperature"));
    }
    const inputs = [
      "thermostatTargetMode",
      "thermostatTarget",
      "thermostatHeatingThreshold",
      "thermostatCoolingThreshold",
    ];
    if (initial || any(changed, inputs)) {
      const mode = get("thermostatTargetMode");
      thermostat.systemMode = THERMOSTAT_MODES[mode] ?? SYSTEM_OFF;
      const target = get("thermostatTarget");
      // In auto, HomeKit heats below its heating threshold and cools above
      // its cooling threshold; otherwise it has one target temperature.
      const auto = mode === 3;
      const heating =
        auto && has("thermostatHeatingThreshold")
          ? get("thermostatHeatingThreshold")
          : target;
      const cooling =
        auto && has("thermostatCoolingThreshold")
          ? get("thermostatCoolingThreshold")
          : target;
      thermostat.occupiedHeatingSetpoint = setpoint(heating) ?? 2000;
      thermostat.occupiedCoolingSetpoint = Math.max(
        setpoint(cooling) ?? 2000,
        thermostat.occupiedHeatingSetpoint,
      );
    }
    if (initial) {
      Object.assign(thermostat, SETPOINT_LIMITS, {
        controlSequenceOfOperation: SEQUENCE_COOLING_AND_HEATING,
      });
    }
    return Object.keys(thermostat).length > 0 ? { thermostat } : {};
  },
  handlers(has, get, write) {
    const toSetpoint = (role, centi) =>
      get("thermostatTargetMode") === 3 && has(role)
        ? write({ [role]: fromCenti(centi) })
        : write({ thermostatTarget: fromCenti(centi) });
    return {
      thermostat: {
        systemModeChange: ({ systemMode }) => {
          const mode = THERMOSTAT_MODES.indexOf(systemMode);
          if (mode < 0) {
            throw new Error(
              `HomeKit thermostats have no system mode ${systemMode}`,
            );
          }
          return write({ thermostatTargetMode: mode });
        },
        occupiedHeatingSetpointChange: ({ occupiedHeatingSetpoint }) =>
          toSetpoint("thermostatHeatingThreshold", occupiedHeatingSetpoint),
        occupiedCoolingSetpointChange: ({ occupiedCoolingSetpoint }) =>
          toSetpoint("thermostatCoolingThreshold", occupiedCoolingSetpoint),
      },
    };
  },
};

// HomeKit heater/cooler target 0 auto, 1 heat, 2 cool ↔ Matter.
const HEATER_COOLER_MODES = [SYSTEM_AUTO, SYSTEM_HEAT, SYSTEM_COOL];

const HEATER_COOLER = {
  id: "heaterCooler",
  label: "Air conditioner",
  control: true,
  merged: true,
  roles: [
    "heaterCoolerActive",
    "heaterCoolerTemperature",
    "heaterCoolerCurrentMode",
    "heaterCoolerTargetMode",
    "heaterCoolerHeatingThreshold",
    "heaterCoolerCoolingThreshold",
  ],
  triggers: ["heaterCoolerActive"],
  deviceType: (types) => types.RoomAirConditioner,
  state(has, get, initial, device, changed) {
    const state = onOffState(has, get, initial, changed, "heaterCoolerActive");
    const thermostat = {};
    if (initial || changed("heaterCoolerTemperature")) {
      thermostat.localTemperature = toCenti(get("heaterCoolerTemperature"));
    }
    if (
      initial ||
      any(changed, ["heaterCoolerActive", "heaterCoolerTargetMode"])
    ) {
      thermostat.systemMode = get("heaterCoolerActive")
        ? (HEATER_COOLER_MODES[get("heaterCoolerTargetMode")] ?? SYSTEM_AUTO)
        : SYSTEM_OFF;
    }
    // Only the setpoints the device has: Homebridge derives the heating and
    // cooling features from them.
    if (
      has("heaterCoolerHeatingThreshold") &&
      (initial || changed("heaterCoolerHeatingThreshold"))
    ) {
      thermostat.occupiedHeatingSetpoint =
        setpoint(get("heaterCoolerHeatingThreshold")) ?? 2000;
    }
    if (
      has("heaterCoolerCoolingThreshold") &&
      (initial || changed("heaterCoolerCoolingThreshold"))
    ) {
      thermostat.occupiedCoolingSetpoint =
        setpoint(get("heaterCoolerCoolingThreshold")) ?? 2400;
    }
    if (initial) {
      const heats = has("heaterCoolerHeatingThreshold");
      const cools = has("heaterCoolerCoolingThreshold");
      Object.assign(thermostat, SETPOINT_LIMITS, {
        controlSequenceOfOperation:
          heats && cools
            ? SEQUENCE_COOLING_AND_HEATING
            : cools
              ? SEQUENCE_COOLING_ONLY
              : SEQUENCE_HEATING_ONLY,
      });
      if (!heats) {
        for (const key of Object.keys(SETPOINT_LIMITS)) {
          if (key.includes("Heat")) {
            delete thermostat[key];
          }
        }
      }
      if (!cools) {
        for (const key of Object.keys(SETPOINT_LIMITS)) {
          if (key.includes("Cool")) {
            delete thermostat[key];
          }
        }
      }
      if (!(heats && cools)) {
        delete thermostat.minSetpointDeadBand;
      }
      // Neither: heating only (Matter needs one), at a fixed setpoint.
      if (!heats && !cools) {
        thermostat.occupiedHeatingSetpoint = 2000;
      }
    }
    if (Object.keys(thermostat).length > 0) {
      state.thermostat = thermostat;
    }
    return state;
  },
  handlers(has, get, write) {
    const handlers = onOffHandlers(get, write, "heaterCoolerActive");
    handlers.thermostat = {
      systemModeChange: ({ systemMode }) => {
        if (systemMode === SYSTEM_OFF) {
          return write({ heaterCoolerActive: false });
        }
        const mode = HEATER_COOLER_MODES.indexOf(systemMode);
        if (mode < 0) {
          throw new Error(
            `HomeKit air conditioners have no system mode ${systemMode}`,
          );
        }
        return write({
          heaterCoolerActive: true,
          heaterCoolerTargetMode: mode,
        });
      },
    };
    if (has("heaterCoolerHeatingThreshold")) {
      handlers.thermostat.occupiedHeatingSetpointChange = ({
        occupiedHeatingSetpoint,
      }) =>
        write({
          heaterCoolerHeatingThreshold: fromCenti(occupiedHeatingSetpoint),
        });
    }
    if (has("heaterCoolerCoolingThreshold")) {
      handlers.thermostat.occupiedCoolingSetpointChange = ({
        occupiedCoolingSetpoint,
      }) =>
        write({
          heaterCoolerCoolingThreshold: fromCenti(occupiedCoolingSetpoint),
        });
    }
    return handlers;
  },
};

const VALVE = {
  id: "valve",
  label: "Valve",
  control: true,
  merged: true,
  roles: ["valveActive", "valveInUse"],
  triggers: ["valveActive"],
  deviceType: (types) => types.WaterValve,
  state(has, get, initial, device, changed) {
    if (!initial && !changed("valveActive")) {
      return {};
    }
    const open = Boolean(get("valveActive"));
    const valve = {
      currentState: open ? VALVE_OPEN : VALVE_CLOSED,
      targetState: open ? VALVE_OPEN : VALVE_CLOSED,
    };
    if (initial) {
      Object.assign(valve, {
        openDuration: null,
        defaultOpenDuration: null,
        remainingDuration: null,
      });
    }
    return { valveConfigurationAndControl: valve };
  },
  handlers: (has, get, write) => ({
    valveConfigurationAndControl: {
      open: () => write({ valveActive: true }),
      close: () => write({ valveActive: false }),
    },
  }),
};

// In priority order for the main endpoint: what the device is for.
const CONTROL_GROUPS = [
  LOCK,
  THERMOSTAT,
  HEATER_COOLER,
  COVER,
  LIGHT,
  FAN,
  VALVE,
  PLUG("outlet", "Outlet", "outletOn"),
  PLUG("switch", "Switch", "switchOn"),
];

module.exports = {
  CONTROL_GROUPS,
  toLevel,
  fromLevel,
  toClosed100ths,
  fromClosed100ths,
};
