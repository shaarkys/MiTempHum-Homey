"use strict";

const { Driver } = require("homey");

class LYWSD02MMC_Driver extends Driver {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [Driver: LYWSD02MMC] -`, ...args);
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
    this.log("onPairListDevices method called for LYWSD02MMC discovery");

    try {
      const advertisements = await this.homey.ble.discover([], 30000);

      if (advertisements.length === 0) {
        this.log("No LYWSD02MMCs found during discovery.");
      } else {
        this.log(`Found ${advertisements.length} LYWSD02MMCs.`);
        // Log details of each discovered device
        advertisements.forEach(ad => {
          this.log(`Scanned Device - MAC: ${ad.address}, Name: ${ad.localName || "Unknown"}, UUIDs: ${ad.serviceUuids.join(", ")}`);
        });
      }

      const devices = advertisements
        .filter((advertisement) => advertisement.serviceUuids && advertisement.serviceUuids.includes("0000181a00001000800000805f9b34fb"))
        .map((advertisement) => {
          // Log the devices that will be added
          this.log(`Device added for pairing - MAC: ${advertisement.address}, Name: ${advertisement.localName || `Device ${advertisement.address}`}, UUID: ${advertisement.uuid}`);
          return {
            name: advertisement.localName || `Device ${advertisement.address}`,
            data: {
              id: advertisement.address,
            },
            store: {
              peripheralUuid: advertisement.uuid,
            },
          };
        });

      this.log(`Total devices added for pairing: ${devices.length}`);
      return devices;
    } catch (error) {
      this.error("Error during LYWSD02MMC listing:", error);
      throw error;
    }
  }
}

module.exports = LYWSD02MMC_Driver;
