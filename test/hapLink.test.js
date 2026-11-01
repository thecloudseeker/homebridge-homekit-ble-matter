const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const GattProtocol =
  require("hap-controller/lib/transport/ble/gatt-protocol").default;
const GattUtils = require("hap-controller/lib/transport/ble/gatt-utils");
const GattConstants = require("hap-controller/lib/transport/ble/gatt-constants");
const tlv = require("hap-controller/lib/model/tlv");
const { HapLink, HapStatusError, responseBody } = require("../lib/hapLink");

// A HomeKit Bluetooth device at the PDU level: requests are parsed the way
// a device would (opcode, transaction ID, instance ID, TLV body) and
// answered with a status and, for reads, the value. Built with
// hap-controller's real protocol code; only the radio is fake.

const OPCODE = {
  write: GattConstants.Opcodes["HAP-Characteristic-Write"],
  read: GattConstants.Opcodes["HAP-Characteristic-Read"],
  timedWrite: GattConstants.Opcodes["HAP-Characteristic-Timed-Write"],
  executeWrite: GattConstants.Opcodes["HAP-Characteristic-Execute-Write"],
};
const VALUE = GattConstants.Types["HAP-Param-Value"];

function fakeDevice(characteristics) {
  const device = {
    values: {},
    requests: [],
    pendingTimed: null,
    refuse: null, // a status to answer the next write with
  };
  const peripheral = new EventEmitter();
  peripheral.state = "disconnected";
  const gattCharacteristics = characteristics.map(
    ({ iid, uuid, service, format, value, indicate = true }) => {
      device.values[iid] = { format, value };
      const characteristic = new EventEmitter();
      Object.assign(characteristic, {
        iid,
        uuid,
        _serviceUuid: service,
        properties: indicate
          ? ["read", "write", "indicate"]
          : ["read", "write"],
        subscribed: false,
        async subscribeAsync() {
          this.subscribed = true;
        },
      });
      return characteristic;
    },
  );
  peripheral.discoverSomeServicesAndCharacteristicsAsync = async () => ({
    characteristics: gattCharacteristics,
  });

  function respond(tid, status, body) {
    const header = Buffer.from([0x02, tid, status, 0, 0]);
    if (body == null) {
      return [header.subarray(0, 3)];
    }
    header.writeUInt16LE(body.length, 3);
    return [Buffer.concat([header, body])];
  }

  class GattConnection extends EventEmitter {
    isConnected() {
      return peripheral.state === "connected";
    }
    async connect() {
      peripheral.state = "connected";
    }
    async disconnect() {
      peripheral.state = "disconnected";
      this.emit("disconnected");
    }
    async writeCharacteristic(characteristic, [pdu]) {
      const opcode = pdu.readUInt8(1);
      const tid = pdu.readUInt8(2);
      const iid = pdu.readUInt16LE(3);
      // A request must go to the GATT characteristic its iid lives on.
      if (iid !== characteristic.iid) {
        return respond(tid, 5); // Invalid instance ID
      }
      device.requests.push({ opcode, iid });
      const stored = device.values[iid];
      if (opcode === OPCODE.read) {
        const body = tlv.encodeObject(
          new Map([
            [VALUE, GattUtils.valueToBuffer(stored.value, stored.format)],
          ]),
        );
        return respond(tid, 0, body);
      }
      const body = tlv.decodeBuffer(pdu.subarray(7));
      if (opcode === OPCODE.write || opcode === OPCODE.timedWrite) {
        if (device.refuse != null) {
          const status = device.refuse;
          device.refuse = null;
          return respond(tid, status);
        }
        const value = GattUtils.bufferToValue(body.get(VALUE), stored.format);
        if (opcode === OPCODE.timedWrite) {
          device.pendingTimed = { iid, value };
        } else {
          stored.value = value;
        }
        return respond(tid, 0);
      }
      if (opcode === OPCODE.executeWrite && device.pendingTimed?.iid === iid) {
        device.values[iid].value = device.pendingTimed.value;
        device.pendingTimed = null;
        return respond(tid, 0);
      }
      return respond(tid, 1);
    }
  }

  let tid = 0;
  const client = {
    gattProtocol: new GattProtocol(),
    getNextTransactionId: () => (tid = (tid + 1) % 255),
    verified: false,
    async _pairVerify() {
      this.verified = true;
    },
    async _readInstanceId(characteristic) {
      return characteristic.iid;
    },
  };
  return {
    device,
    peripheral,
    client,
    characteristics: gattCharacteristics,
    gatt: { GattConnection, GattUtils, GattConstants, tlv },
  };
}

