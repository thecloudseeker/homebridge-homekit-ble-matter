const { withTimeout } = require("./connectionQueue");
const {
  parseAccessoryDatabase,
  normalizeSetupCode,
  releaseStalePeripheral,
} = require("./hap");

const PAIR_TIMEOUT = 90 * 1000;
const DATABASE_TIMEOUT = 90 * 1000;
const READ_TIMEOUT = 45 * 1000;
// Reads triggered by the sensor's own "something changed" signal are capped
// at one per five minutes: each read is a Bluetooth connection, which costs
// the sensor battery, and a sensor signalling every 0.1° change would
// otherwise be connected to every minute.
const MIN_READ_GAP = 5 * 60 * 1000;
const RETRY_DELAY = 60 * 1000;
// Setup (pairing, reading the structure) retries back off: a sensor that
// failed a connection attempt can get stuck - no longer advertising or
// accepting connections until its battery is taken out - and hammering it
// every minute doesn't help. Minutes; the last value repeats.
const SETUP_RETRY_MINUTES = [1, 2, 5, 10];
// After this many failed setup attempts in a row, suggest restarting the
// sensor.
const SETUP_FAILURES_BEFORE_HINT = 3;
// Setup only starts once the device was heard advertising this recently.
const PRESENCE_WINDOW = 2 * 60 * 1000;
// Consecutive failed reads after which the log suggests likely causes.
const READ_FAILURES_BEFORE_HINT = 5;
// An advertisement counts as live (not replayed from BlueZ's cache) if the
// device was heard this recently - see HomeKitBleMatterPlatform.noteDiscover.
const FRESH_WINDOW = 2 * 1000;

// hap-controller rejects with plain strings (e.g. "Timeout") as well as
// Error objects.
function describeError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// One HomeKit-over-Bluetooth sensor: pairs with it (once), learns where its
// readings live (once per firmware configuration), then reads them - on a
// poll interval, and whenever its advertisement's Global State Number (GSN)
// changes, which HomeKit accessories bump when a value changes.
//
// Advertisements are fed in by the platform (one shared BLEDiscovery for all
// sensors) via handleAdvertisement(). Connections go through the shared
// ConnectionQueue.
class BleSensor {
  constructor({
    config,
    log,
    hap,
    discovery,
    store,
    queue,
    onReady,
    onReadings,
    // Called with false when no read succeeded within `timeout`, and with
    // true when reads work again.
    onReachable = () => {},
    // When the device was last heard advertising live, or null. Defaults to
    // "now" where that can't be tracked (tests, or no noble instance).
    lastSeenAt = () => Date.now(),
    // Unconfigured HomeKit devices available to pair, as "DeviceID ('name')"
    // text, or "" - candidates for this sensor's new DeviceID after a reset.
    pairableCandidates = () => "",
  }) {
    this.config = config;
    this.deviceId = config.deviceId;
    this.log = log;
    this.hap = hap;
    this.discovery = discovery;
    this.store = store;
    this.queue = queue;
    this.onReady = onReady;
    this.onReadings = onReadings;
    this.onReachable = onReachable;
    this.lastSeenAt = lastSeenAt;
    this.pairableCandidates = pairableCandidates;
    this.waitingForPresence = false;

    this.state = store.load(this.deviceId) ?? {};
    this.advertisement = null;
    this.ready = false;
    this.preparing = null;
    this.setupFailures = 0;
    this.reading = null;
    this.lastReadAt = 0;
    this.lastSuccessAt = null;
    this.readFailures = 0;
    this.timedOut = false;
    this.warned = new Set();
    this.stopped = false;
    // The timeout also applies to a sensor that is never read after a
    // restart (e.g. out of range), not just to one that stops responding.
    this.startedAt = Date.now();
    this.scheduleTimeoutCheck();
  }

  get prefix() {
    return `[${this.config.name}]`;
  }

  get pollInterval() {
    return (this.config.pollInterval ?? 10) * 60 * 1000;
  }

  // Minutes without a successful read after which the device is reported as
  // unreachable, so controllers don't show a frozen value as current.
  get timeout() {
    return (this.config.timeout ?? 60) * 60 * 1000;
  }

  // What's already known from a previous run, so the platform can register
  // the Matter device before the sensor is even in range.
  get cachedDatabase() {
    return this.state.database ?? null;
  }

  get cachedInfo() {
    return this.state.info ?? {};
  }

  // The last readings, kept across restarts: the Matter device starts with
  // them instead of empty values.
  get cachedReadings() {
    return this.state.readings ?? null;
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    this.log.warn(`${this.prefix} ${message}`);
  }

