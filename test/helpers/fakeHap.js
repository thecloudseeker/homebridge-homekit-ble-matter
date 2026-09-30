const { EventEmitter } = require("events");

// Fakes the part of hap-controller this plugin uses (see lib/hap.js
// loadHap): BLEDiscovery, GattClient, characteristicFromUuid,
// serviceFromUuid. One `device` object models the physical sensor: its
// setup code, pairing state, accessory database and current values, plus
// knobs to make operations fail.

// Short fake UUIDs → the HAP names hap-controller would resolve them to.
const NAMES = {
  "svc-info": "public.hap.service.accessory-information",
  "svc-temp": "public.hap.service.sensor.temperature",
  "svc-hum": "public.hap.service.sensor.humidity",
  "svc-bat": "public.hap.service.battery",
  "svc-dfu": "00001530-1212-EFDE-1523-785FEABCD123",
  "ch-manufacturer": "public.hap.characteristic.manufacturer",
  "ch-model": "public.hap.characteristic.model",
  "ch-serial": "public.hap.characteristic.serial-number",
  "ch-firmware": "public.hap.characteristic.firmware.revision",
  "ch-name": "public.hap.characteristic.name",
  "ch-temp": "public.hap.characteristic.temperature.current",
  "ch-hum": "public.hap.characteristic.relative-humidity.current",
  "ch-batlevel": "public.hap.characteristic.battery-level",
  "ch-lowbat": "public.hap.characteristic.status-lo-batt",
};

// Mirrors the accessory database a real Qingping CGG1H reported
// (iids and formats as read from the device).
function cgg1hDatabase() {
  return {
    accessories: [
      {
        aid: 1,
        services: [
          {
            iid: 1,
            type: "svc-info",
            characteristics: [
              { iid: 2, type: "ch-name", format: "string" },
              { iid: 4, type: "ch-manufacturer", format: "string" },
              { iid: 5, type: "ch-model", format: "string" },
              { iid: 6, type: "ch-serial", format: "string" },
              { iid: 14, type: "ch-firmware", format: "string" },
            ],
          },
          {
            iid: 900,
            type: "svc-dfu",
            characteristics: [{ iid: 901, type: "x", format: "data" }],
          },
          {
            iid: 256,
            type: "svc-temp",
            characteristics: [
              { iid: 262, type: "ch-name", format: "string" },
              { iid: 257, type: "ch-temp", format: "float" },
            ],
          },
          {
            iid: 144,
            type: "svc-hum",
            characteristics: [
              { iid: 150, type: "ch-name", format: "string" },
              { iid: 145, type: "ch-hum", format: "float" },
            ],
          },
          {
            iid: 58,
            type: "svc-bat",
            characteristics: [
              { iid: 59, type: "ch-batlevel", format: "uint8" },
              { iid: 61, type: "ch-lowbat", format: "uint8" },
              { iid: 62, type: "ch-name", format: "string" },
            ],
          },
        ],
      },
    ],
  };
}

function createFakeDevice(overrides = {}) {
  return {
    deviceId: "41:21:14:E5:C2:25",
    setupCode: "128-84-842",
    paired: false,
    database: cgg1hDatabase(),
    values: {
      2: "Qingping Temp RH H",
      4: "Qingping",
      5: "CGG1H",
      6: "582D34ABCDEF",
      14: "1.2.3",
      257: 22.4,
      145: 60.5,
      59: 86,
      61: 0,
    },
    failNextReads: 0,
    // Failed connects that leave the peripheral in state 'error', as noble
    // 2's D-Bus binding does.
    failNextConnects: 0,
    // hap-controller rejects BLE timeouts with a plain string, not an Error.
    failNextPairs: 0,
    calls: [],
    ...overrides,
  };
}

function advertisement(device, overrides = {}) {
  return {
    name: "Qingping Temp RH H",
    DeviceID: device.deviceId.toLowerCase(),
    ACID: 10,
    GSN: 1,
    CN: 1,
    availableToPair: !device.paired,
    peripheral: {
      id: "cb81d1b000a5",
      address: "cb:81:d1:b0:00:a5",
      state: "disconnected",
      async disconnectAsync() {
        device.calls.push("peripheral:disconnect");
        this.state = "disconnected";
        // Like hap-controller: its watchers give up on a disconnect.
        device.onPeripheralDisconnect?.();
      },
    },
    ...overrides,
  };
}

