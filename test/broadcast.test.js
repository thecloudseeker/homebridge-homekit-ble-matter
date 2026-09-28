const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const GattProtocol =
  require("hap-controller/lib/transport/ble/gatt-protocol").default;
const tlv = require("hap-controller/lib/model/tlv");
const {
  parseEncryptedNotification,
  decryptNotification,
  encryptNotification,
  decodeValue,
  deriveBroadcastKey,
  advertisingIdFromDeviceId,
  configureBroadcasts,
  gsnAfter,
  gsnDistance,
} = require("../lib/broadcast");

const KEY = crypto.randomBytes(32);
const ID = Buffer.from("412114E5C225", "hex");
const value = (byte) => Buffer.from([byte, 0, 0, 0, 0, 0, 0, 0]);

test("an encrypted notification decrypts to its GSN, iid and value", () => {
  const data = encryptNotification(KEY, ID, 1234, 11, value(1));
  assert.equal(data.length, 26);
  assert.deepEqual(decryptNotification(data, KEY, 1230), {
    gsn: 1234,
    iid: 11,
    value: value(1),
  });
});

test("it's found across the GSN wrap (65535 → 1)", () => {
  const data = encryptNotification(KEY, ID, 2, 11, value(1));
  assert.equal(decryptNotification(data, KEY, 65530)?.gsn, 2);
});

test("a wrong key, a tampered byte, another advertising identifier, or a GSN out of range: null", () => {
  const data = encryptNotification(KEY, ID, 50, 11, value(1));
  assert.equal(decryptNotification(data, crypto.randomBytes(32), 45), null);
  const tampered = Buffer.from(data);
  tampered[12] ^= 1;
  assert.equal(decryptNotification(tampered, KEY, 45), null);
  const otherId = Buffer.from(data);
  otherId[4] ^= 1;
  assert.equal(decryptNotification(otherId, KEY, 45), null);
  assert.equal(decryptNotification(data, KEY, 500), null);
});

test("only Apple's type-0x11 manufacturer data counts as a notification", () => {
  const data = encryptNotification(KEY, ID, 50, 11, value(1));
  assert.ok(parseEncryptedNotification(data));
  const plain = Buffer.from(data);
  plain[2] = 0x06; // a regular HomeKit advertisement
  assert.equal(parseEncryptedNotification(plain), null);
  assert.equal(parseEncryptedNotification(Buffer.alloc(5)), null);
  assert.equal(parseEncryptedNotification(undefined), null);
});

test("values decode by the characteristic's format", () => {
  const buf = Buffer.alloc(8);
  buf.writeFloatLE(21.5, 0);
  assert.equal(decodeValue(buf, "float"), 21.5);
  assert.equal(decodeValue(value(1), "bool"), 1);
  assert.equal(decodeValue(value(200), "uint8"), 200);
  const u16 = Buffer.alloc(8);
  u16.writeUInt16LE(812, 0);
  assert.equal(decodeValue(u16, "uint16"), 812);
  const int = Buffer.alloc(8);
  int.writeInt32LE(-5, 0);
  assert.equal(decodeValue(int, "int"), -5);
  assert.equal(decodeValue(value(1), "string"), undefined);
});

test("GSN arithmetic wraps from 65535 to 1", () => {
  assert.equal(gsnAfter(65535, 1), 1);
  assert.equal(gsnAfter(1, -1), 65535);
  assert.equal(gsnAfter(10, -16), 65529);
  assert.equal(gsnDistance(65534, 3), 4);
  assert.equal(gsnDistance(5, 5), 0);
});

test("the broadcast key derivation is HKDF-SHA-512, 32 bytes, deterministic", () => {
  const secret = crypto.randomBytes(32);
  const ltpk = crypto.randomBytes(32);
  const a = deriveBroadcastKey(secret, ltpk);
  assert.equal(a.length, 32);
  assert.deepEqual(a, deriveBroadcastKey(secret, ltpk));
  assert.notDeepEqual(a, deriveBroadcastKey(secret, crypto.randomBytes(32)));
});

test("a DeviceID is the default advertising identifier", () => {
  assert.deepEqual(advertisingIdFromDeviceId("41:21:14:e5:c2:25"), ID);
  assert.equal(advertisingIdFromDeviceId("nope"), null);
});

