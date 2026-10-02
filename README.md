# homebridge-homekit-ble-matter

Brings **HomeKit-only Bluetooth sensors** to **Matter** controllers such as IKEA Dirigera, Google Home, Amazon Alexa or SmartThings.

Some sensors only speak HomeKit over Bluetooth (for example the Qingping Temp & RH Monitor **H version, CGG1H**), so only Apple Home can use them. This plugin pairs with such devices the way Apple Home would, reads their values, and exposes each one as a Matter device through Homebridge's Matter bridge. Add as many sensors as you like, of any supported kind.

## Supported sensors

Read-only HomeKit Bluetooth sensors. Controllable devices (plugs, lights, locks, blinds) are out of scope.

| HomeKit service | Matter device | Notes |
|---|---|---|
| Temperature, Humidity | Temperature Sensor / Humidity Sensor | One device when it measures both |
| Contact | Contact Sensor | Closed = contact |
| Leak | Water Leak Detector | |
| Motion, Occupancy | Occupancy Sensor | |
| Light | Light Sensor | Lux on Matter's logarithmic scale |
| Smoke, Carbon Monoxide | Smoke/CO Alarm | Plus CO level; low battery and fault as alarm states |
| Air Quality, Carbon Dioxide, PM2.5, PM10, VOC, NO₂, Ozone | Air Quality Sensor | Each measurement as its own Matter concentration; an air monitor's temperature and humidity on the same device. A CO₂ sensor without an air quality rating shows good/poor from its "abnormal" flag |
| Battery | Power Source on the device | Level, low battery, "replacement needed" |

A device with several kinds of sensors (e.g. motion plus light) becomes one Matter device with the main sensor first and the others as parts; a service the device has twice (e.g. two temperature sensors) becomes its own part. Buttons (stateless switches) aren't supported yet.

## Requirements

