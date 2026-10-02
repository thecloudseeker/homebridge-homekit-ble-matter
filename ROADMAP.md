# Roadmap to 1.0.0

**1.0.0 means:** the plugin runs for weeks without attention, its configuration
is stable, and every known rough edge is either fixed or knowingly accepted and
documented.

**Where we are (0.1.1, 0.2.0 in beta):** one Qingping CGG1H, paired and exposed to IKEA
Dirigera over Matter, on a Raspberry Pi 5 (Homebridge 2.4.0), sharing the
Bluetooth adapter with two other BLE plugins. Running since 2026-09-26.

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

## 0.2.0 — more sensor types, several sensors (0.2.0-beta.1)

- [x] Contact, leak, motion, occupancy, light, smoke/CO, CO₂ and air quality
  (PM2.5, PM10, VOC, NO₂, ozone), each mapped to its Matter device type
- [x] Devices with several sensor kinds as one Matter device with parts;
  repeated services as their own parts
- [x] Fast updates via HomeKit broadcast notifications (opt-in)
- [x] Several sensors side by side: own pairing and Matter device each, one
  connection at a time, a failing sensor doesn't hold up the others
- [ ] **Buttons** (stateless programmable switches → Matter Generic Switch).
  Needs events: only with fast updates, if a button broadcasts its presses
- [ ] Status flags (tampered, active) where Matter has a place for them

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
- [ ] **D-Bus match rule leak** (`fixMatchRuleRefcounts` in `lib/hap.js`):
  dbus-next 0.10.2 checks its match-rule refcount with swapped
  `hasOwnProperty` arguments, so it never sends `RemoveMatch`. Every device
  the scan sees leaks a rule until the bus refuses more (2048 per connection)
  after roughly half a day. Pinned; report upstream and drop the patch once
  fixed.
- [ ] **Stale connection state reset** (`releaseStalePeripheral` in `lib/hap.js`):
  plus the patched `disconnect` in the D-Bus guard: noble 2.8.0's D-Bus
  binding never completes a disconnect for a device it holds no connection
  to, so a peripheral left in `error` after a failed connect stayed stuck
  and every failed attempt waited 30s. Report upstream; drop both
  workarounds once fixed.
- [ ] **New Matter `uniqueId` on every restart**
  ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)):
  Homebridge's to fix. For 1.0 it's enough that the README states the limitation.

## 1.0.0 — criteria

- [ ] **2–4 weeks** of continuous operation without manual intervention
- [ ] Tested with **two Matter controllers** (IKEA Dirigera plus Apple Home or Google Home)
- [x] Pairing removal and adapter selection shipped; no configuration changes planned
- [ ] README covers supported devices, setup, troubleshooting and known limitations
- [ ] Scope stated: **read-only HomeKit Bluetooth sensors**.

Optional around 1.0: apply for **Homebridge Verified** (config schema, no
postinstall scripts, proper error handling — mostly in place already).

## After 1.0

- A Homebridge UI page listing nearby HomeKit Bluetooth devices with their
  DeviceID, instead of reading it from the log
- Offer the broadcast notification support upstream to hap-controller
  ([hap-controller#43](https://github.com/Apollon77/hap-controller-node/issues/43))
