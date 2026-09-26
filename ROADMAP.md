# Roadmap to 1.0.0

**1.0.0 means:** the plugin runs for weeks without attention, its configuration
is stable, and every known rough edge is either fixed or knowingly accepted and
documented.

**Where we are (0.1.0-beta.9):** one Qingping CGG1H, paired and exposed to IKEA
Dirigera over Matter, on a Raspberry Pi 5 (Homebridge 2.4.0), sharing the
Bluetooth adapter with two other BLE plugins. Running since 2026-09-26.

## 0.1.0 — first stable release

Same code as 0.1.0-beta.9, released once a few days of real use look clean:

- [ ] The log stays quiet: at most an occasional `Readings OK again`, no chains of `Reading failed`
- [ ] Values keep updating in the controller, including across Homebridge restarts
- [ ] Other Bluetooth plugins on the same adapter keep working

## 0.2.x — close the known gaps

- [ ] **Remove the pairing when a device leaves the config.** Today the only way
  to free a device is a factory reset, which also gives it a new DeviceID. The
  plugin should remove its own pairing from the device (hap-controller
  `removePairing`) so the device can go straight back to Apple Home.
- [ ] **Choose the Bluetooth adapter** (`bluetoothAdapter`, e.g. `hci1`).
  Straightforward with the D-Bus binding (`withBindings('dbus', { adapterId })`),
  and the clean answer to adapter contention: give this plugin its own USB dongle.
- [ ] **Verify change-triggered reads on real hardware.** Find out whether the
  CGG1H bumps its advertised Global State Number when a value changes, or whether
  only the poll interval applies. Document the answer in the README.
- [ ] **Test with more than one sensor.** The connection queue and presence
  tracking are designed for it, but only one device has been tested.
- [ ] **Test or remove `bluetoothBinding: "hci"`.** Raw HCI failed to hold
  connections in testing; either confirm a setup where it works or drop the option.

## 0.3.x — settle the workarounds (optional)

- [ ] **noble 2 injection into hap-controller** (`lib/hap.js`): works because
  hap-controller is pinned to exactly 0.10.2. Offer upstream a PR that moves
  hap-controller to noble 2 with a D-Bus option, which would make the injection
  unnecessary. Not a 1.0 blocker.
- [ ] **D-Bus connection error guard** relies on noble 2.8.0 internals
  (`_bindings`, `_bus`). Pinned; report the missing `error` listener upstream.
- [ ] **Stale connection state reset** (`releaseStalePeripheral` in `lib/hap.js`):
  noble 2.8.0's D-Bus binding never completes a disconnect for a device it
  holds no connection to, so a peripheral left in `error` after a failed
  connect stays stuck. Report upstream; drop the workaround once fixed.
- [ ] **New Matter `uniqueId` on every restart**
  ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)):
  Homebridge's to fix. For 1.0 it's enough that the README states the limitation.

## 1.0.0 — criteria

- [ ] **2–4 weeks** of continuous operation without manual intervention
- [ ] Tested with **two Matter controllers** (IKEA Dirigera plus Apple Home or Google Home)
- [ ] Pairing removal and adapter selection shipped; no configuration changes planned
- [ ] README covers supported devices, setup, troubleshooting and known limitations
- [ ] Scope stated: **temperature and humidity sensors with battery**. Other
  HomeKit Bluetooth device types (contact, leak, motion, …) are 1.x features,
  not 1.0 requirements.

Optional around 1.0: apply for **Homebridge Verified** (config schema, no
postinstall scripts, proper error handling — mostly in place already).

## After 1.0

- More sensor types (contact, leak, motion, air quality) where HomeKit BLE
  devices expose them
- A Homebridge UI page listing nearby HomeKit Bluetooth devices with their
  DeviceID, instead of reading it from the log
- Encrypted "disconnected events" (broadcast notifications) if hap-controller
  gains support ([hap-controller#43](https://github.com/Apollon77/hap-controller-node/issues/43)),
  for change notifications without connecting
