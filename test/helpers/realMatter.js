// Starts Homebridge's real Matter server (the version this plugin pins as a
// dev dependency, with its matter.js) in this process, and hands out the
// same api.matter surface a plugin gets: deviceTypes, uuid.generate,
// register/unregister and state updates. Unlike test/helpers/fakeMatter.js,
// this checks the plugin's Matter devices against matter.js's own
// validation - feature-gated clusters, attribute conformance, value ranges -
// the way Homebridge would register them on a real bridge.
//
// It opens a Matter UDP port and mDNS on this machine (never commissioned,
// so no controller ever talks to it).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

let storageRoot = null;

// `base`: a storage directory from an earlier run, to start again with its
// cached accessories (a Homebridge restart); a new one otherwise.
async function startRealMatter({ base: existingBase } = {}) {
  const dist = path.dirname(require.resolve("homebridge"));
  const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
  const [{ MatterServer }, { deviceTypes }, { User }] = await Promise.all([
    load("matter/server.js"),
    load("matter/types.js"),
    load("user.js"),
  ]);

  // Homebridge only accepts Matter storage inside its own storage path,
  // which can only be set once per process: one root, a folder per server.
  if (storageRoot == null) {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hbm-matter-"));
    User.setStoragePath(storageRoot);
  }
  const base = existingBase ?? fs.mkdtempSync(path.join(storageRoot, "run-"));
  const server = new MatterServer({
    uniqueId: "0E:AA:BB:CC:DD:01",
    port: 20000 + crypto.randomInt(20000),
    storagePath: path.join(base, "matter"),
  });
  await server.start();

  const matter = {
    deviceTypes,
    uuid: {
      // A v4-shaped UUID derived from the seed, as HAP's uuid.generate does.
      generate(seed) {
        const hex = crypto.createHash("sha1").update(seed).digest("hex");
        return [
          hex.slice(0, 8),
          hex.slice(8, 12),
          `4${hex.slice(13, 16)}`,
          `8${hex.slice(17, 20)}`,
          hex.slice(20, 32),
        ].join("-");
      },
    },
    registerPlatformAccessories: (plugin, platform, accessories) =>
      server.registerPlatformAccessories(plugin, platform, accessories),
    unregisterPlatformAccessories: (plugin, platform, accessories) =>
      server.unregisterPlatformAccessories(plugin, platform, accessories),
    updateAccessoryState: (uuid, cluster, attributes, partId) =>
      server.updateAccessoryState(uuid, cluster, attributes, partId),
    getAccessoryState: (uuid, cluster, partId) =>
      server.getAccessoryState(uuid, cluster, partId),
  };

  return {
    matter,
    server,
    base,
    // `keep`: leave the storage for a restart.
    async stop({ keep = false } = {}) {
      await server.stop();
      if (!keep) {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
  };
}

module.exports = { startRealMatter };
