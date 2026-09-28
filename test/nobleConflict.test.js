const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("module");

// Its own file: each test file runs in its own process, so faking "another
// plugin already loaded hap-controller" can't affect other tests.
test("if another plugin already loaded hap-controller's noble 1 in this process, it refuses to start with a clear message", () => {
  const discoveryFile =
    require.resolve("hap-controller/lib/transport/ble/ble-discovery");
  const noblePath = createRequire(discoveryFile).resolve("@stoprocent/noble");
  require.cache[noblePath] = {
    id: noblePath,
    filename: noblePath,
    loaded: true,
    exports: {},
  };

  const { loadHap } = require("../lib/hap");
  assert.throws(() => loadHap({ binding: "dbus" }), /child bridge/);
});
