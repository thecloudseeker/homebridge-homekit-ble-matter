const crypto = require("crypto");

// HomeKit Bluetooth "broadcast notifications": instead of waiting for the
// next poll, a device announces a changed value right away, in an encrypted
// advertisement (manufacturer data type 0x11) that only its paired
// controllers can read. That's what makes a door or motion sensor usable:
// reading on the "state changed" signal alone takes seconds to connect, and
// is capped at one read per 5 minutes to spare the battery.
//
// Setting it up takes one connection (see configureBroadcasts): the
// controller asks the device for a broadcast key (a Protocol Configuration
// request) and enables broadcasting per characteristic (Characteristic
// Configuration requests). hap-controller builds these requests but never
// sends them, and ignores the encrypted advertisements ("ignoring for now"),
// so this is done here with its internals - pinned to hap-controller 0.10.2.
//
// Encrypted notification layout (after Apple's company ID 0x004C):
//   type 0x11, sub-type/length, advertising identifier (6 bytes),
//   ChaCha20-Poly1305 ciphertext (12 bytes: GSN, iid, value (8 bytes)),
//   authentication tag truncated to 4 bytes.
// The nonce is the device's global state number (GSN), which is itself only
// inside the ciphertext - so candidates just past the last known GSN are
// tried until one authenticates and decrypts to that same GSN.

const APPLE_COMPANY_ID = 0x004c;
const TYPE_ENCRYPTED_NOTIFICATION = 0x11;
const NOTIFICATION_LENGTH = 26;
const TAG_LENGTH = 4;
// GSNs are 16 bits and wrap from 65535 to 1.
const GSN_MAX = 65535;
// How far past the last known GSN a notification's GSN is looked for.
const GSN_LOOKAHEAD = 96;

// Protocol Configuration request parameters (HAP-BLE).
const PROTOCOL_GENERATE_BROADCAST_KEY = 1;
const PROTOCOL_GET_ALL_PARAMS = 2;
// ...and the response's.
const RESPONSE_STATE_NUMBER = 1;
const RESPONSE_CONFIG_NUMBER = 2;
const RESPONSE_ADVERTISING_ID = 3;
const RESPONSE_BROADCAST_KEY = 4;
// Characteristic Configuration request parameters.
const CHARACTERISTIC_PROPERTIES = 1;
const CHARACTERISTIC_BROADCAST_INTERVAL = 2;
const PROPERTY_ENABLE_BROADCAST = 0x0001;
// 20 ms: the notification is sent quickly and repeated for a few seconds.
const BROADCAST_INTERVAL_20MS = 0x01;

// A key is regenerated before its GSN range runs out: the device stops
// using a broadcast key after 32767 state changes.
const KEY_GSN_BUDGET = 32000;

// `steps` may be negative.
function gsnAfter(gsn, steps) {
  return ((((gsn - 1 + steps) % GSN_MAX) + GSN_MAX) % GSN_MAX) + 1;
}

// How many steps `later` is after `earlier`, across the wrap.
function gsnDistance(earlier, later) {
  return (later - earlier + GSN_MAX) % GSN_MAX;
}

// The encrypted-notification parts of a manufacturer data buffer (with the
// company ID in front, as noble reports it), or null if it isn't one.
function parseEncryptedNotification(manufacturerData) {
  if (
    !Buffer.isBuffer(manufacturerData) ||
    manufacturerData.length < NOTIFICATION_LENGTH ||
    manufacturerData.readUInt16LE(0) !== APPLE_COMPANY_ID ||
    manufacturerData[2] !== TYPE_ENCRYPTED_NOTIFICATION
  ) {
    return null;
  }
  return {
    advertisingId: manufacturerData.subarray(4, 10),
    ciphertext: manufacturerData.subarray(10, 22),
    tag: manufacturerData.subarray(22, 26),
  };
}

function nonceFor(gsn) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt16LE(gsn, 4);
  return nonce;
}