- Homebridge **2.4.0** or later, with Matter
- A Bluetooth adapter the Homebridge host can use (the Raspberry Pi's built-in one works)
- Node.js 20, 22 or 24
- BlueZ (the standard Linux Bluetooth service) running, and the Homebridge user allowed to use it: on Raspberry Pi OS the default `pi` user is; otherwise add it to the `bluetooth` group (`sudo usermod -aG bluetooth <user>`, then restart Homebridge)

## Setup

1. **Remove the device from Apple Home** (accessory → Remove Accessory). A HomeKit device can only be paired with one controller this way.
2. Install the plugin and run it as a **child bridge**. In the child bridge settings, turn **Enable Matter** on (and HomeKit off: this plugin exposes nothing over HomeKit).
3. Restart. The log lists every nearby HomeKit Bluetooth device:
   ```
   Found HomeKit Bluetooth sensor 'Qingping Temp RH H' - DeviceID 41:21:14:E5:C2:25, available to pair. Add it under 'devices' to use it.
   ```
4. Add each device with its **DeviceID** (not the Bluetooth address) and its **HomeKit setup code**:
   ```json
   {
     "platform": "HomeKitBleMatter",
     "devices": [
       { "deviceId": "41:21:14:E5:C2:25", "name": "Bedroom", "setupCode": "128-84-842" },
       { "deviceId": "7C:0A:3F:52:9B:E1", "name": "Front door", "setupCode": "031-45-154" }
     ]
   }
   ```
5. Restart. The plugin pairs with each device, reads its structure and registers one Matter device per sensor. Add the bridge to your Matter controller with the code from the child bridge's Matter settings; sensors added later show up there by themselves.

The pairing keys are stored in `<Homebridge storage>/homekit-ble-matter/`, one file per device. Keep that folder: without it a device has to be factory-reset before it can be paired again (and gets a new DeviceID).

## Configuration

| Key | Default | Description |
|---|---|---|
| `devices[].deviceId` | | HomeKit DeviceID from the log. Required. |
| `devices[].name` | DeviceID | Name of the Matter device. |
| `devices[].setupCode` | | 8-digit HomeKit code (`123-45-678`, `12345678` or `1234 5678`). Only needed for the first pairing. |
| `devices[].matterId` | DeviceID | Only after a factory reset: the device's old DeviceID, so it stays the same device in your Matter controller (see below). |
| `fastUpdates` | `false` | Let devices send changes the moment they happen (HomeKit broadcast notifications) instead of only on the next read (also per device). |
| `pollInterval` | `10` | Minutes between reads (also per device). |
| `timeout` | `60` | Minutes without a successful read before the device is reported as not responding; it keeps its last values (also per device). |
| `bluetoothBinding` | `dbus` | How the adapter is accessed: `dbus` (BlueZ, recommended) or `hci` (raw HCI, needs root or network capabilities). |

## How it works

- One Bluetooth scan listens to all HomeKit advertisements. When a device's advertised state number changes (HomeKit devices bump it when a value changes), it's read, at most once every 5 minutes - or every 30 seconds for a device reporting events (contact, motion, occupancy, leak, smoke, CO, CO₂ alarm), where 5 minutes late would be useless. On top of that it's polled every `pollInterval` minutes.
- **Fast updates** (`fastUpdates`): HomeKit devices can announce a changed value in an encrypted advertisement that only their paired controller can read. With fast updates on, the plugin asks the device for its broadcast key once (one extra connection), enables the announcements for every reading that supports them, and applies each change the moment it's heard - no connection, seconds instead of minutes. Devices without support say so once in the log and keep working as before. The underlying library doesn't implement this ([hap-controller#43](https://github.com/Apollon77/hap-controller-node/issues/43)); the plugin does it itself.
- **Several sensors run side by side.** Each has its own pairing, poll interval, timeout and Matter device. They share one scan and take turns on the Bluetooth adapter, so a sensor that is out of range, out of battery or slow to answer never holds up the others: only that one is reported as not responding, and it's picked up again the moment it's back.
- Each read is a short encrypted Bluetooth connection. Connections run one at a time, and scanning pauses while connected (BlueZ aborts connection attempts during a scan). A connection that times out is disconnected before the next one starts, and a connection in progress is disconnected when Homebridge shuts down: BlueZ would otherwise keep it, and a connected sensor stops advertising.
- Bluetooth goes through BlueZ over D-Bus (noble 2). The underlying library, hap-controller, normally uses raw HCI (noble 1), which doesn't hold a connection to a HomeKit sensor reliably on a Raspberry Pi; this plugin hands it noble 2 instead. That only works in a child bridge: if another plugin in the same process already loaded hap-controller, the plugin refuses to start and says so.
- A device measuring both temperature and humidity becomes **one** Matter endpoint, so controllers that list every endpoint separately (IKEA Dirigera) show one device. Only different kinds of sensors on one device get separate endpoints (parts).
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

- **New Matter `uniqueId` after each restart** for temperature+humidity devices, due to a Homebridge limitation ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)). IKEA Dirigera keeps the device, name and room across restarts.
- **Bluetooth is shared** with any other Bluetooth plugin on the same adapter. The plugin works alongside other scanning plugins; on a busy adapter a connection can fail now and then, and a failed read is retried after a minute.
- Without `fastUpdates` (or on a device that doesn't support it), changes are picked up by the advertised state number plus polling: seconds to minutes, not instant.

## Dependencies

Two dependencies look unused but are needed:

- **`dbus-next`**: noble 2 lists it as a peer dependency for its BlueZ (D-Bus) backend, so the plugin has to install it. It's pinned because the plugin patches a bug in it (see `fixMatchRuleRefcounts` in `lib/hap.js`).
- **`node-gyp`**: never called by the plugin. Without a current copy, a dependency of the D-Bus library pulls in node-gyp 7, which fails to build on Node 24 and breaks the install.

Built on [hap-controller](https://github.com/Apollon77/hap-controller-node).