  // Milliseconds since the device was last heard advertising live.
  sinceSeen() {
    const seen = this.lastSeenAt(this.advertisement?.peripheral);
    return seen == null ? Infinity : Date.now() - seen;
  }

  // Called by the platform on every live advertisement of this device, so a
  // sensor that was waiting for the device to show up (see doPrepare) starts
  // right away.
  handlePresence() {
    if (this.waitingForPresence && this.preparing == null && !this.stopped) {
      this.waitingForPresence = false;
      this.prepare();
    }
  }

  handleAdvertisement(service) {
    if (this.stopped) {
      return;
    }
    const previous = this.advertisement;
    this.advertisement = service;
    // Only a live advertisement may count as "no longer paired": BlueZ
    // replays its cached copy of old advertisements whenever a scan starts,
    // and acting on a stale "not paired" flag would throw away working keys
    // (recoverable only by factory-resetting the device).
    if (
      service.availableToPair &&
      this.state.pairingData != null &&
      this.sinceSeen() <= FRESH_WINDOW
    ) {
      // Advertising "not paired" although we hold keys: the sensor was
      // factory-reset or our pairing was removed. The keys are useless now.
      this.log.warn(
        `${this.prefix} Sensor reports it is no longer paired (reset, or pairing removed); pairing again.`,
      );
      this.state.pairingData = null;
      this.store.save(this.deviceId, this.state);
      this.ready = false;
    }
    if (!this.ready) {
      this.prepare();
      return;
    }
    if (previous != null && service.CN !== previous.CN) {
      // The accessory's configuration (e.g. after a firmware update) changed:
      // the characteristic addressing may be stale.
      this.log.info(`${this.prefix} Configuration changed, re-reading it.`);
      this.ready = false;
      this.state.database = null;
      this.prepare();
      return;
    }
    if (previous != null && service.GSN !== previous.GSN) {
      this.requestRead("changed");
    }
  }

  prepare() {
    if (this.preparing == null) {
      clearTimeout(this.prepareRetryTimer);
      this.preparing = this.doPrepare()
        .catch((error) => {
          // Retried on a timer, not just on the next advertisement: the
          // platform only hears from a sensor again when its advertisement
          // *changes*, which for an unpaired sensor may be never.
          const minutes =
            SETUP_RETRY_MINUTES[
              Math.min(this.setupFailures, SETUP_RETRY_MINUTES.length - 1)
            ];
          this.setupFailures += 1;
          this.log.warn(
            `${this.prefix} Setup failed, retrying in ${minutes} min: ${describeError(error)}`,
          );
          if (this.setupFailures === SETUP_FAILURES_BEFORE_HINT) {
            this.log.warn(
              `${this.prefix} Setup keeps failing. If the device stopped responding, restart it (take the battery out for 10 seconds) - Bluetooth sensors can get stuck after failed connection attempts. Also check the setup code.`,
            );
          }
          if (!this.stopped) {
            this.prepareRetryTimer = setTimeout(
              () => this.prepare(),
              minutes * 60 * 1000,
            );
          }
        })
        .finally(() => {
          this.preparing = null;
        });
    }
    return this.preparing;
  }

  async doPrepare() {
    const service = this.advertisement;
    if (this.sinceSeen() > PRESENCE_WINDOW) {
      // Known only from BlueZ's cache (e.g. the device is off): wait for it
      // to actually advertise instead of failing connection attempts.
      this.log.debug(
        `${this.prefix} Not advertising right now; waiting for it before connecting.`,
      );
      this.waitingForPresence = true;
      return;
    }
    if (this.state.pairingData == null) {
      if (!service.availableToPair) {
        this.warnOnce(
          "paired-elsewhere",
          "Already paired with another HomeKit controller (e.g. Apple Home). Remove it there (or factory-reset it) to let this plugin pair with it.",
        );
        return;
      }
      const setupCode = normalizeSetupCode(this.config.setupCode);
      if (setupCode == null) {
        this.warnOnce(
          "no-setup-code",
          "Not paired yet and no valid setupCode configured (8 digits, e.g. 123-45-678).",
        );
        return;
      }
      await this.pair(service, setupCode);
    }
    if (this.state.database == null || this.state.configNumber !== service.CN) {
      await this.loadDatabase(service);
    }
    this.ready = true;
    this.setupFailures = 0;
    this.onReady(this.state.database, this.state.info ?? {});
    this.requestRead("startup");
    this.schedulePoll();
  }

