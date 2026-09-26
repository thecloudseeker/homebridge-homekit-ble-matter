# homebridge-homekit-ble-matter

Brings **HomeKit-only Bluetooth sensors** to **Matter** controllers such as IKEA Dirigera, Google Home, Amazon Alexa or SmartThings.

Some sensors only speak HomeKit over Bluetooth (for example the Qingping Temp & RH Monitor **H version, CGG1H**), so only Apple Home can use them. This plugin pairs with such a device the way Apple Home would, reads its values, and exposes it through Homebridge's Matter bridge.

> **Beta.** Tested with a Qingping CGG1H on a Raspberry Pi. Currently supports temperature and humidity sensors (with battery level).

## Requirements

- Homebridge **2.4.0** or later, with Matter
- A Bluetooth adapter the Homebridge host can use (the Raspberry Pi's built-in one works)
- Node.js 20, 22 or 24

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

The pairing keys are stored in `<Homebridge storage>/homekit-ble-matter/`. Keep that folder: without it the device has to be factory-reset before it can be paired again.

## Configuration

| Key | Default | Description |
|---|---|---|
| `devices[].deviceId` | | HomeKit DeviceID from the log. Required. |
| `devices[].name` | DeviceID | Name of the Matter device. |
| `devices[].setupCode` | | 8-digit HomeKit code (`123-45-678`, `12345678` or `1234 5678`). Only needed for the first pairing. |
| `pollInterval` | `10` | Minutes between reads (also per device). |
| `timeout` | `60` | Minutes without a successful read before values are reported as unavailable (also per device). |

## How it works

- One Bluetooth scan listens to all HomeKit advertisements. When a device's advertised state number changes (HomeKit devices bump it when a value changes), it's read, at most once every 5 minutes. On top of that it's polled every `pollInterval` minutes.
- Each read is a short encrypted Bluetooth connection. Connections run one at a time.
- A device measuring both temperature and humidity becomes **one** Matter endpoint, so controllers that list every endpoint separately (IKEA Dirigera) show one device.
- If a device is factory-reset, the plugin notices (it advertises as unpaired again) and pairs again with the configured setup code.

## Known limitations

- **New Matter `uniqueId` after each restart** for temperature+humidity devices, due to a Homebridge limitation ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)). IKEA Dirigera keeps the device, name and room across restarts; other controllers are untested.
- **Bluetooth is shared** with any other Bluetooth plugin on the same adapter. It worked alongside a scanning plugin in testing, but busy adapters can make connections fail; failed reads are retried after a minute.
- HomeKit's encrypted "disconnected events" aren't supported by the underlying library ([hap-controller#43](https://github.com/Apollon77/hap-controller-node/issues/43)), so change detection relies on the advertised state number plus polling.

Built on [hap-controller](https://github.com/Apollon77/hap-controller-node).
