# Changelog
## 0.1.0-beta.1

**Beta** — first release.

* Pairs with HomeKit-over-Bluetooth temperature/humidity sensors (tested: Qingping CGG1H) and exposes each as one Matter device with temperature, humidity and battery.
* Lists nearby HomeKit Bluetooth devices with their DeviceID in the log.
* Reads on the device's own change signal (at most once every 5 minutes) and every `pollInterval` minutes; reports values as unavailable after `timeout`.
* Stores pairing keys, so pairing happens once; pairs again automatically if the device is factory-reset.