// Two outlets: the same service and characteristic UUIDs, different iids.
const OUTLET = "0000004700001000800000264bb765291";
const ON = "0000002500001000800000264bb765291";
const addresses = {
  outletOn: {
    serviceUuid: OUTLET,
    characteristicUuid: ON,
    iid: 11,
    format: "bool",
    perms: ["pr", "pw", "ev"],
  },
  "outletOn.2": {
    serviceUuid: OUTLET,
    characteristicUuid: ON,
    iid: 21,
    format: "bool",
    perms: ["pr", "pw", "ev"],
  },
};

async function openOutlets() {
  const fake = fakeDevice([
    { iid: 11, uuid: ON, service: OUTLET, format: "bool", value: false },
    { iid: 21, uuid: ON, service: OUTLET, format: "bool", value: false },
  ]);
  const link = new HapLink({
    client: fake.client,
    peripheral: fake.peripheral,
    addresses,
    gatt: fake.gatt,
  });
  await link.open();
  return { ...fake, link };
}

test("opening verifies the pairing and subscribes to what announces changes", async () => {
  const { link, client, characteristics } = await openOutlets();
  assert.equal(link.isOpen, true);
  assert.equal(client.verified, true);
  assert.ok(characteristics.every((c) => c.subscribed));
});

test("a write goes to the characteristic with its instance ID, not the first of its type", async () => {
  const { link, device } = await openOutlets();
  await link.write([{ address: addresses["outletOn.2"], value: 1 }]);
  assert.equal(device.values[21].value, true);
  assert.equal(device.values[11].value, false);
});

test("reads decode each value in its format", async () => {
  const fake = fakeDevice([
    { iid: 31, uuid: "b", service: "s", format: "float", value: 21.5 },
    { iid: 32, uuid: "c", service: "s", format: "uint8", value: 2 },
  ]);
  const link = new HapLink({
    client: fake.client,
    peripheral: fake.peripheral,
    addresses: {},
    gatt: fake.gatt,
  });
  await link.open();
  link.addresses = {
    target: { iid: 31, format: "float" },
    mode: { iid: 32, format: "uint8" },
  };
  // Characteristics are found when opening; here they're known directly.
  for (const c of fake.characteristics) {
    link.characteristics.set(c.iid, c);
  }
  assert.deepEqual(await link.read(link.addresses), { target: 21.5, mode: 2 });
});

test("a write the device refuses rejects, with what the device said", async () => {
  const { link, device } = await openOutlets();
  device.refuse = 6; // Invalid request
  await assert.rejects(
    link.write([{ address: addresses.outletOn, value: 1 }]),
    (error) => error instanceof HapStatusError && error.status === 6,
  );
  assert.equal(device.values[11].value, false);
});

test("a characteristic that asks for a timed write is prepared, then executed", async () => {
  const LOCK_TARGET = "0000001E00001000800000264bb765291";
  const fake = fakeDevice([
    { iid: 41, uuid: LOCK_TARGET, service: "lock", format: "uint8", value: 0 },
  ]);
  const address = {
    serviceUuid: "lock",
    characteristicUuid: LOCK_TARGET,
    iid: 41,
    format: "uint8",
    perms: ["pr", "pw", "ev", "tw"],
  };
  const link = new HapLink({
    client: fake.client,
    peripheral: fake.peripheral,
    addresses: { lockTarget: address },
    gatt: fake.gatt,
  });
  await link.open();
  await link.write([{ address, value: 1 }]);
  assert.deepEqual(
    fake.device.requests.map((r) => r.opcode),
    [OPCODE.timedWrite, OPCODE.executeWrite],
  );
  assert.equal(fake.device.values[41].value, 1);
});

test("an indication is read and passed on as a change", async () => {
  const { link, device, characteristics } = await openOutlets();
  const changes = [];
  link.on("change", (values) => changes.push(values));
  device.values[21].value = true; // switched on at the device
  characteristics[1].emit("data", Buffer.alloc(0));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [{ "outletOn.2": true }]);
});

test("a dropped connection closes the link, and it refuses further requests", async () => {
  const { link } = await openOutlets();
  let closed = 0;
  link.on("close", () => (closed += 1));
  await link.connection.disconnect();
  assert.equal(closed, 1);
  assert.equal(link.isOpen, false);
  await assert.rejects(
    link.write([{ address: addresses.outletOn, value: 1 }]),
    /Not connected/,
  );
});

test("a response split over several PDUs is put back together", () => {
  const body = Buffer.from([1, 2, 3, 4, 5, 6]);
  const first = Buffer.concat([
    Buffer.from([0x02, 7, 0, body.length, 0]),
    body.subarray(0, 4),
  ]);
  const second = Buffer.concat([Buffer.from([0x82, 7]), body.subarray(4)]);
  assert.deepEqual(responseBody([first, second]), body);
});
