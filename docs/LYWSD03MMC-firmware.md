# LYWSD03MMC Zigbee firmware

The `xiaomi-thermometer-zigbee` driver offers pvvx ZigbeeTLc **3001-0140** through
Homey's built-in Device Updates. Its OTA file version is **20983809**
(`0x01403001`). This is for sensors already running the Zigbee firmware identifying
as `Xiaomi` / `LYWSD03MMC-z`, manufacturer code `0x1141`, image type `0x020A`.
An additional route supports early pvvx **3001-0118** sensors still identifying as
`Xiaomi` / `LYWSD03MMC`, restricted to manufacturer code `0x1141`, image type
`0x020A`, and current OTA file version **18362369** (`0x01183001`).
It does not flash stock Bluetooth sensors or change the BLE drivers.

## Early pvvx firmware using the old product name

pvvx added the `-z` suffix in **0.1.2.0**, so **0.1.1.8** can report the original
`LYWSD03MMC` product ID. This route reuses the standard 3001-0140 image with an
exact source-version gate; it does not widen the separate devbis migration routes
or enable updates for other firmware using the old product name.

The original identity is defined in the
[pvvx 0.1.1.8 source](https://github.com/pvvx/ZigbeeTLc/blob/8d013ee2cd90bea146be7eb2daf35efe530f12b9/src/version_cfg.h).
Verify the actual sensor's OTA manufacturer code, image type, and file version
before testing. The product name and Basic-cluster firmware string alone do not
prove its OTA identity.

Upstream warns that newer firmware uses an incompatible settings format and can
clear previous settings and network bindings. Record the sensor's settings and
existing Flows before updating; re-pairing may be required. See the
[upstream compatibility warning and version history](https://github.com/pvvx/ZigbeeTLc).

## Changes since the bundled 0.1.3.8 firmware

- **0.1.4.0:** Updated the shared Zigbee reporting function. Upstream does not
  describe the exact reporting behavior change or list a LYWSD03MMC-specific fix.
- The other upstream additions in **0.1.3.9** and **0.1.4.0** concern other sensor
  models, Tuya startup relocation, or ZHA integration. They are not advertised as
  new LYWSD03MMC features in this app.

Source: [upstream version history](https://github.com/pvvx/ZigbeeTLc#current-additions).
No improvement to battery life, measurement accuracy, or connection stability is
claimed by these release notes for this update.

## Firmware provenance

The bundled `1141-020a-01403001-Z03MMC.zigbee` is the pvvx image distributed by the
[Koenkk Zigbee OTA repository](https://github.com/Koenkk/zigbee-OTA/tree/master/images/pvvx).
Its metadata was checked against the
[OTA index](https://raw.githubusercontent.com/Koenkk/zigbee-OTA/master/index.json).
The image is 133922 bytes and has SHA-512:

```text
2247834994fbc2f88a6cd7c593bd32af1015cee5ac70255f67d479272a5083dd392a3103fba4bb4dc1bc66f0a9759241e42bd55564d5565324b062ad6b7bec29
```

Upstream project: [pvvx/ZigbeeTLc](https://github.com/pvvx/ZigbeeTLc).
Do not substitute another image based on its file version alone: other sensor
models use the same version with different image types. The upstream working
tree can also contain different bytes under the same filename; verify the hash.

The existing devbis 1.0.6 / 1.1.0 migration images remain at 3001-0138 with their
original exact source-version gates and image type `0x0203`. They are separate
from the standard `0x020A` update. After migration, verify the sensor reports
`LYWSD03MMC-z` and its actual OTA identity before attempting the 0140 update.

## Manual Homey test

Package checks do not verify a physical firmware update. On a TEST installation
containing this change:

1. Confirm an existing LYWSD03MMC-z still reports temperature, humidity, battery,
   and voltage, and record its settings and firmware diagnostics.
2. Fit a fresh battery if needed and keep the sensor close to Homey. Open
   **More > Settings > Device Updates**, or the device's **Settings > Maintenance**.
   Verify the offered version is 20983809 for the matching OTA identity.
3. Start the update manually and follow Homey's wake instructions. Wait for
   Homey to report successful completion.
4. Confirm the installed OTA version is 20983809, measurements resume, settings
   and existing Flows still work, and measurements resume after an app restart.
5. Separately test the retained devbis migration route if it is needed. Do not
   treat standard pvvx update success as proof of that migration path.
6. For the early pvvx route, first verify `Xiaomi` / `LYWSD03MMC`, manufacturer
   code `0x1141`, image type `0x020A`, and current file version `0x01183001`.
   Check that 20983809 is offered, then perform steps 2-4 on one TEST sensor.
   Account for the possible settings/binding reset described above, and verify
   the resulting product ID, settings, measurements, and existing Flows. Confirm
   a devbis sensor still receives only its matching migration image.

Homey's [device update guide](https://support.homey.app/hc/en-us/articles/27220629667356-Update-your-devices-in-Homey)
describes update availability, wake instructions, and progress reporting.