// A device answering the configuration requests, speaking the PDUs that
// hap-controller's GattProtocol builds and parses.
function fakeDevice({ keyInResponse = true, charStatus = 0 } = {}) {
  const requests = [];
  const deviceKey = crypto.randomBytes(32);
  const response = (tid, status, body) => {
    const encoded = tlv.encodeObject(body);
    const buf = Buffer.alloc(5 + encoded.length);
    buf.writeUInt8(0x02, 0);
    buf.writeUInt8(tid, 1);
    buf.writeUInt8(status, 2);
    buf.writeUInt16LE(encoded.length, 3);
    encoded.copy(buf, 5);
    return buf;
  };
  const characteristic = (uuid) => ({
    uuid,
    readAsync: async () => Buffer.from([0x30, 0x00]), // service iid 48
  });
  const peripheral = {
    once() {},
    removeListener() {},
    async discoverSomeServicesAndCharacteristicsAsync(services, chars) {
      return { characteristics: chars.map(characteristic) };
    },
  };
  const internals = {
    GattConnection: class {
      async connect() {}
      async disconnect() {
        requests.push("disconnect");
      }
      async writeCharacteristic(target, [pdu]) {
        const opcode = pdu.readUInt8(1);
        const tid = pdu.readUInt8(2);
        const iid = pdu.readUInt16LE(3);
        const body = tlv.decodeBuffer(pdu.subarray(7));
        requests.push({ opcode, iid, body });
        if (opcode === 8) {
          const params = new Map([
            [1, Buffer.from([0x2a, 0x00])],
            [2, Buffer.from([3])],
            [3, ID],
          ]);
          if (keyInResponse) {
            params.set(4, deviceKey);
          }
          return [response(tid, 0, params)];
        }
        return [response(tid, charStatus, new Map())];
      }
    },
    GattUtils: {
      uuidToNobleUuid: (uuid) => uuid.toLowerCase(),
      Watcher: class {
        constructor(peripheral, promise) {
          this.promise = promise;
        }
        getPromise() {
          return this.promise;
        }
      },
    },
    GattConstants: require("hap-controller/lib/transport/ble/gatt-constants"),
    Service: require("hap-controller/lib/model/service"),
  };
  let tid = 0;
  const secret = crypto.randomBytes(32);
  const ltpk = crypto.randomBytes(32);
  const client = {
    gattProtocol: new GattProtocol(),
    getNextTransactionId: () => (tid = (tid + 1) % 256),
    async _pairVerify() {
      requests.push("pair-verify");
    },
    pairingProtocol: {
      pairVerify: { sharedSecret: secret },
      iOSDeviceLTPK: ltpk,
    },
  };
  return { requests, deviceKey, internals, peripheral, client, secret, ltpk };
}

const TARGETS = [
  {
    serviceUuid: "00000080-0000-1000-8000-0026BB765291",
    characteristicUuid: "0000006A-0000-1000-8000-0026BB765291",
    iid: 11,
  },
];

test("configureBroadcasts: verifies, asks for the key, enables broadcasts, disconnects", async () => {
  const device = fakeDevice();
  const result = await configureBroadcasts(
    device.client,
    device.peripheral,
    TARGETS,
    device.internals,
  );
  const [verify, protocol, enable, disconnect] = device.requests;
  assert.equal(verify, "pair-verify");
  assert.equal(protocol.opcode, 8, "Protocol Configuration");
  assert.equal(protocol.iid, 48, "addressed to the protocol service");
  assert.deepEqual([...protocol.body.keys()], [1, 2], "generate key + get all");
  assert.equal(enable.opcode, 7, "Characteristic Configuration");
  assert.equal(enable.iid, 11);
  assert.deepEqual(enable.body.get(1), Buffer.from([1, 0]), "enable broadcast");
  assert.deepEqual(enable.body.get(2), Buffer.from([1]), "20 ms interval");
  assert.equal(disconnect, "disconnect");
  assert.deepEqual(result, {
    key: device.deviceKey,
    advertisingId: ID,
    gsn: 42,
    configNumber: 3,
    enabled: [11],
  });
});

test("configureBroadcasts derives the key when the device doesn't send it", async () => {
  const device = fakeDevice({ keyInResponse: false });
  const { key } = await configureBroadcasts(
    device.client,
    device.peripheral,
    TARGETS,
    device.internals,
  );
  assert.deepEqual(key, deriveBroadcastKey(device.secret, device.ltpk));
});

test("configureBroadcasts reports a device's refusal with its HAP status, and still disconnects", async () => {
  const device = fakeDevice({ charStatus: 1 });
  await assert.rejects(
    configureBroadcasts(
      device.client,
      device.peripheral,
      TARGETS,
      device.internals,
    ),
    (error) => error.hapStatus === 1,
  );
  assert.equal(device.requests.at(-1), "disconnect");
});

test("the request PDUs have the layout hap-controller's own builder produces", async () => {
  const device = fakeDevice();
  const pdus = [];
  const write = device.internals.GattConnection.prototype.writeCharacteristic;
  device.internals.GattConnection.prototype.writeCharacteristic = function (
    target,
    [pdu],
  ) {
    pdus.push(pdu);
    return write.call(this, target, [pdu]);
  };
  await configureBroadcasts(
    device.client,
    device.peripheral,
    TARGETS,
    device.internals,
  );
  const [protocol, enable] = pdus;
  // Same framing, body built by the reference encoder (non-empty values).
  const reference = new GattProtocol().buildCharacteristicConfigurationRequest(
    enable.readUInt8(2),
    11,
    new Map([
      [1, Buffer.from([1, 0])],
      [2, Buffer.from([1])],
    ]),
  );
  assert.deepEqual(enable, reference);
  // The Protocol Configuration body keeps its two empty parameters.
  assert.deepEqual(protocol.subarray(5), Buffer.from([4, 0, 1, 0, 2, 0]));
});
