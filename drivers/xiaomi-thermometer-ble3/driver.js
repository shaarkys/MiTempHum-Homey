"use strict";

const { Driver } = require("homey");

class XiaomiThermometerDriver extends Driver {
  /**
   * Log with timestamp
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [Driver: XiaomiThermometerDriver] -`, ...args);
  }

  /**
   * Initialize driver
   */
  async onInit() {
    this.log("Xiaomi Thermometer BLE (non ATC) Driver initialized.");
  }

  /**
   * List devices for pairing
   */
  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    this.log("onPairListDevices method called for BLE device discovery");

    try {
      const advertisements = await this.homey.ble.discover([], 30000);

      if (!advertisements || advertisements.length === 0) {
        this.log("No BLE devices found during discovery.");
      } else {
        this.log(`Found ${advertisements.length} BLE devices.`);
        // Log details of each discovered device
        advertisements.forEach(ad => {
          const serviceUuids = ad.serviceUuids ? ad.serviceUuids.join(", ") : "None";
          this.log(`Scanned Device - MAC: ${ad.address}, Name: ${ad.localName || "Unknown"}, UUIDs: ${serviceUuids}`);
        });
      }

      const devices = advertisements
        .filter((advertisement) => 
          advertisement.serviceUuids && 
          typeof advertisement.localName === 'string' && 
          advertisement.localName.includes("LYWSD03")
        )
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

module.exports = XiaomiThermometerDriver;
