# Roadmap to 1.0.0

**1.0.0 means:** the plugin runs for weeks without attention, its configuration
is stable, and every known rough edge is either fixed or knowingly accepted and
documented.

**Where we are (0.3.0):** one Qingping CGG1H, paired and exposed over Matter
to IKEA Dirigera and Apple Home, on a Raspberry Pi 5, sharing the Bluetooth
adapter with two other BLE plugins. Running since 2026-09-26. Only the weeks of
unattended running are left for 1.0, plus running 0.3.0's controllable
devices on real hardware.

## 0.1.0 — first stable release (released)

Same code as 0.1.0-beta.11, released after two days of real use:

- [x] The log stays quiet: at most an occasional `Readings OK again`. Chains of
  `Reading failed` only occurred with the sensor at the edge of range
  (-91 to -97 dBm)
- [x] Values keep updating in the controller, including across Homebridge restarts
- [x] Other Bluetooth plugins on the same adapter keep working
- [x] No D-Bus match-rule errors after 46 hours without a restart (they used to
  start after 12–17 hours)

## 0.1.1 — weak-signal handling (released)

- [x] **Don't connect to a sensor that hasn't been heard recently.** BlueZ drops
  a device it hasn't heard from for a while, and connecting then fails
  instantly with `interface not found in proxy object:
  org.freedesktop.DBus.Properties`. Wait for its next advertisement instead,
  and log "not heard for Xs" rather than the D-Bus error.
- [x] Verified on real hardware: a sensor out of range for 10 minutes wasn't
  connected to, and was read the moment it was heard again (at -90 dBm)

## 0.2.0 — more sensor types, several sensors (released)

- [x] Contact, leak, motion, occupancy, light, smoke/CO, CO₂ and air quality
  (PM2.5, PM10, VOC, NO₂, ozone), each mapped to its Matter device type
- [x] Devices with several sensor kinds as one Matter device with parts;
  repeated services as their own parts
- [x] Fast updates via HomeKit broadcast notifications (opt-in)
- [x] Several sensors side by side: own pairing and Matter device each, one
  connection at a time, a failing sensor doesn't hold up the others
- [x] **Buttons** (stateless programmable switches → Matter Generic Switch),
  through fast updates: single, double and long press, one switch per button
- [x] Status flags: "not active" as not responding, a fault on smoke/CO
  alarms, tampering in the log (Matter has no place for it)

## 0.2.x — close the known gaps

- [x] **Remove the pairing from a device** (`removePairing`), so it can go
  straight back to Apple Home without a factory reset and keeps its DeviceID.
- [x] **Choose the Bluetooth adapter** (`bluetoothAdapter`, e.g. `hci1`): the
  clean answer to adapter contention is a USB dongle of the plugin's own.
- [x] **Verify change-triggered reads on real hardware.** The CGG1H bumps its
  advertised Global State Number when a value changes, so a change is read
  within a few minutes instead of waiting for the poll interval.
- [x] **Calibration offsets** for temperature and humidity, per device.
- [x] **Disconnect sensors BlueZ still holds at startup**, left connected by
  a crash: a connected sensor stops advertising.
- [x] **Raw HCI removed** (`bluetoothBinding`): it didn't hold connections;
  Bluetooth always goes through BlueZ.

## 0.2.1 — a calmer log (released)

- [x] A poll right after a successful read is skipped
- [x] A single failed read that recovers on the retry is no longer a warning
- [x] Clearer debug lines: wait before a change-triggered read, unknown RSSI

## 0.3.0 — controllable devices (released)

- [x] Plugs, switches, lights, locks, blinds/windows/doors, fans and air
  purifiers, thermostats, air conditioners, valves and faucets, mapped to
  their Matter device types and checked against matter.js through
  Homebridge's real Matter server
- [x] Kept connection per controllable device (`keepConnected`): commands
  within about a second, the device's own changes at once, reconnect with
  backoff; our own GATT reads and writes by instance ID, with the device's
  status checked and timed writes where required
