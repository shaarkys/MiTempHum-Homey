"use strict";

const { Driver } = require("homey");
const {
  parseXmwsdj04mmcAdvertisement,
} = require("../../lib/xmwsdj04mmc-advertisement");

const DISCOVERY_SCAN_MS = 20000;

class XiaomiXmwsdj04mmcDriver extends Driver {
  async onInit() {
    this.log("Xiaomi XMWSDJ04MMC BLE driver initialized");
  }

  async onPairListDevices() {
    this.log(
      "Starting "
      + (DISCOVERY_SCAN_MS / 1000)
      + "-second XMWSDJ04MMC BLE discovery; press the device button if it is not found.",
    );
    const advertisements = await this.homey.ble.discover([], DISCOVERY_SCAN_MS);
    const devicesById = new Map();

    for (const advertisement of Array.isArray(advertisements) ? advertisements : []) {
      const parsed = parseXmwsdj04mmcAdvertisement(advertisement);
      if (!parsed) continue;

      this.log(
        "XMWSDJ04MMC "
        + parsed.format
        + " candidate (RSSI "
        + (advertisement.rssi ?? "unknown")
        + " dBm)",
      );

      const deviceId = advertisement.uuid || advertisement.address;
      if (!deviceId || devicesById.has(deviceId)) continue;

      devicesById.set(deviceId, {
        name: advertisement.localName || "Xiaomi XMWSDJ04MMC",
        data: {
          id: deviceId,
        },
        store: {
          address: advertisement.address,
          peripheralUuid: advertisement.uuid || deviceId,
        },
      });
    }

    const devices = Array.from(devicesById.values());
    this.log("XMWSDJ04MMC discovery completed with " + devices.length + " matching device(s)");
    return devices;
  }
}

module.exports = XiaomiXmwsdj04mmcDriver;
