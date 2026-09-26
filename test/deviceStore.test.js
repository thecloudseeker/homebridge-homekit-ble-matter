const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DeviceStore } = require("../lib/deviceStore");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hkblestore-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "homekit-ble-matter");
}

test("load returns null for a device never saved", (t) => {
  assert.equal(new DeviceStore(tempDir(t)).load("41:21:14:E5:C2:25"), null);
});

test("save then load round-trips, one file per device named after its DeviceID", (t) => {
  const dir = tempDir(t);
  const store = new DeviceStore(dir);
  store.save("41:21:14:E5:C2:25", { pairingData: { a: 1 } });

  assert.deepEqual(store.load("41:21:14:E5:C2:25"), { pairingData: { a: 1 } });
  assert.deepEqual(fs.readdirSync(dir), ["412114E5C225.json"]);
});

test("the file holding pairing keys is readable by the owner only", (t) => {
  const dir = tempDir(t);
  new DeviceStore(dir).save("41:21:14:E5:C2:25", {});

  const mode = fs.statSync(path.join(dir, "412114E5C225.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("a corrupt file is reported, not silently treated as unpaired", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "412114E5C225.json"), "{not json");

  assert.throws(() => new DeviceStore(dir).load("41:21:14:E5:C2:25"));
});
