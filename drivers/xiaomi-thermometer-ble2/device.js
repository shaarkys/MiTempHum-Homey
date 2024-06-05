"use strict";

const { Device } = require("homey");

class MyDevice extends Device {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    const deviceId = this.getData().id || this.getData().token;
    const deviceName = this.getName();
    console.log(`${timestamp} [Device: ${deviceName}] -`, ...args);
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log("LYWSDCGQ/01ZM BLE device has been initialized - ", this.getData());
    // lets reset all values
    this.setCapabilityValue("measure_temperature", null);
    this.setCapabilityValue("measure_humidity", null);
    //this.setCapabilityValue("measure_battery", null);
    this.addListener("updateTag", this.updateTag);

    // Get the initial temperature offset setting
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;

    // Start scanning for BLE devices periodically
    this.startBLEScan();
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log("LYWSDCGQ/01ZM BLE has been added");
    this.emit("poll");
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log("LYWSDCGQ/01ZM BLE settings were changed");

    if (changedKeys.includes("temperature_offset")) {
      this.temperatureOffset = newSettings.temperature_offset;
      this.log(`Device ${this.getName()} temperature offset: ${this.temperatureOffset}°C`);
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log("LYWSDCGQ/01ZM BLE was renamed");
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log("LYWSDCGQ/01ZM BLE has been deleted");
    this.stopBLEScan();
  }

  /**
   * Periodically scan for BLE devices
   */
  async startBLEScan() {
    this.log("Starting BLE scan");
    this.scanInterval = setInterval(() => this.scanForDevices(), 30000); // Adjust the interval as needed
  }

  /**
   * Stop scanning for BLE devices
   */
  stopBLEScan() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      this.log("Stopped BLE scan");
    }
  }

  /**
   * Scan for BLE devices and update capabilities
   */
  async scanForDevices() {
    try {
      const foundDevices = await this.homey.ble.discover();
      this.updateTag(foundDevices);
    } catch (error) {
      this.log("Error during BLE scan:", error);
    }
  }

  async updateTag(foundDevices) {
    this.log(`Updating measurements for ${this.getName()}`);

    const deviceData = this.getData();
    const mac = deviceData.id;

    for (const device of foundDevices) {
      if (device.address === mac) {
        this.log("Match found!", device.address);

        const sdata = device.serviceData;
        for (const uuid of sdata) {
          if (uuid.uuid === "0000fe95-0000-1000-8000-00805f9b34fb" || uuid.uuid === "fe95") {
            const data = Buffer.from(uuid.data, "hex");

            let temperature, humidity;

            this.log("Analyzing buffer:", data.toString("hex"), "with length:", data.length);

            if (data.length === 16) {
              let possibleValue = data[14] / 10;
              if (possibleValue >= 0 && possibleValue <= 99) {
                this.log("Skipped Buffer length ", data.length);
              }
            } else if (data.length === 18) {
              temperature = data[14] / 10 + this.temperatureOffset;
              humidity = ((data[17] << 8) | data[16]) / 10;
            } else {
              this.log("Buffer length ", data.length);
            }

            this.log(`LYWSDCGQ temperature: ${temperature}°C, Humidity: ${humidity}%`);

            if (temperature !== undefined) {
              if (temperature < -20 || temperature > 50) {
                this.log(`Ignoring temperature reading: ${temperature}°C`);
              } else {
                this.setCapabilityValue("measure_temperature", temperature);
              }
            }

            if (humidity !== undefined) {
              if (humidity < 10 || humidity > 99) {
                this.log(`Ignoring humidity reading: ${humidity}%`);
              } else {
                this.setCapabilityValue("measure_humidity", humidity);
              }
            }
          }
        }

        // Check if the device advertises the battery service UUID
        if (device.serviceUuids.includes("0000180f00001000800000805f9b34fb")) {
          // Connect to the device to read the battery level
          try {
            const advertisement = await this.homey.ble.find(device.uuid);
            const peripheral = await advertisement.connect();
            this.log(`Connected to device: ${device.uuid}`);
            const batteryServiceUuid = "0000180f00001000800000805f9b34fb";
            const batteryCharacteristicUuid = "00002a1900001000800000805f9b34fb";

            const batteryLevel = await peripheral.read(batteryServiceUuid, batteryCharacteristicUuid);
            const battery = batteryLevel.readUInt8(0);
            this.log(`Battery level: ${battery}%`);

            if (battery !== undefined) {
              if (battery < 0 || battery > 100) {
                this.log(`Ignoring battery reading: ${battery}%`);
              } else {
                this.setCapabilityValue("measure_battery", battery);
              }
            }

            await peripheral.disconnect();
            this.log(`Disconnected from device: ${device.uuid}`);
          } catch (error) {
            this.log(`Failed to connect or read battery level: ${error}`);
          }
        }
      }
    }
  }
}

module.exports = MyDevice;
