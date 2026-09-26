const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("module");

// On a host with a system D-Bus (e.g. a Linux CI runner), starting the
// binding opens a real D-Bus connection, which would keep this test process
// alive forever. Close it once the tests are done.
after(() => {
  const { loadHap } = require("../lib/hap");
  try {
    loadHap().noble._bindings?.stop?.();
  } catch {
    // Nothing was started.
  }
});

// Uses the real hap-controller and noble 2 (constructing the D-Bus binding
// is lazy, so this runs without Bluetooth). Each test file runs in its own
// process, so the require-cache change can't leak into other tests.
test("loadHap makes hap-controller's discovery use noble 2 with the chosen binding, never noble 1", () => {
  const { loadHap } = require("../lib/hap");
  const hap = loadHap({ binding: "dbus" });

  const discoveryFile =
    require.resolve("hap-controller/lib/transport/ble/ble-discovery");
  const noblePath = createRequire(discoveryFile).resolve("@stoprocent/noble");
  assert.ok(
    noblePath.includes("hap-controller/node_modules"),
    "hap-controller would load its own nested noble 1 from here",
  );
  assert.equal(require.cache[noblePath].exports, hap.noble);
  assert.equal(require.cache[noblePath].homekitBleMatterBinding, "dbus");

  const ourNoble = require("@stoprocent/noble/package.json").version;
  assert.equal(ourNoble.split(".")[0], "2");

  // hap-controller's discovery registers on the injected instance.
  const discovery = new hap.BLEDiscovery();
  discovery.start();
  assert.equal(hap.noble.listenerCount("discover"), 1);
});

test("loadHap is idempotent: a second call reuses the injected instance", () => {
  const { loadHap } = require("../lib/hap");
  assert.equal(loadHap().noble, loadHap().noble);
});

test("without a reachable D-Bus (like this test machine) the adapter reports 'unsupported' instead of crashing the process", async () => {
  const { loadHap } = require("../lib/hap");
  const { noble } = loadHap({ binding: "dbus" });
  // Listening for stateChange starts the binding (noble initializes lazily).
  const state = await new Promise((resolve) => {
    noble.on("stateChange", (s) => {
      if (s !== "unknown") {
        resolve(s);
      }
    });
    setTimeout(() => resolve("timeout"), 3000);
  });
  if (process.platform === "linux" && state === "poweredOn") {
    return; // A Linux CI runner with a working BlueZ is fine too.
  }
  assert.equal(state, "unsupported");
});