function tryDecrypt(key, gsn, { advertisingId, ciphertext, tag }) {
  try {
    const decipher = crypto.createDecipheriv(
      "chacha20-poly1305",
      key,
      nonceFor(gsn),
      { authTagLength: TAG_LENGTH },
    );
    decipher.setAAD(advertisingId);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

// Decrypts an encrypted notification: {gsn, iid, value (8-byte Buffer)}, or
// null if it isn't one for this key (another device's). GSNs after
// `fromGsn` are tried; the caller decides whether it's new.
function decryptNotification(manufacturerData, key, fromGsn) {
  const notification = parseEncryptedNotification(manufacturerData);
  if (notification == null || key == null) {
    return null;
  }
  for (let step = 1; step <= GSN_LOOKAHEAD; step += 1) {
    const gsn = gsnAfter(fromGsn ?? 0, step);
    const plain = tryDecrypt(key, gsn, notification);
    if (plain != null && plain.readUInt16LE(0) === gsn) {
      return { gsn, iid: plain.readUInt16LE(2), value: plain.subarray(4, 12) };
    }
  }
  return null;
}

// The inverse, for tests and simulation.
function encryptNotification(key, advertisingId, gsn, iid, value) {
  const plain = Buffer.alloc(12);
  plain.writeUInt16LE(gsn, 0);
  plain.writeUInt16LE(iid, 2);
  value.copy(plain, 4, 0, Math.min(8, value.length));
  const cipher = crypto.createCipheriv(
    "chacha20-poly1305",
    key,
    nonceFor(gsn),
    { authTagLength: TAG_LENGTH },
  );
  cipher.setAAD(advertisingId);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const data = Buffer.alloc(NOTIFICATION_LENGTH);
  data.writeUInt16LE(APPLE_COMPANY_ID, 0);
  data[2] = TYPE_ENCRYPTED_NOTIFICATION;
  data[3] = 0x36; // sub-type 1, length 22
  advertisingId.copy(data, 4);
  ciphertext.copy(data, 10);
  cipher.getAuthTag().copy(data, 22);
  return data;
}

// A notification's 8 value bytes (little-endian, zero-padded) as the HAP
// value of a characteristic with `format`.
function decodeValue(value, format) {
  switch (format) {
    case "bool":
    case "uint8":
      return value.readUInt8(0);
    case "uint16":
      return value.readUInt16LE(0);
    case "uint32":
      return value.readUInt32LE(0);
    case "uint64":
      return Number(value.readBigUInt64LE(0));
    case "int":
      return value.readInt32LE(0);
    case "float":
      return value.readFloatLE(0);
    default:
      return undefined;
  }
}

// HomeKit's key derivation for broadcasts, from the current pair-verify
// session: HKDF-SHA-512 over its shared secret, salted with the controller's
// long-term public key. Used if the device doesn't return the key itself.
function deriveBroadcastKey(sharedSecret, controllerLtpk) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha512",
      sharedSecret,
      controllerLtpk,
      "Broadcast-Encryption-Key",
      32,
    ),
  );
}

// "41:21:14:E5:C2:25" → the 6 bytes a device advertises as its identifier
// (a HomeKit device's advertising identifier is its DeviceID unless a
// controller set another).
function advertisingIdFromDeviceId(deviceId) {
  const hex = String(deviceId ?? "").replace(/[^0-9a-f]/gi, "");
  return hex.length === 12 ? Buffer.from(hex, "hex") : null;
}

// HAP-BLE request opcodes.
const OPCODE_CHARACTERISTIC_CONFIGURATION = 7;
const OPCODE_PROTOCOL_CONFIGURATION = 8;

// TLV entries ([type, Buffer]) → bytes. Built here rather than with
// hap-controller's encoder, which drops zero-length values - and the
// Protocol Configuration parameters are exactly that: a type with no value.
function encodeTlv(entries) {
  return Buffer.concat(
    entries.map(([type, value]) =>
      Buffer.concat([Buffer.from([type, value.length]), value]),
    ),
  );
}

// A HAP-BLE request PDU: control field, opcode, transaction id, the
// addressed instance id, body length, body.
function buildRequest(opcode, tid, instanceId, body) {
  const pdu = Buffer.alloc(7 + body.length);
  pdu.writeUInt8(0, 0);
  pdu.writeUInt8(opcode, 1);
  pdu.writeUInt8(tid, 2);
  pdu.writeUInt16LE(instanceId, 3);
  pdu.writeUInt16LE(body.length, 5);
  body.copy(pdu, 7);
  return pdu;
}

// Loads the hap-controller internals configureBroadcasts needs.
function hapInternals() {
  const base = "hap-controller/lib/transport/ble/";
  return {
    GattConnection: require(`${base}gatt-connection`).default,
    GattUtils: require(`${base}gatt-utils`),
    GattConstants: require(`${base}gatt-constants`),
    Service: require("hap-controller/lib/model/service"),
  };
}

function checkStatus(response, what) {
  if (response == null || response.length < 3) {
    throw new Error(`${what}: no response`);
  }
  const status = response.readUInt8(2);
  if (status !== 0) {
    const error = new Error(`${what}: HAP status ${status}`);
    error.hapStatus = status;
    throw error;
  }
}