  // "RSSI -72 dBm, heard 3s ago" - signal strength of the last
  // advertisement and how long ago it was heard, for judging whether a
  // failed connection was down to range.
  signalInfo() {
    const rssi = this.advertisement?.peripheral?.rssi;
    const since = this.sinceSeen();
    const heard = Number.isFinite(since)
      ? `heard ${Math.round(since / 1000)}s ago`
      : "not heard live yet";
    return `${typeof rssi === "number" ? `RSSI ${rssi} dBm` : "RSSI unknown"}, ${heard}`;
  }

  // Every connection starts here, inside the ConnectionQueue.
  releasePeripheral(service) {
    this.log.debug(`${this.prefix} Connecting (${this.signalInfo()}).`);
    const stale = releaseStalePeripheral(service.peripheral);
    if (stale != null) {
      this.log.debug(
        `${this.prefix} Cleared stale Bluetooth connection state '${stale}'.`,
      );
    }
  }

  async pair(service, setupCode) {
    this.log.info(`${this.prefix} Pairing...`);
    await this.queue.run(async () => {
      this.releasePeripheral(service);
      const pairMethod = await withTimeout(
        this.discovery.getPairMethod(service),
        PAIR_TIMEOUT,
        "Reading pair method",
      );
      const client = new this.hap.GattClient(
        service.DeviceID,
        service.peripheral,
      );
      try {
        await withTimeout(
          client.pairSetup(setupCode, pairMethod),
          PAIR_TIMEOUT,
          "Pairing",
        );
        this.state.pairingData = client.getLongTermData();
      } finally {
        await client.close().catch(() => {});
      }
    });
    this.store.save(this.deviceId, this.state);
    this.log.info(`${this.prefix} Paired.`);
  }

  async loadDatabase(service) {
    this.log.info(`${this.prefix} Reading accessory structure...`);
    await this.queue.run(async () => {
      this.releasePeripheral(service);
      const client = new this.hap.GattClient(
        service.DeviceID,
        service.peripheral,
        this.state.pairingData,
      );
      try {
        const database = parseAccessoryDatabase(
          await withTimeout(
            client.getAccessories(),
            DATABASE_TIMEOUT,
            "Reading accessory structure",
          ),
          this.hap,
        );
        const infoEntries = Object.entries(database.info);
        const info = {};
        if (infoEntries.length > 0) {
          const { characteristics } = await withTimeout(
            client.getCharacteristics(
              infoEntries.map(([, address]) => address),
            ),
            READ_TIMEOUT,
            "Reading accessory information",
          );
          infoEntries.forEach(([key], index) => {
            const value = characteristics[index]?.value;
            if (value != null && value !== "") {
              info[key] = String(value);
            }
          });
        }
        this.state.database = database.readings;
        this.state.info = info;
        this.state.configNumber = service.CN;
      } finally {
        await client.close().catch(() => {});
      }
    });
    this.store.save(this.deviceId, this.state);
    const found = Object.keys(this.state.database);
    this.log.info(
      `${this.prefix} ${this.state.info.manufacturer ?? ""} ${this.state.info.model ?? ""}: found ${found.length > 0 ? found.join(", ") : "nothing this plugin can read"}.`.replace(
        /\s+/g,
        " ",
      ),
    );
  }

  requestRead(reason) {
    if (!this.ready || this.stopped || this.reading != null) {
      return;
    }
    const sinceLast = Date.now() - this.lastReadAt;
    if (reason === "changed" && sinceLast < MIN_READ_GAP) {
      this.log.debug(`${this.prefix} Change signalled; read deferred.`);
      clearTimeout(this.deferTimer);
      this.deferTimer = setTimeout(
        () => this.requestRead("deferred"),
        MIN_READ_GAP - sinceLast,
      );
      return;
    }
    this.reading = this.read(reason).finally(() => {
      this.reading = null;
    });
  }

