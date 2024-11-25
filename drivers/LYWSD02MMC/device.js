"use strict";

const { Device } = require("homey");

class LYWSD02MMC_device extends Device {
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
    try {
      this.log("LYWSD02MMC BLE device has been initialized - ", this.getData());
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
      // not working / not required ?
      // await this.enableNotifications();
      await this.getfirmware();
      await this.subscribeToBLENotifications();

      // Set up polling
      this.addListener("poll", this.subscribeToBLENotifications.bind(this));
      this.pollDevice();
    } catch (error) {
      this.log(`Error during initialization: ${error}`);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    try {
      this.log("LYWSD02MMC BLE has been added");
    } catch (error) {
      this.log(`Error during device addition: ${error}`);
    }
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
    try {
      this.log("LYWSD02MMC BLE settings were changed");

      if (changedKeys.includes("temperature_offset")) {
        this.temperatureOffset = newSettings.temperature_offset;
        this.log(`Device ${this.getName()} temperature offset: ${this.temperatureOffset}°C`);
      }

      if (changedKeys.includes("reconnect_interval")) {
        this.reconnectInterval = newSettings.reconnect_interval || 5 * 60;
        this.log(`Device ${this.getName()} reconnect interval: ${this.reconnectInterval} seconds`);
        this.pollDevice();
      }
    } catch (error) {
      this.log(`Error during settings update: ${error}`);
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name) {
    try {
      this.log("LYWSD02MMC BLE was renamed");
    } catch (error) {
      this.log(`Error during renaming: ${error}`);
    }
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    try {
      this.log("LYWSD02MMC BLE has been deleted");
      await this.stopBLESubscription();
      this.polling = false;
      clearInterval(this.pollingInterval);
    } catch (error) {
      this.log(`Error during deletion: ${error}`);
    }
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
      const serviceUuid = "ebe0ccb07a0a4b0c8a1a6ff2997da3a6"; // Services UUID
      const characteristicUuid = "ebe0ccc17a0a4b0c8a1a6ff2997da3a6"; // Updated UUID from Python implementation
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

      const deviceInformationServiceUuid = "0000180a00001000800000805f9b34fb";
      const firmwareCharacteristicUuid = "00002a2600001000800000805f9b34fb";
      const deviceInfoService = await peripheral.getService(deviceInformationServiceUuid);
      const firmwareCharacteristic = await deviceInfoService.getCharacteristic(firmwareCharacteristicUuid);
      const firmwareData = await firmwareCharacteristic.read();
      this.log(`Firmware version: ${firmwareData.toString("utf-8")}`);

    } catch (error) {
      this.log(`Failed to enable notifications: ${error}`);
      setTimeout(() => this.setWarning(null), 95000, await this.setWarning(`${error}`));
    }
  }

  /**
   * Enable notifications for temperature, humidity, and battery
   */
  async getfirmware() {
    try {
      const deviceData = this.getData();
      const uuid = deviceData.id.toLowerCase().replace(/:/g, "");

      const advertisement = await this.homey.ble.find(uuid);
      const peripheral = await advertisement.connect();
      this.log(`Connected to device: ${uuid}`);
      const deviceInformationServiceUuid = "0000180a00001000800000805f9b34fb";
      const firmwareCharacteristicUuid = "00002a2600001000800000805f9b34fb";
      const deviceInfoService = await peripheral.getService(deviceInformationServiceUuid);
      const firmwareCharacteristic = await deviceInfoService.getCharacteristic(firmwareCharacteristicUuid);
      const firmwareData = await firmwareCharacteristic.read();
      this.log(`Firmware version: ${firmwareData.toString("utf-8")}`);
    } catch (error) {
      this.log(`Failed to get firmware version ${error}`);
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

      // Updated UUIDs based on Python implementation
      const temperatureHumidityServiceUuid = "ebe0ccb07a0a4b0c8a1a6ff2997da3a6"; // Services UUID
      const temperatureHumidityCharacteristicUuid = "ebe0ccc17a0a4b0c8a1a6ff2997da3a6"; // UUID_DATA

      const tempHumService = await peripheral.getService(temperatureHumidityServiceUuid);
      const tempHumCharacteristic = await tempHumService.getCharacteristic(temperatureHumidityCharacteristicUuid);

      await tempHumCharacteristic.subscribeToNotifications((data) => {
        try {
          const dataString = data.toString("hex");
          if (lastTempHumidityData !== dataString) {
            this.log("Received new notification temp/humidity: ", data);
            this.updateTag(data);
            lastTempHumidityData = dataString;
          } else {
            //  this.log("Duplicate notification received, ignoring.");
          }
        } catch (error) {
          this.log(`Error processing notification data: ${error}`);
        }
      });

      // Updated UUIDs for Battery based on Python implementation
      const batteryServiceUuid = "ebe0ccb07a0a4b0c8a1a6ff2997da3a6"; // Services UUID
      const batteryCharacteristicUuid = "ebe0ccc47a0a4b0c8a1a6ff2997da3a6"; // UUID_BATTERY

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
      });

      this.peripheral = peripheral; // Save the peripheral to unsubscribe later

      this.log(`Subscribed to notifications for device: ${uuid}`);
      this.setWarning(null);
    } catch (error) {
      this.log(`Failed to subscribe to notifications: ${error}`);
      setTimeout(() => this.setWarning(null), 65000, await this.setWarning(`${error}`));
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

    // Parse binary data: int16 for temperature, uint8 for humidity
    if (data.length < 3) {
      this.log(`Unexpected data length: ${data.length} bytes`);
      setTimeout(() => this.setWarning(null), 55000, await this.setWarning(`Unexpected data length`));
      return;
    }

    try {
      const temperatureRaw = data.readInt16LE(0); // Assuming Little Endian
      const humidity = data.readUInt8(2);

      const temperature = temperatureRaw / 100 + this.temperatureOffset;

      this.log(`LYWSDCGQ temperature: ${temperature}°C, Humidity: ${humidity}%`);

      this.setWarning(null);

      // Validate and set temperature
      if (temperature !== undefined) {
        if (temperature < -20 || temperature > 50) {
          this.log(`Ignoring temperature reading: ${temperature}°C`);
        } else {
          await this.setCapabilityValue("measure_temperature", temperature);
        }
      }

      // Validate and set humidity
      if (humidity !== undefined) {
        if (humidity < 10 || humidity > 99) {
          this.log(`Ignoring humidity reading: ${humidity}%`);
        } else {
          await this.setCapabilityValue("measure_humidity", humidity);
        }
      }
    } catch (error) {
      this.log(`Error parsing data: ${error}`);
      setTimeout(() => this.setWarning(null), 55000, await this.setWarning(`Error parsing data`));
    }
    // **Disconnect from the peripheral after processing the data**
    await this.stopBLESubscription();
  }

  /**
   * Poll device periodically
   */
  pollDevice() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.pollingInterval = setInterval(() => {
      try {
        this.log("Polling device...");
        this.subscribeToBLENotifications();
      } catch (error) {
        this.log(`Error during polling: ${error}`);
      }
    }, this.reconnectInterval * 1000);
  }
}

module.exports = LYWSD02MMC_device;
