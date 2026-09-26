# Changelog
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
