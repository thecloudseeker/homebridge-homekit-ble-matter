# Changelog
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
