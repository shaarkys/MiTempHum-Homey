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
   * Delay function
   */
  delay(s) {
    return new Promise((resolve) => setTimeout(resolve, 1000 * s));
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log("LYWSDCGQ/01ZM BLE device has been initialized - ", this.getData());
    // Reset all values
    this.setCapabilityValue("measure_temperature", null);
    this.setCapabilityValue("measure_humidity", null);
    this.setCapabilityValue("measure_battery", null);

    if (!this.hasCapability("measure_rssi")) await this.addCapability("measure_rssi");

    this.setCapabilityValue("measure_rssi", null);

    // Get the initial temperature offset setting
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;

    // Get the reconnect interval setting, default to 5 minutes
    this.reconnectInterval = this.getSetting("reconnect_interval") || 5 * 60;

    // Enable notifications and subscribe to them
    await this.enableNotifications();
    await this.subscribeToBLENotifications();

    // Set up polling
    this.addListener("poll", this.subscribeToBLENotifications.bind(this));
    this.pollDevice();
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log("LYWSDCGQ/01ZM BLE has been added");
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

    if (changedKeys.includes("reconnect_interval")) {
      this.reconnectInterval = newSettings.reconnect_interval || 5 * 60;
      this.log(`Device ${this.getName()} reconnect interval: ${this.reconnectInterval} seconds`);
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    this.log("LYWSDCGQ/01ZM BLE was renamed");
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    this.log("LYWSDCGQ/01ZM BLE has been deleted");
    await this.stopBLESubscription();
    this.polling = false;
    clearInterval(this.pollingInterval);
  }

  /**
   * Enable notifications for temperature, humidity, and battery
   */
  async enableNotifications() {
    this.log("Enabling notifications for temperature, humidity, and battery");
    const deviceData = this.getData();
    const uuid = deviceData.id.toLowerCase().replace(/:/g, "");

    try {
      const advertisement = await this.homey.ble.find(uuid);
      const peripheral = await advertisement.connect();
      this.log(`Connected to device: ${uuid}`);

      // Enable notifications by writing specific data if not already enabled
      const serviceUuid = "0000fe9500001000800000805f9b34fb";
      const characteristicUuid = "0000001000001000800000805f9b34fb";
      const enableNotificationsData = Buffer.from([0x01, 0x00]);

      const service = await peripheral.getService(serviceUuid);
      this.log(`Obtained service: ${serviceUuid}`);
      const characteristic = await service.getCharacteristic(characteristicUuid);
      this.log(`Obtained characteristic: ${characteristicUuid}`);

      // Check if notifications are already enabled
      const currentValue = await characteristic.read();
      this.log(`Current value of characteristic: ${currentValue.toString("hex")}`);

      if (!currentValue.slice(0, enableNotificationsData.length).equals(enableNotificationsData)) {
        this.log("Notifications not enabled, writing enableNotificationsData...");
        await characteristic.write(enableNotificationsData);
        this.log("Enabled notifications for temperature and humidity");
      } else {
        this.log("Notifications for temperature and humidity are already enabled");
      }

      // Logging RSSI and checking signal strength
      const rssi = advertisement.rssi;
      this.log(`Device RSSI: ${rssi} dBm`);

      const rssiPercentage = Math.round(Math.max(0, Math.min(100, ((rssi + 100) / 60) * 100)));
      //workaround even this shall be solved by oninit
      if (!this.hasCapability("measure_rssi")) await this.addCapability("measure_rssi");
      this.log(`Device RSSI Percentage: ${rssiPercentage}%`);

      // Set the RSSI capability value
      this.setCapabilityValue("measure_rssi", rssi);

      if (rssi < -80) {
        this.setWarning(`RSSI (signal strength) is too low (${rssi} dBm) / ~ ${rssiPercentage}%`);
        setTimeout(() => this.setWarning(null), 15000);
      }

      // Read firmware version
      const deviceInformationServiceUuid = "0000180a00001000800000805f9b34fb";
      const firmwareCharacteristicUuid = "00002a2600001000800000805f9b34fb";
      const deviceInfoService = await peripheral.getService(deviceInformationServiceUuid);
      const firmwareCharacteristic = await deviceInfoService.getCharacteristic(firmwareCharacteristicUuid);
      const firmwareData = await firmwareCharacteristic.read();
      this.log(`Firmware version: ${firmwareData.toString("utf-8")}`);

      // No need to disconnect if we would like to read the data
      // await peripheral.disconnect();
      // this.log(`Disconnected from device: ${uuid}`);
    } catch (error) {
      this.log(`Failed to enable notifications: ${error}`);
      setTimeout(() => this.setWarning(null), 95000, await this.setWarning(`${error}`));
    }
  }

  /**
   * Subscribe to BLE notifications and read battery level
   */
  async subscribeToBLENotifications() {
    this.log("Starting BLE subscription");
    const deviceData = this.getData();
    const uuid = deviceData.id.toLowerCase().replace(/:/g, "");
    let lastTempHumidityData = null;
    this.setWarning(null);

    try {
      const advertisement = await this.homey.ble.find(uuid);
      const peripheral = await advertisement.connect();
      this.log(`Connected to device: ${uuid}`);

      // Logging RSSI and checking signal strength
      const rssi = advertisement.rssi;
      this.log(`Device RSSI: ${rssi} dBm`);

      //workaround even this shall be solved by oninit
      if (!this.hasCapability("measure_rssi")) await this.addCapability("measure_rssi");
      
      // Set the RSSI capability value
      this.setCapabilityValue("measure_rssi", rssi);

      const rssiPercentage = Math.round(Math.max(0, Math.min(100, ((rssi + 100) / 60) * 100)));
      this.log(`Device RSSI Percentage: ${rssiPercentage}%`);

      if (rssi < -80) {
        this.setWarning(`RSSI (signal strength) is too low (${rssi} dBm) / ~ ${rssiPercentage}%`);
        setTimeout(() => this.setWarning(null), 15000);
      }

      const temperatureHumidityServiceUuid = "226c000064764566756266734470666d";
      const temperatureHumidityCharacteristicUuid = "226caa5564764566756266734470666d";

      const tempHumService = await peripheral.getService(temperatureHumidityServiceUuid);
      const tempHumCharacteristic = await tempHumService.getCharacteristic(temperatureHumidityCharacteristicUuid);

      await tempHumCharacteristic.subscribeToNotifications((data) => {
        const dataString = data.toString("hex");
        if (lastTempHumidityData !== dataString) {
          this.log("Received new notification temp/humidity: ", data);
          this.updateTag(data);
          lastTempHumidityData = dataString;
        } else {
          //  this.log("Duplicate notification received, ignoring.");
        }
      });
      // Read battery level
      const batteryServiceUuid = "0000180f00001000800000805f9b34fb";
      const batteryCharacteristicUuid = "00002a1900001000800000805f9b34fb";

      const batteryService = await peripheral.getService(batteryServiceUuid);
      const batteryCharacteristic = await batteryService.getCharacteristic(batteryCharacteristicUuid);
      const batteryData = await batteryCharacteristic.read();

      this.log(`Battery data buffer: ${batteryData.toString("hex")}`);

      const battery = batteryData.readUInt8(0);
      this.log(`Battery level: ${battery}%`);
      if (battery >= 0 && battery <= 100) {
        this.setCapabilityValue("measure_battery", battery);
      }

      peripheral.once("disconnect", async () => {
        this.log(`Disconnected from device: ${uuid}, will reconnect in ${this.reconnectInterval} seconds`);
        //      await this.delay(this.reconnectInterval);
        //        await this.subscribeToBLENotifications();
      });

      this.peripheral = peripheral; // Save the peripheral to unsubscribe later

      this.log(`Subscribed to notifications for device: ${uuid}`);
      this.setWarning(null);
    } catch (error) {
      this.log(`Failed to subscribe to notifications: ${error}`);
      setTimeout(() => this.setWarning(null), 65000, await this.setWarning(`${error}`));
      // await this.delay(this.reconnectInterval);
      // await this.subscribeToBLENotifications();
    }
  }

  /**
   * Stop BLE subscription
   */
  async stopBLESubscription() {
    try {
      if (this.peripheral) {
        await this.unsubscribeFromBLENotifications(this.peripheral);
      }
      this.log("Stopped BLE subscription");
    } catch (error) {
      this.log("Error during unsubscribe:", error);
    }
  }

  /**
   * Unsubscribe from BLE notifications
   */
  async unsubscribeFromBLENotifications(peripheral) {
    try {
      const temperatureHumidityServiceUuid = "226c000064764566756266734470666d";
      const temperatureHumidityCharacteristicUuid = "226caa5564764566756266734470666d";

      const tempHumService = await peripheral.getService(temperatureHumidityServiceUuid);
      const tempHumCharacteristic = await tempHumService.getCharacteristic(temperatureHumidityCharacteristicUuid);
      await tempHumCharacteristic.unsubscribeFromNotifications();

      await peripheral.disconnect();
      this.log(`Unsubscribed from notifications and disconnected from device: ${peripheral.id}`);
    } catch (error) {
      this.log(`Failed to unsubscribe from notifications: ${error}`);
    }
  }

  /**
   * Update tag with received data from BLE notifications
   */
  async updateTag(data) {
    this.log(`Updating measurements for ${this.getName()}`);

    const dataString = data.toString("ascii").trim();
    const match = dataString.match(/T=([\d.]+)\s+H=([\d.]+)/);

    this.setWarning(null);

    if (match) {
      const temperature = parseFloat(match[1]) + this.temperatureOffset;
      const humidity = parseFloat(match[2]);

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
    } else {
      this.log(`Unexpected data format: ${dataString}`);
      /* setTimeout(() => this.setWarning(null), 55000, await this.setWarning(`${error}`)); 
      row above caused "ReferenceError: error is not defined"
      */
      setTimeout(() => this.setWarning(null), 55000, await this.setWarning(`Unexpected data format`));
    }
  }

  /**
   * Poll device periodically
   */
  pollDevice() {
    this.pollingInterval = setInterval(() => this.emit("poll"), this.reconnectInterval * 1000); // Poll every 60 seconds
  }
}

module.exports = MyDevice;
