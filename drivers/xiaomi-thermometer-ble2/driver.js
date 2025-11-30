"use strict";

const { Driver } = require("homey");

const normalizeUuid = uuid => (uuid || "").toLowerCase().replace(/-/g, "");

class MyDriver extends Driver {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [Driver: xiaomi-thermometer-ble2 LYWSDCGQ] -`, ...args);
  }

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log("BLE driver has been initialized");
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    this.log("onPairListDevices method called for BLE device discovery");

    try {
      const advertisements = await this.homey.ble.discover([], 30000);
      const seen = new Set();
      const devices = [];

      this.log(`Scanned ${advertisements.length} BLE advertisements for ATC.`);

      advertisements.forEach(advertisement => {
        if (!advertisement.address || seen.has(advertisement.address)) return;

        const serviceUuids = advertisement.serviceUuids || [];
        const has181a =
          serviceUuids.some(u => normalizeUuid(u).includes("181a")) ||
          (advertisement.serviceData || []).some(s => normalizeUuid(s.uuid).includes("181a"));

        const name = advertisement.localName || "";
        const looksAtc = name.toUpperCase().startsWith("ATC_");
        const hasServiceData = (advertisement.serviceData || []).length > 0;
        if (!has181a && !looksAtc && !hasServiceData) return;

        seen.add(advertisement.address);
        devices.push({
          name: name || `Device ${advertisement.address}`,
          data: { id: advertisement.address },
          store: { peripheralUuid: advertisement.uuid },
        });
      });

      this.log(`Total devices added for pairing: ${devices.length}`);
      return devices;
    } catch (error) {
      this.error("Error during BLE device listing:", error);
      throw error;
    }
  }
}

module.exports = MyDriver;
