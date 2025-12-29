"use strict";

const { Driver } = require("homey");
const delay = (s) => new Promise((resolve) => setTimeout(resolve, 1000 * s));
const normalizeUuid = (uuid) => (uuid || "").toLowerCase().replace(/-/g, "");
const UUID_181A_LONG = "0000181a00001000800000805f9b34fb";
const UUID_181A_SHORT = "181a";
const isUuid181a = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_181A_SHORT || normalized === UUID_181A_LONG;
};

class MyDriver extends Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log("ATC BLE driver has been initialized");

    // Initial check for devices
    this.managePolling();

    // Listen for device add/remove events to manage polling dynamically
    this.on("device.added", this.managePolling.bind(this));
    this.on("device.removed", this.managePolling.bind(this));
  }

  managePolling() {
    const devices = this.getDevices();
    if (devices.length > 0 && !this.polling) {
      this.polling = true;
      this.addListener("poll", this.pollDevice.bind(this));
      this.emit("poll");
      this.log("Started polling BLE ATC devices.");
    } else if (devices.length === 0 && this.polling) {
      this.polling = false;
      this.log("No ATC LYWSD03MMC devices found. Polling is disabled.");
    }
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */

  async onPairListDevices() {
    this.log("onPairListDevices method called for BLE device discovery");

    try {
      let devices = [];
      this.log("Initiating BLE ATC LYWSD03MMC discovery...");
      const foundDevices = await this.homey.ble.discover([], 30000);

      if (foundDevices.length === 0) {
        this.log("No BLE ATC LYWSD03MMC devices found during discovery.");
      } else {
        this.log(`Found ${foundDevices.length} BLE LYWSD03MMC devices.`);
        foundDevices.forEach((device) => {
          this.log(`Discovered device: ${device.localName}, address: ${device.address}`);
          const sdata = Array.isArray(device.serviceData) ? device.serviceData : [];
          if (sdata.length > 0) {
            this.log(`Device ${device.localName} has service data.`);
            sdata.forEach((uuid) => {
              this.log(`Checking UUID: ${uuid.uuid} for device: ${device.localName}`);
              if (isUuid181a(uuid.uuid)) {
                this.log(`Matching UUID found for device: ${device.localName}`);
                let new_device = {
                  name: device.localName,
                  data: { id: device.address },
                };
                devices.push(new_device);
                this.log(`Device added for pairing: ${device.localName}, address: ${device.address}`);
              } else {
                this.log(`Device ${device.localName} with UUID ${uuid.uuid} does not match.`);
              }
            });
          } else {
            this.log(`Device ${device.localName} does not have service data.`);
          }
        });
      }
      this.log(`Total devices added for pairing: ${devices.length}`);
      return devices;
    } catch (error) {
      this.error("Error during BLE device listing:", error);
    }
  }

  async pollDevice() {
    while (this.polling) {
      this.log("Refreshing BLE ATC devices");
      let polling_interval = this.homey.settings.get("polling_interval") || 30;
      let scan_duration = this.homey.settings.get("scan_duration") || 20;

      let devices = this.getDevices();

      try {
        const foundDevices = await this.homey.ble.discover([], scan_duration * 1000);
        this.log("Scan complete!");
        if (foundDevices.length === 0) {
          this.log("No new advertisements were detected. Retrying in 1 second.");
          await delay(1);
        } else {
          devices.forEach((device) => {
            if (device && device.getAvailable()) {
              // Check if device is available
              device.emit("updateTag", foundDevices);
            } else {
              this.log(`Device ${device.getName()} is not available.`);
            }
          });
          await delay(polling_interval);
        }
      } catch (error) {
        if (error.message === "Operation already in progress") {
          this.log("BLE discovery operation already in progress. Retrying in 1 second.");
          await delay(1);
        } else {
          this.error("Error during BLE discovery:", error);
        }
      }
    }
  }
}

module.exports = MyDriver;