// `withNoble`: also expose a fake noble instance (scanStart/discover events),
// as loadHap does, so the platform's live-advertisement tracking is active.
function createFakeHap(device, { withNoble = false } = {}) {
  // Like noble's D-Bus binding: starting/stopping a scan emits
  // scanStart/scanStop on the noble instance.
  const noble = withNoble ? new EventEmitter() : undefined;

  class BLEDiscovery extends EventEmitter {
    constructor() {
      super();
      this.started = false;
      this.stopped = false;
    }
    start() {
      this.started = true;
      this.scanning = true;
      device.calls.push("scan:start");
      noble?.emit("scanStart");
    }
    stop() {
      this.stopped = true;
      this.scanning = false;
      device.calls.push("scan:stop");
      noble?.emit("scanStop");
    }
    async getPairMethod() {
      return 0;
    }
  }

  class GattClient {
    constructor(deviceId, peripheral, pairingData) {
      this.deviceId = deviceId;
      this.peripheral = peripheral;
      this.pairingData = pairingData;
      this.closed = false;
    }
    requirePairing() {
      if (!device.paired || this.pairingData?.iOSDevicePairingID !== "ctrl") {
        throw new Error("M2: authentication error");
      }
    }
    async pairSetup(pin) {
      device.calls.push("pairSetup");
      if (device.scanningDuringConnect?.()) {
        throw "le-connection-abort-by-local";
      }
      if (device.failNextPairs > 0) {
        device.failNextPairs -= 1;
        throw "Timeout";
      }
      if (pin !== device.setupCode) {
        throw new Error("M4: authentication error");
      }
      // A promise to hold the pairing on, e.g. to let it finish late.
      if (device.holdPairing != null) {
        await device.holdPairing;
      }
      device.paired = true;
    }
    getLongTermData() {
      return {
        AccessoryPairingID: device.deviceId,
        iOSDevicePairingID: "ctrl",
      };
    }
    async getAccessories() {
      device.calls.push("getAccessories");
      this.requirePairing();
      return device.database;
    }
    async getCharacteristics(list) {
      device.calls.push(`read:${list.map((a) => a.iid).join(",")}`);
      // Like hap-controller on noble 2's D-Bus binding: a peripheral left in
      // 'error'/'disconnecting' by a failed connect never finishes the
      // disconnect hap-controller sends first, so every attempt times out.
      if (["error", "disconnecting"].includes(this.peripheral?.state)) {
        this.peripheral.state = "disconnecting";
        throw "Timeout";
      }
      if (device.failNextConnects > 0) {
        device.failNextConnects -= 1;
        if (this.peripheral != null) {
          this.peripheral.state = "error";
        }
        throw "le-connection-abort-by-local";
      }
      if (device.scanningDuringConnect?.()) {
        throw "le-connection-abort-by-local";
      }
      this.requirePairing();
      // A promise to hold reads on, to test what happens mid-read.
      if (device.holdReads != null) {
        await device.holdReads;
      }
      if (device.failNextReads > 0) {
        device.failNextReads -= 1;
        throw device.readError ?? "Timeout";
      }
      return {
        characteristics: list.map((address) => ({
          iid: address.iid,
          value: device.values[address.iid],
        })),
      };
    }
    async close() {
      this.closed = true;
    }
  }

  return {
    BLEDiscovery,
    GattClient,
    characteristicFromUuid: (uuid) => NAMES[uuid] ?? uuid,
    serviceFromUuid: (uuid) => NAMES[uuid] ?? uuid,
    noble,
  };
}

function createSilentLog() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createRecordingLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const log = {};
  for (const level of Object.keys(lines)) {
    log[level] = (...args) => lines[level].push(args.join(" "));
  }
  return { log, lines };
}

// In-memory stand-in for DeviceStore.
function createMemoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    load: (deviceId) =>
      data.has(deviceId) ? structuredClone(data.get(deviceId)) : null,
    save: (deviceId, value) => data.set(deviceId, structuredClone(value)),
    backup: (deviceId, value) =>
      data.set(`${deviceId}.bak`, structuredClone(value)),
  };
}

// Lets pending promise chains (queue → client → callbacks) run to
// completion. setImmediate isn't among the mocked timer APIs in these tests,
// so it keeps working while setTimeout/setInterval are frozen.
async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

module.exports = {
  createFakeDevice,
  createFakeHap,
  advertisement,
  cgg1hDatabase,
  createSilentLog,
  createRecordingLog,
  createMemoryStore,
  flush,
};
