"use strict";

const { Driver } = require("homey");
const { parseMjwsd05mmcAdvertisement } = require("../../lib/mjwsd05mmc-advertisement");

class XiaomiMjwsd05mmcDriver extends Driver {
  async onInit() {
    this.log("Xiaomi MJWSD05MMC BLE driver initialized");
  }

  async onPairListDevices() {
    this.log("Starting MJWSD05MMC BLE discovery");
    const advertisements = await this.homey.ble.discover();
    const devices = new Map();
    for (const advertisement of Array.isArray(advertisements) ? advertisements : []) {
      const parsed = parseMjwsd05mmcAdvertisement(advertisement);
      if (!parsed) continue;
      const id = advertisement.uuid || advertisement.address;
      if (!id || devices.has(id)) continue;
      this.log("MJWSD05MMC candidate: product 0x" + parsed.deviceId.toString(16)
        + ", MiBeacon v" + parsed.version + ", encrypted=" + parsed.encrypted);
      devices.set(id, {
        name: "Xiaomi Temperature and Humidity Monitor 3",
        data: { id },
        store: { address: advertisement.address, peripheralUuid: advertisement.uuid || id },
      });
    }
    this.log("MJWSD05MMC discovery completed: "
      + (Array.isArray(advertisements) ? advertisements.length : 0)
      + " advertisement(s), " + devices.size + " matching device(s)");
    return Array.from(devices.values());
  }
}

module.exports = XiaomiMjwsd05mmcDriver;