// Over a verified session with the device: gets a broadcast key and
// enables broadcasts for `targets` ([{serviceUuid, characteristicUuid,
// iid}], the characteristics that support them). `client` is a paired
// hap-controller GattClient for `peripheral`. Returns {key, advertisingId,
// gsn, configNumber, enabled: [iid]}.
async function configureBroadcasts(
  client,
  peripheral,
  targets,
  internals = hapInternals(),
) {
  const { GattConnection, GattUtils, GattConstants, Service } = internals;
  const watch = (promise) =>
    new GattUtils.Watcher(peripheral, promise).getPromise();
  const connection = new GattConnection(peripheral);
  try {
    await connection.connect();
    await client._pairVerify(connection);

    // The Protocol Configuration request goes to the protocol information
    // service's signature characteristic, addressed by the service's iid.
    const serviceUuid = GattUtils.uuidToNobleUuid(
      Service.uuidFromService(
        "public.hap.service.protocol.information.service",
      ),
    );
    const instanceIdUuid = GattUtils.uuidToNobleUuid(
      GattConstants.ServiceInstanceIdUuid,
    );
    const signatureUuid = GattUtils.uuidToNobleUuid(
      GattConstants.ServiceSignatureUuid,
    );
    const { characteristics } = await watch(
      peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [serviceUuid],
        [instanceIdUuid, signatureUuid],
      ),
    );
    const instanceId = characteristics.find((c) => c.uuid === instanceIdUuid);
    const signature = characteristics.find((c) => c.uuid === signatureUuid);
    if (instanceId == null || signature == null) {
      const error = new Error("no protocol information service");
      error.unsupported = true;
      throw error;
    }
    const serviceIid = (await watch(instanceId.readAsync())).readUInt16LE(0);
    const [response] = await connection.writeCharacteristic(signature, [
      buildRequest(
        OPCODE_PROTOCOL_CONFIGURATION,
        client.getNextTransactionId(),
        serviceIid,
        encodeTlv([
          [PROTOCOL_GENERATE_BROADCAST_KEY, Buffer.alloc(0)],
          [PROTOCOL_GET_ALL_PARAMS, Buffer.alloc(0)],
        ]),
      ),
    ]);
    checkStatus(response, "Protocol configuration");
    const { tlv } =
      client.gattProtocol.parseProtocolConfigurationResponse(response);
    const pairing = client.pairingProtocol;
    const key =
      tlv.get(RESPONSE_BROADCAST_KEY)?.length === 32
        ? Buffer.from(tlv.get(RESPONSE_BROADCAST_KEY))
        : deriveBroadcastKey(
            pairing.pairVerify.sharedSecret,
            pairing.iOSDeviceLTPK,
          );
    const advertisingId = tlv.get(RESPONSE_ADVERTISING_ID);
    const gsn = tlv.get(RESPONSE_STATE_NUMBER);
    const configNumber = tlv.get(RESPONSE_CONFIG_NUMBER);

    const enabled = [];
    for (const target of targets) {
      const nobleService = GattUtils.uuidToNobleUuid(target.serviceUuid);
      const nobleCharacteristic = GattUtils.uuidToNobleUuid(
        target.characteristicUuid,
      );
      const found = await watch(
        peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [nobleService],
          [nobleCharacteristic],
        ),
      );
      const characteristic = found.characteristics.find(
        (c) => c.uuid === nobleCharacteristic,
      );
      if (characteristic == null) {
        continue;
      }
      const properties = Buffer.alloc(2);
      properties.writeUInt16LE(PROPERTY_ENABLE_BROADCAST, 0);
      const [answer] = await connection.writeCharacteristic(characteristic, [
        buildRequest(
          OPCODE_CHARACTERISTIC_CONFIGURATION,
          client.getNextTransactionId(),
          target.iid,
          encodeTlv([
            [CHARACTERISTIC_PROPERTIES, properties],
            [
              CHARACTERISTIC_BROADCAST_INTERVAL,
              Buffer.from([BROADCAST_INTERVAL_20MS]),
            ],
          ]),
        ),
      ]);
      checkStatus(answer, `Enabling broadcasts for iid ${target.iid}`);
      enabled.push(target.iid);
    }
    return {
      key,
      advertisingId:
        advertisingId?.length === 6 ? Buffer.from(advertisingId) : null,
      gsn: gsn?.length >= 2 ? gsn.readUInt16LE(0) : null,
      configNumber:
        configNumber?.length >= 1 ? configNumber.readUInt8(0) : null,
      enabled,
    };
  } finally {
    await connection.disconnect().catch(() => {});
  }
}

module.exports = {
  parseEncryptedNotification,
  decryptNotification,
  encryptNotification,
  decodeValue,
  deriveBroadcastKey,
  advertisingIdFromDeviceId,
  configureBroadcasts,
  gsnAfter,
  gsnDistance,
  KEY_GSN_BUDGET,
};
