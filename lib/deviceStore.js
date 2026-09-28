const fs = require("fs");
const path = require("path");

// Persists per-device state across restarts: the HomeKit pairing keys (which
// cannot be recovered - losing them means factory-resetting the sensor), the
// accessory database addressing, and the device's accessory information.
// One file per device, readable by the Homebridge user only.
class DeviceStore {
  constructor(directory) {
    this.directory = directory;
  }

  fileFor(deviceId) {
    return path.join(
      this.directory,
      `${deviceId.replace(/[^0-9A-Za-z]/g, "")}.json`,
    );
  }

  load(deviceId) {
    try {
      return JSON.parse(fs.readFileSync(this.fileFor(deviceId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  save(deviceId, data) {
    this.write(this.fileFor(deviceId), data);
  }

  // Keeps a copy of pairing keys about to be discarded (e.g. the device
  // reports it's no longer paired), in case that turns out to be wrong.
  backup(deviceId, data) {
    this.write(`${this.fileFor(deviceId)}.bak`, data);
  }

  write(file, data) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash mid-write can't leave a truncated file
    // behind and lose the pairing keys.
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  }
}

module.exports = { DeviceStore };
