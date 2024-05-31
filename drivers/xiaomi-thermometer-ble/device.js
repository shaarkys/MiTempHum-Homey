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
    console.log(`${timestamp} [Device: ${deviceName} -`, ...args);
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log("Xiaomi BLE device has been initialized");
    console.log(this.getData());
    this.addListener("updateTag", this.updateTag);

    // Get the initial temperature offset setting
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log("Xiaomi BLE has been added");
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
    this.log("Xiaomi BLE settings were changed");

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
    this.log("Xiaomi BLE was renamed");
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log("Xiaomi BLE has been deleted");
  }

  async updateTag(foundDevices) {
    console.log(`Updating measurements ${this.getName()}`);
    let deviceData = this.getData();
    let settings = this.getSettings();
    let mac = this.getData();
    foundDevices.forEach((device) => {
      //this.log("Device Mac: ",device.address);
      if (device.address == mac["id"]) {
        console.log("Match!", mac, device.address);
        console.log(device.serviceData);
        const sdata = device.serviceData;
        sdata.forEach((uuid) => {
          if (uuid.uuid == "0000181a-0000-1000-8000-00805f9b34fb" || uuid.uuid == "181a") {
            var datas = uuid["data"];
            const dattta = Buffer.from(uuid["data"], "hex");
            console.log(device.localName);
            console.log("BLE Temp: ", ((dattta[6] << 8) | dattta[7]) / 10, "Celsius");
            console.log("BLE Hum: ", dattta[8], "%");
            console.log("BLE Batt: ", dattta[9], "%");
            console.log("");
            let temperature = ((dattta[6] << 8) | dattta[7]) / 10 + this.temperatureOffset;
            let humidity = dattta[8];
            let battery = dattta[9];
            this.setCapabilityValue("measure_temperature", temperature);
            this.setCapabilityValue("measure_humidity", humidity);
            this.setCapabilityValue("measure_battery", battery);
          }
        });
      } else {
        //throw new Error("The device could not be found!");
        console.log("Xiaomi BLE devices not found !");
      }
    });
  }
}
function readTemperature(buffer) {
  const data = Buffer.from(uuid["data"], "hex");
  console.log(((data[6] << 8) | data[7]) / 10), "readtemperature";
  return ((data[6] << 8) | data[7]) / 10;
}
module.exports = MyDevice;
