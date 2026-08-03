"use strict";

const { Driver } = require("homey");
const {
  parseCgd1Advertisement,
} = require("../../lib/cgd1-advertisement");

const DISCOVERY_SCAN_MS = 20000;

class QingpingCgd1Driver extends Driver {
  async onInit() {
    this.log("Qingping CGD1 BLE driver initialized");
  }

  async onPairListDevices() {
    this.log(`Starting ${DISCOVERY_SCAN_MS / 1000}-second CGD1 BLE discovery`);
    const advertisements = await this.homey.ble.discover([], DISCOVERY_SCAN_MS);
    const devicesById = new Map();

    for (const advertisement of Array.isArray(advertisements) ? advertisements : []) {
      const parsed = parseCgd1Advertisement(advertisement);
      if (!parsed) continue;

      this.log(`CGD1 ${parsed.format} candidate (RSSI ${advertisement.rssi ?? "unknown"} dBm)`);

      const deviceId = advertisement.uuid || advertisement.address;
      if (!deviceId || devicesById.has(deviceId)) continue;

      const addressSuffix = typeof advertisement.address === "string"
        ? advertisement.address.replace(/:/g, "").slice(-4).toUpperCase()
        : "";
      devicesById.set(deviceId, {
        name: advertisement.localName || `Qingping CGD1${addressSuffix ? ` ${addressSuffix}` : ""}`,
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
    this.log(`CGD1 discovery completed with ${devices.length} matching device(s)`);
    return devices;
  }
}

module.exports = QingpingCgd1Driver;