- [ ] Run on real controllable hardware (a Bluetooth-only plug or light)

## 0.3.x — settle the workarounds (optional)

- [ ] **noble 2 injection into hap-controller** (`lib/hap.js`): works because
  hap-controller is pinned to exactly 0.10.2. Offer upstream a PR that moves
  hap-controller to noble 2 with a D-Bus option, which would make the injection
  unnecessary. Not a 1.0 blocker.
- [ ] **D-Bus connection error guard** relies on noble 2.8.0 internals
  (`_bindings`, `_bus`, `_state`). Pinned; report the missing `error` listener
  upstream. It only reports Bluetooth as unavailable before the adapter is
  up: dbus-next also emits `error` for a single unparsable message, and
  treating that as fatal made noble drop every known device.
- [x] **D-Bus match rule leak**: gone with the move from dbus-next 0.10.2
  (last released in 2022) to its maintained fork `@jellybrick/dbus-next`,
  installed under the same name. The fork fixes the leak, so the plugin's
  own patch was removed, and it drops the outdated packages the original
  pulled in.
- [ ] **Move to the fork's current line (0.11.x).** noble 2.8.0 asks for
  dbus-next `^0.10.0`, so npm would install the original next to a newer
  fork and noble would use the original. Needs noble to widen that range.
- [ ] **Proxy object setup order** (`orderProxyObjectInit` in `lib/hap.js`):
  dbus-next's `getProxyObject` attaches its handler to the Introspect call
  only after the bus's AddMatch is answered, so a fast failure (no BlueZ)
  is briefly unhandled and ends the process. Report upstream to
  `@jellybrick/dbus-next` (attach the handler at once); drop the
  workaround once fixed.
- [ ] **Stale connection state reset** (`releaseStalePeripheral` in `lib/hap.js`):
  plus the patched `disconnect` in the D-Bus guard: noble 2.8.0's D-Bus
  binding never completes a disconnect for a device it holds no connection
  to, so a peripheral left in `error` after a failed connect stayed stuck
  and every failed attempt waited 30s. Report upstream; drop both
  workarounds once fixed.
- [x] **New Matter `uniqueId` on every restart**
  ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)):
  fixed in Homebridge 2.5.0, which keeps the uniqueId of a re-registered
  device. Tested against 2.5.0 (`test/homebridgeMatterRestart.test.js`).
- [ ] **Temperature+humidity device rebuilt at every start**: Homebridge's
  cache stores a device type as `{name, code}`, so the humidity behavior the
  plugin composes onto TemperatureSensor is lost and the shape check
  re-registers it. Harmless since 2.5.0 (same uniqueId and endpoint). Fix
  upstream: cache the composed behavior ids.
- [x] **Wait after registering** (`lib/platform.js`): Homebridge 2.5.0
  resolves register/unregister once the bridge has finished
  ([homebridge/homebridge#4033](https://github.com/homebridge/homebridge/pull/4033)),
  so the 3-second wait only applies on 2.4. Remove it entirely once the
  minimum Homebridge is 2.5.

## 1.0.0 — criteria

- [ ] **2–4 weeks** of continuous operation without manual intervention
- [x] Tested with **two Matter controllers**: IKEA Dirigera and Apple Home
- [x] Pairing removal and adapter selection shipped; no configuration changes planned
- [x] README covers supported devices, setup, troubleshooting and known limitations
- [x] Scope stated: HomeKit Bluetooth sensors and controllable devices;
  garage doors, security systems, humidifiers and TVs are not supported
- [ ] Controllable devices run on real hardware

Optional around 1.0: apply for **Homebridge Verified** (config schema, no
postinstall scripts, proper error handling — mostly in place already).

## After 1.0

- A Homebridge UI page listing nearby HomeKit Bluetooth devices with their
  DeviceID, instead of reading it from the log
- Offer the broadcast notification support upstream to hap-controller
  ([hap-controller#43](https://github.com/Apollon77/hap-controller-node/issues/43))