  async read(reason) {
    const service = this.advertisement;
    const entries = Object.entries(this.state.database);
    if (service == null || entries.length === 0) {
      return;
    }
    this.lastReadAt = Date.now();
    try {
      const values = await this.queue.run(async () => {
        this.releasePeripheral(service);
        const client = new this.hap.GattClient(
          service.DeviceID,
          service.peripheral,
          this.state.pairingData,
        );
        try {
          const { characteristics } = await withTimeout(
            client.getCharacteristics(entries.map(([, address]) => address)),
            READ_TIMEOUT,
            "Reading values",
          );
          return Object.fromEntries(
            entries.map(([key], index) => [key, characteristics[index]?.value]),
          );
        } finally {
          await client.close().catch(() => {});
        }
      });
      const readings = normalizeReadings(values);
      // The first successful read, and the first one after failures, are
      // logged at info level: otherwise a working sensor is silent and a
      // recovered one looks exactly like one that still fails.
      if (this.lastSuccessAt == null) {
        this.log.info(
          `${this.prefix} Receiving readings: ${describeReadings(readings)}.`,
        );
      } else if (this.readFailures > 0) {
        this.log.info(
          `${this.prefix} Readings OK again after ${this.readFailures} failed attempt${this.readFailures === 1 ? "" : "s"}: ${describeReadings(readings)}.`,
        );
      }
      this.lastSuccessAt = Date.now();
      this.readFailures = 0;
      if (this.timedOut) {
        this.timedOut = false;
        this.onReachable(true);
      }
      this.state.readings = readings;
      this.store.save(this.deviceId, this.state);
      this.warned.delete("read-failed");
      this.warned.delete("read-hint");
      this.log.debug(
        `${this.prefix} Read (${reason}, ${this.signalInfo()}): ${JSON.stringify(values)}`,
      );
      this.onReadings(readings);
      this.scheduleTimeoutCheck();
    } catch (error) {
      this.readFailures += 1;
      this.warnOnce("read-failed", `Reading failed: ${describeError(error)}`);
      if (this.readFailures === READ_FAILURES_BEFORE_HINT) {
        const candidates = this.pairableCandidates();
        this.warnOnce(
          "read-hint",
          `Reading has failed ${READ_FAILURES_BEFORE_HINT} times in a row; retrying every ${this.pollInterval / 60000} minutes from now on. Other Bluetooth plugins on the same adapter (e.g. Govee, other BLE sensor plugins) can interfere with connections; if it persists, restart the device (battery out for 10 seconds) or give this plugin its own Bluetooth adapter.` +
            (candidates === ""
              ? ""
              : ` A factory reset gives a HomeKit device a new DeviceID: if it was reset, replace ${this.deviceId} in the config with the new one, likely ${candidates}.`),
        );
      }
      // Retried after a minute at first; once it keeps failing, only on the
      // poll interval, so an absent or reset device isn't hammered around
      // the clock.
      clearTimeout(this.retryTimer);
      if (this.readFailures < READ_FAILURES_BEFORE_HINT) {
        this.log.debug(
          `${this.prefix} Reading failed (${this.readFailures} in a row, ${this.signalInfo()}): ${describeError(error)}. Retrying in ${RETRY_DELAY / 1000}s.`,
        );
        this.retryTimer = setTimeout(
          () => this.requestRead("retry"),
          RETRY_DELAY,
        );
      } else {
        this.log.debug(
          `${this.prefix} Reading failed (${this.readFailures} in a row, ${this.signalInfo()}): ${describeError(error)}. Next try on the poll interval.`,
        );
      }
      this.checkTimeout();
    }
  }

  schedulePoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(
      () => this.requestRead("poll"),
      this.pollInterval,
    );
  }

  scheduleTimeoutCheck() {
    clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => this.checkTimeout(), this.timeout);
  }

  checkTimeout() {
    const since = this.lastSuccessAt ?? this.startedAt;
    if (this.timedOut || Date.now() - since < this.timeout) {
      return;
    }
    this.timedOut = true;
    // Not by clearing the values: IKEA Dirigera shows an unknown (null)
    // temperature as 100 °C. Unreachable keeps the last values and lets
    // controllers show the device as not responding.
    this.log.warn(
      `${this.prefix} No successful read for ${this.timeout / 60000} minutes; reporting it as unreachable.`,
    );
    this.onReachable(false);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.prepareRetryTimer);
    clearTimeout(this.deferTimer);
    clearTimeout(this.timeoutTimer);
  }
}

// "22.4 °C, 60.5 %, battery 86 %" - only what the device reports.
function describeReadings({ temperature, humidity, batteryLevel, lowBattery }) {
  const parts = [];
  if (temperature != null) {
    parts.push(`${temperature.toFixed(1)} °C`);
  }
  if (humidity != null) {
    parts.push(`${humidity.toFixed(1)} %`);
  }
  if (batteryLevel != null) {
    parts.push(`battery ${batteryLevel} %${lowBattery ? " (low)" : ""}`);
  } else if (lowBattery) {
    parts.push("battery low");
  }
  return parts.length > 0 ? parts.join(", ") : "no values";
}

// HAP values → plain numbers/booleans. Characteristics the sensor doesn't
// have stay undefined (MatterSensor.update skips them).
function normalizeReadings(values) {
  const number = (value) =>
    value == null || Number.isNaN(Number(value)) ? undefined : Number(value);
  return {
    temperature: number(values.temperature),
    humidity: number(values.humidity),
    batteryLevel: number(values.batteryLevel),
    lowBattery:
      values.lowBattery == null ? undefined : Number(values.lowBattery) === 1,
  };
}

module.exports = { BleSensor, normalizeReadings };
