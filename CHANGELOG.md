# Changelog
## 0.1.0-beta.10

**Beta.**

* Changed how a device that can't be read is reported: after `timeout` minutes without a successful read, it's now marked as **not responding** (Matter "reachable") and keeps its last values, instead of having its values cleared. Some controllers display a cleared (unknown) temperature as the top of its range, e.g. 100 °C. The device responds again with the next successful read.
* The last readings are now kept across restarts, so a device starts with them instead of empty values. A device that isn't read at all after a restart (e.g. out of range) is marked as not responding after `timeout` as well.
* Fixed each failed connection taking 30 seconds and leaking a listener (`MaxListenersExceeded ... disconnect listeners`).
* Fixed a transient D-Bus error being reported as `Bluetooth via BlueZ (D-Bus) is not available`, after which reads timed out (`unknown peripheral ... connected!`) until a restart. Bluetooth is now only reported as unavailable if D-Bus fails while starting up.
* After five failed reads in a row, reads are retried every `pollInterval` minutes instead of every minute. The warning shown at that point also names any device available to pair as the likely new DeviceID, in case the device was factory-reset.
* Battery: a low battery now also sets Matter's "replacement needed", and the battery is reported as user-replaceable.
* Debug logging now shows the signal strength (RSSI) and when the device was last heard for every connection and read.

## 0.1.0-beta.9

**Beta.**

* Fixed the sensor becoming permanently unresponsive after a single failed connection (e.g. `le-connection-abort-by-local`) until the child bridge was restarted. The failed attempt left the Bluetooth library's connection state stuck in a way it never recovered from, so every later read timed out (and Node warned about `MaxListenersExceeded ... disconnect listeners`). The plugin now clears such a leftover state before each connection, so a failed connection costs one read and the next retry works.
* Failed reads after the first are now logged at debug level with their error, instead of not at all.

## 0.1.0-beta.8

**Beta.**

* Fixed Homebridge logging `Failed to update state ... is closed` (in red) on every restart: the plugin's first update arrived while Homebridge was still re-creating the Matter device ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)). The plugin now waits a moment after registering; readings arriving meanwhile are kept and sent right after, so the first reading isn't lost.

## 0.1.0-beta.7

**Beta.**

* The first successful read is now logged (`Receiving readings: 22.4 °C, 60.5 %, battery 86 %`), and so is recovery after failed reads (`Readings OK again after 2 failed attempts: …`). Previously a working sensor was silent unless debug logging was on, so a single failure couldn't be told apart from a permanent one.
* After five failed reads in a row, the log names likely causes: other Bluetooth plugins sharing the adapter, a stuck device, or the need for a separate adapter.

## 0.1.0-beta.6

**Beta.**

* Fixed connection attempts to devices that aren't there: whenever a scan starts, BlueZ re-reports every device in its cache with its last stored advertisement (e.g. a sensor without battery). Setup now waits until the device is actually heard advertising, and starts as soon as it is - without counting failures or backing off.
* Protected the pairing keys against those cached replays: an old "not paired" advertisement from BlueZ's cache is no longer mistaken for a factory reset (which would have deleted working keys). Only a live advertisement counts.

## 0.1.0-beta.5

**Beta.**

* Fixed pairing failing with `le-connection-abort-by-local`: BlueZ aborts connection attempts while a Bluetooth scan runs on the same adapter, so scanning is now paused during every connection (pairing, reading the structure, reading values) and resumed afterwards.

## 0.1.0-beta.4

**Beta.**

* Fixed installing failing on Node 24 (`@stoprocent/noble … node-gyp-build … Completion callback never invoked`): a dependency of the D-Bus library brought in node-gyp 7, which can't build on Node 24; the plugin now ships a current node-gyp.

## 0.1.0-beta.3

**Beta.**

* Changed Bluetooth access to BlueZ over D-Bus (noble 2) instead of raw HCI (noble 1, which hap-controller uses by default). On a Raspberry Pi, raw HCI could not hold a connection to a Qingping CGG1H at all (the sensor terminated every link, so pairing always timed out), while BlueZ connected every time. It also needs no root or raw-socket capabilities and doesn't conflict with the system's bluetooth service.
* Added **Bluetooth Access** (`bluetoothBinding`: `dbus` default, `hci` for the old behaviour).
* If BlueZ isn't reachable (e.g. no D-Bus in a container), the plugin now logs a clear error instead of crashing the child bridge.

## 0.1.0-beta.2

**Beta.**

* Fixed a failed pairing (or setup) not being retried until Homebridge restarted. It's now retried after 1, 2, 5, then every 10 minutes, and after three failures the log suggests restarting the device: a Bluetooth sensor can get stuck after a failed connection attempt (stops advertising and accepting connections) until its battery is taken out.
* Fixed errors from the Bluetooth library being logged as `undefined` (e.g. "Setup failed …: undefined" instead of "… Timeout").
* A configured device not seen within two minutes of startup is now reported. HomeKit gives a device a **new DeviceID when it's factory-reset**, so if an unconfigured device that's available to pair is around, the warning names it as the likely new DeviceID.

## 0.1.0-beta.1

**Beta** — first release.

* Pairs with HomeKit-over-Bluetooth temperature/humidity sensors (tested: Qingping CGG1H) and exposes each as one Matter device with temperature, humidity and battery.
* Lists nearby HomeKit Bluetooth devices with their DeviceID in the log.
* Reads on the device's own change signal (at most once every 5 minutes) and every `pollInterval` minutes; reports values as unavailable after `timeout`.
* Stores pairing keys, so pairing happens once; pairs again automatically if the device is factory-reset.
