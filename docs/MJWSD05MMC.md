# Xiaomi Smart Temperature and Humidity Monitor 3

The `xiaomi-mjwsd05mmc` driver recognises MJWSD05MMC MiBeacon product IDs `0x2832` and `0x4C47`. The latter is documented upstream with stock firmware `2.0.0_0005`. These are different from XMWSDJ04MMC (`0x1203`). Recognition uses FE95 service data, not the Bluetooth name or connectable flag.

## Setup

1. Keep the sensor activated in Xiaomi Home. Close its live Bluetooth connection while scanning in Homey.
2. Add **Xiaomi Temperature and Humidity Monitor 3 (MJWSD05MMC)** in Xiaomi Miija.
3. Open the new device's Advanced Settings and enter its own 32-character hexadecimal BLE bindkey. Pairing does not require the key; encrypted measurements do.
4. Wait for advertisements. Temperature, humidity and battery may arrive in separate packets; absent values retain their previous readings.

Keep bindkeys private. The `blt.*` Xiaomi device ID is not a bindkey. Existing keys can be retrieved through Xiaomi Cloud tools described in the [Home Assistant documentation](https://www.home-assistant.io/integrations/xiaomi_ble/#encryption). Flashing, resetting, or changing the sensor's firmware is not required by this driver.

The driver listens to advertisements where Homey supports subscriptions; otherwise, or if subscription fails, it checks the latest advertisement every minute. It never opens a GATT connection, writes to the sensor, or sets its clock. Discovery logs report total advertisements and matching sensors without logging keys or raw payloads.

## Manual Homey smoke test

Hardware behavior remains unverified until these checks succeed on the target Homey Pro Mini and Bridge:

1. Install the test app only when authorised. Confirm startup has no exceptions and the MJWSD05MMC driver appears.
2. Scan beside the Bridge. Confirm a sensor is discovered under its dedicated driver; pair it without a bindkey. Capture the product-ID diagnostic and confirm an encrypted-measurement warning appears.
3. Enter a wrong but valid-length key: the decryption warning should appear, with no fabricated sensor readings. Enter the correct key: temperature and humidity should match the display (allow for broadcast delay), battery should eventually arrive, and the warning should clear. Keys must not appear in logs.
4. Change the temperature offset; confirm it applies to the next valid reading. Confirm a standard Homey temperature/humidity Flow responds to changed readings.
5. Pair the other two sensors with their individual keys. Confirm readings stay associated with the correct devices.
6. Restart the app. Confirm all sensors resume updates using their saved keys, with one subscription or fallback timer per device.
7. Delete one sensor while updates are arriving. Confirm there are no later capability writes or recurring errors for it, and the other sensors continue updating.
8. Confirm an existing XMWSDJ04MMC/other supported sensor still updates and its existing Flows still work.

If discovery still returns zero matches, capture the sensor's BLE Developer Tool entry, including FE95 service data, plus Homey and app versions. The matching-count log alone cannot establish whether the Bridge forwarded a particular sensor's advertisement.

## Protocol references

- [Upstream product IDs](https://github.com/Bluetooth-Devices/xiaomi-ble/blob/main/src/xiaomi_ble/devices.py)
- [Newer revision and captured encrypted frame](https://github.com/Bluetooth-Devices/xiaomi-ble/pull/336)
- [Upstream object decoder](https://github.com/Bluetooth-Devices/xiaomi-ble/blob/main/src/xiaomi_ble/parser.py)
- [Homey advertisement subscriptions and fallback](https://apps.developer.homey.app/wireless/bluetooth)
- [Xiaomi specifications](https://www.mi.com/sa-en/product/xiaomi-smart-temperature-and-humidity-monitor-3/specs/)
