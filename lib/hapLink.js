const { EventEmitter } = require("events");

// One open, verified HomeKit Bluetooth connection to a device: reads and
// writes characteristics over it, and passes on the changes the device
// announces while connected. hap-controller opens a fresh connection for
// every operation - seconds each, too slow for switching a light - and its
// own write finds the GATT characteristic by service only (on a light, a
// brightness write could go to "on") and never checks the device's answer.
//
// Built on hap-controller's GATT pieces (its connection, pair-verify and
// PDU protocol), which are internal: hap-controller is pinned to an exact
// version (see lib/hap.js).
//
// `addresses`: reading key → {serviceUuid, characteristicUuid, iid, format,
// perms} from parseAccessoryDatabase.

// HAP-BLE: a timed write expires after this (TTL in 100 ms units).
const TIMED_WRITE_TTL = 50;
const STATUS_SUCCESS = 0;

class HapStatusError extends Error {
  constructor(status, statusText) {
    super(`The device refused: ${statusText ?? `status ${status}`}`);
    this.status = status;
  }
}

// A complete response's status: [control, TID, status, ...].
function responseStatus(pdus) {
  if (!Array.isArray(pdus) || pdus.length === 0 || pdus[0].length < 3) {
    throw new Error("The device sent no response");
  }
  return pdus[0].readUInt8(2);
}

// A response's body, put back together from its fragments: the first PDU
// carries a 5-byte header, each continuation a 2-byte one.
function responseBody(pdus) {
  const [first, ...rest] = pdus;
  if (first.length < 5) {
    return Buffer.alloc(0);
  }
  const length = first.readUInt16LE(3);
  return Buffer.concat([
    first.subarray(5),
    ...rest.map((pdu) => pdu.subarray(2)),
  ]).subarray(0, length);
}

class HapLink extends EventEmitter {
  // `client`: a hap-controller GattClient for the device, with its pairing.
  // `gatt`: hap-controller's GATT modules {GattConnection, GattUtils,
  // GattConstants, tlv} (see loadHap).
  constructor({ client, peripheral, addresses, gatt }) {
    super();
    this.client = client;
    this.peripheral = peripheral;
    this.addresses = addresses;
    this.gatt = gatt;
    this.connection = null;
    // iid → noble characteristic.
    this.characteristics = new Map();
    this.closed = false;
  }

  get isOpen() {
    return !this.closed && this.connection?.isConnected() === true;
  }

  // Connects, verifies the pairing, finds each characteristic by its HAP
  // instance ID (two services of a kind share UUIDs, but not iids), and
  // (`subscribe`) subscribes to every one that announces changes.
  async open({ subscribe = true } = {}) {
    const { GattConnection, GattUtils } = this.gatt;
    const connection = new GattConnection(this.peripheral);
    this.connection = connection;
    connection.once("disconnected", () => this.handleClose());
    await connection.connect();
    await this.client._pairVerify(connection);
    const addresses = Object.values(this.addresses);
    const services = [
      ...new Set(
        addresses.map((a) => GattUtils.uuidToNobleUuid(a.serviceUuid)),
      ),
    ];
    const uuids = [
      ...new Set(
        addresses.map((a) => GattUtils.uuidToNobleUuid(a.characteristicUuid)),
      ),
    ];
    const { characteristics } = await new GattUtils.Watcher(
      this.peripheral,
      this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
        services,
        uuids,
      ),
    ).getPromise();
    for (const characteristic of characteristics) {
      try {
        const iid = await this.client._readInstanceId(characteristic);
        this.characteristics.set(iid, characteristic);
      } catch {
        // Not a HAP characteristic (no instance ID).
      }
    }
    for (const [key, address] of Object.entries(this.addresses)) {
      if (subscribe && address.perms?.includes("ev")) {
        await this.subscribe(key, address);
      }
    }
  }

  async subscribe(key, address) {
    const characteristic = this.characteristic(address);
    if (!characteristic.properties?.includes("indicate")) {
      return;
    }
    // HAP-BLE indications carry no value: they say "read me".
    characteristic.on("data", (data) => {
      if (Buffer.isBuffer(data) && data.length === 0 && this.isOpen) {
        this.read({ [key]: address })
          .then((values) => this.emit("change", values))
          .catch((error) => this.emit("warning", error));
      }
    });
    await new this.gatt.GattUtils.Watcher(
      this.peripheral,
      characteristic.subscribeAsync(),
    ).getPromise();
  }

  characteristic(address) {
    const characteristic = this.characteristics.get(address.iid);
    if (characteristic == null) {
      throw new Error(`Characteristic ${address.iid} not found on the device`);
    }
    return characteristic;
  }

  // `addresses`: key → address. Resolves to key → raw HAP value.
  async read(addresses) {
    const { GattConstants, GattUtils, tlv } = this.gatt;
    const values = {};
    for (const [key, address] of Object.entries(addresses)) {
      const pdus = await this.request(
        address,
        this.client.gattProtocol.buildCharacteristicReadRequest(
          this.client.getNextTransactionId(),
          address.iid,
        ),
      );
      const value = tlv
        .decodeBuffer(responseBody(pdus))
        .get(GattConstants.Types["HAP-Param-Value"]);
      if (value != null) {
        values[key] = GattUtils.bufferToValue(value, address.format);
      }
    }
    return values;
  }

  // `writes`: [{address, value}], value a raw HAP value. One after another,
  // each confirmed by the device. A characteristic that asks for it ("tw":
  // locks, garage doors) gets HAP's timed write: prepared, then executed.
  async write(writes) {
    const { GattConstants, GattUtils } = this.gatt;
    const protocol = this.client.gattProtocol;
    for (const { address, value } of writes) {
      const body = new Map([
        [
          GattConstants.Types["HAP-Param-Value"],
          GattUtils.valueToBuffer(value, address.format),
        ],
      ]);
      if (address.perms?.includes("tw")) {
        body.set(
          GattConstants.Types["HAP-Param-TTL"],
          Buffer.from([TIMED_WRITE_TTL]),
        );
        await this.request(
          address,
          protocol.buildCharacteristicTimedWriteRequest(
            this.client.getNextTransactionId(),
            address.iid,
            body,
          ),
        );
        await this.request(
          address,
          protocol.buildCharacteristicExecuteWriteRequest(
            this.client.getNextTransactionId(),
            address.iid,
          ),
        );
      } else {
        await this.request(
          address,
          protocol.buildCharacteristicWriteRequest(
            this.client.getNextTransactionId(),
            address.iid,
            body,
          ),
        );
      }
    }
  }

  // Sends one request PDU and returns the response's PDUs, if successful.
  async request(address, pdu) {
    if (!this.isOpen) {
      throw new Error("Not connected");
    }
    const pdus = await this.connection.writeCharacteristic(
      this.characteristic(address),
      [pdu],
    );
    const status = responseStatus(pdus);
    if (status !== STATUS_SUCCESS) {
      throw new HapStatusError(
        status,
        this.gatt.GattConstants.HapStatusCodes?.[status]?.definition,
      );
    }
    return pdus;
  }

  handleClose() {
    if (!this.closed) {
      this.closed = true;
      this.emit("close");
    }
  }

  async close() {
    this.closed = true;
    await this.connection?.disconnect().catch(() => {});
  }
}

module.exports = { HapLink, HapStatusError, responseStatus, responseBody };
