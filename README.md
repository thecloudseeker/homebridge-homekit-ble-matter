# homebridge-homekit-ble-matter

Brings **HomeKit-only Bluetooth sensors** to **Matter** controllers such as IKEA Dirigera, Google Home, Amazon Alexa or SmartThings.

Some sensors only speak HomeKit over Bluetooth (for example the Qingping Temp & RH Monitor **H version, CGG1H**), so only Apple Home can use them. This plugin pairs with such a device the way Apple Home would, reads its values, and exposes it through Homebridge's Matter bridge.

> Tested with a Qingping CGG1H on a Raspberry Pi 5 with IKEA Dirigera. Currently supports temperature and humidity sensors (with battery level).

## Requirements

- Homebridge **2.4.0** or later, with Matter
- A Bluetooth adapter the Homebridge host can use (the Raspberry Pi's built-in one works)
- Node.js 20, 22 or 24
- BlueZ (the standard Linux Bluetooth service) running, and the Homebridge user allowed to use it: on Raspberry Pi OS the default `pi` user is; otherwise add it to the `bluetooth` group (`sudo usermod -aG bluetooth <user>`, then restart Homebridge)

## Setup

1. **Remove the device from Apple Home** (accessory → Remove Accessory). A HomeKit device can only be paired with one controller this way.
2. Install the plugin and run it as a **child bridge**. In the child bridge settings, turn **Enable Matter** on (and HomeKit off: this plugin exposes nothing over HomeKit).
3. Restart. The log lists nearby HomeKit Bluetooth devices:
   ```
   Found HomeKit Bluetooth sensor 'Qingping Temp RH H' - DeviceID 41:21:14:E5:C2:25, available to pair. Add it under 'devices' to use it.
   ```
4. Add it with that **DeviceID** (not the Bluetooth address) and its **HomeKit setup code**:
   ```json
   {
     "platform": "HomeKitBleMatter",
     "devices": [
       { "deviceId": "41:21:14:E5:C2:25", "name": "Bedroom", "setupCode": "128-84-842" }
     ]
   }
   ```
5. Restart. The plugin pairs, reads the device's structure and registers one Matter device. Add the bridge to your Matter controller with the code from the child bridge's Matter settings.

The pairing keys are stored in `<Homebridge storage>/homekit-ble-matter/`. Keep that folder: without it the device has to be factory-reset before it can be paired again (and gets a new DeviceID).

## Configuration

| Key | Default | Description |
|---|---|---|
| `devices[].deviceId` | | HomeKit DeviceID from the log. Required. |
| `devices[].name` | DeviceID | Name of the Matter device. |
| `devices[].setupCode` | | 8-digit HomeKit code (`123-45-678`, `12345678` or `1234 5678`). Only needed for the first pairing. |
| `pollInterval` | `10` | Minutes between reads (also per device). |
| `timeout` | `60` | Minutes without a successful read before the device is reported as not responding; it keeps its last values (also per device). |
| `bluetoothBinding` | `dbus` | How the adapter is accessed: `dbus` (BlueZ, recommended) or `hci` (raw HCI, needs root or network capabilities). |

## How it works

- One Bluetooth scan listens to all HomeKit advertisements. When a device's advertised state number changes (HomeKit devices bump it when a value changes), it's read, at most once every 5 minutes. On top of that it's polled every `pollInterval` minutes.
- Each read is a short encrypted Bluetooth connection. Connections run one at a time, and scanning pauses while connected (BlueZ aborts connection attempts during a scan). A connection that times out is disconnected before the next one starts, and a connection in progress is disconnected when Homebridge shuts down: BlueZ would otherwise keep it, and a connected sensor stops advertising.
- Bluetooth goes through BlueZ over D-Bus (noble 2). The underlying library, hap-controller, normally uses raw HCI (noble 1), which in testing couldn't hold a connection to a HomeKit sensor on a Raspberry Pi; this plugin hands it noble 2 instead. That only works in a child bridge: if another plugin in the same process already loaded hap-controller, the plugin refuses to start and says so.
- A device measuring both temperature and humidity becomes **one** Matter endpoint, so controllers that list every endpoint separately (IKEA Dirigera) show one device.
- **A factory reset gives a HomeKit device a new DeviceID.** Put the new DeviceID from the log in the config, and the old one in `matterId`: the device then stays the same in your Matter controller, with its room, name and automations. Without `matterId` it shows up as a new device. If a configured device isn't seen within two minutes of startup, or its reads keep failing, the log says so and names any unconfigured device available to pair as the likely new DeviceID.
- If pairing is removed without a reset (the DeviceID stays the same), the plugin notices and pairs again with the configured setup code. It only acts once the device has kept advertising "not paired" for 30 seconds, and keeps the old pairing keys in a backup file (`<DeviceID>.json.bak`).
- A Matter device whose sensor is removed from the config is kept for a day (and removed with the first restart after that), so a typo or a half-saved config doesn't delete it along with its room and automations. With no valid device configured at all, nothing is removed.
- Pairing keys are saved the moment pairing succeeds. If that fails (e.g. a read-only file system), the log says so and it's retried every minute: don't restart Homebridge until it works, or the keys are lost.
- A read only connects if the sensor was heard in the last 25 seconds (BlueZ forgets a device it hasn't heard for about 30); otherwise it waits and reads the moment the sensor is heard again.
- A failed read is retried after a minute; after five failures in a row, only every `pollInterval` minutes. A failed pairing is retried after 1, 2, 5, then every 10 minutes.
- After `timeout` minutes without a successful read, the Matter device is reported as **not responding** and keeps its last values (rather than clearing them, which some controllers display as an out-of-range value). It responds again with the next successful read. The last values are also kept across restarts.
- Battery level and low-battery warning are reported over Matter; a low battery also sets "replacement needed".
- On the very first setup, the Matter device is created with the first successful read, so it never starts with unknown values (IKEA Dirigera shows an unknown temperature as 100 °C).

## Troubleshooting

- **Pairing keeps failing / the device is no longer found:** Bluetooth sensors can get stuck after a failed connection attempt: they stop advertising and refuse connections. Take the battery out for about 10 seconds and put it back (a restart, *not* a factory reset, which would change the DeviceID). The plugin retries by itself.
- **"Already paired with another HomeKit controller":** remove the device from Apple Home first.
- **"Bluetooth via BlueZ (D-Bus) is not available":** start the bluetooth service (`sudo systemctl start bluetooth`) and make sure the Homebridge user is in the `bluetooth` group, or switch Bluetooth Access to raw HCI.
- **Reads keep failing:** turn on debug logging for the child bridge. Every connection then logs the signal strength and when the device was last heard, e.g. `Connecting (RSSI -78 dBm, heard 2s ago)`. Connections tend to become unreliable below about -85 dBm; moving the device and the Bluetooth adapter closer together helps.
- **"Not seen since startup":** the device is out of range, out of battery, or was factory-reset and has a new DeviceID (the warning names the likely one).

## Known limitations

- **New Matter `uniqueId` after each restart** for temperature+humidity devices, due to a Homebridge limitation ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)). IKEA Dirigera keeps the device, name and room across restarts; other controllers are untested.
- **Bluetooth is shared** with any other Bluetooth plugin on the same adapter. It worked alongside a scanning plugin in testing, but busy adapters can make connections fail; failed reads are retried after a minute.
- HomeKit's encrypted "disconnected events" aren't supported by the underlying library ([hap-controller#43](https://github.com/Apollon77/hap-controller-node/issues/43)), so change detection relies on the advertised state number plus polling.

## Dependencies

Two dependencies look unused but are needed:

- **`dbus-next`**: noble 2 lists it as a peer dependency for its BlueZ (D-Bus) backend, so the plugin has to install it. It's pinned because the plugin patches a bug in it (see `fixMatchRuleRefcounts` in `lib/hap.js`).
- **`node-gyp`**: never called by the plugin. Without a current copy, a dependency of the D-Bus library pulls in node-gyp 7, which fails to build on Node 24 and breaks the install.

Built on [hap-controller](https://github.com/Apollon77/hap-controller-node).
