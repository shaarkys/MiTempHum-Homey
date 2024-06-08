"use strict";

const { Driver } = require("homey");

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

      if (advertisements.length === 0) {
        this.log("No BLE devices found during discovery.");
      } else {
        this.log(`Found ${advertisements.length} BLE devices.`);
        // Log details of each discovered device
        advertisements.forEach(ad => {
          this.log(`Scanned Device - MAC: ${ad.address}, Name: ${ad.localName || "Unknown"}, UUIDs: ${ad.serviceUuids.join(", ")}`);
        });
      }

      const devices = advertisements
        .filter((advertisement) => advertisement.serviceUuids && advertisement.serviceUuids.includes("0000180f00001000800000805f9b34fb"))
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
      this.error("Error during BLE device listing:", error);
      throw error;
    }
  }
}

module.exports = MyDriver;
