"use strict";

const { Device } = require("homey");

class XiaomiThermometerDevice extends Device {
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
    this.log("Initializing Xiaomi LYWSD03MMC BLE device...");

    // Reset all capability values
    await this.setCapabilityValue("measure_temperature", null).catch(this.error);
    await this.setCapabilityValue("measure_humidity", null).catch(this.error);
    await this.setCapabilityValue("measure_battery", null).catch(this.error);

    // Ensure 'measure_rssi' capability exists
    if (!this.hasCapability("measure_rssi")) {
      await this.addCapability("measure_rssi");
    }
    await this.setCapabilityValue("measure_rssi", null).catch(this.error);

    // Get initial settings
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;
    this.reconnectInterval = this.getSetting("reconnect_interval") || 300; // Default to 5 minutes
    this.log(`Reconnect interval is set to ${this.reconnectInterval} seconds.`);

    // Subscribe to BLE notifications
    await this.subscribeToBLENotifications();

    // Set up polling
    this.addListener("poll", this.subscribeToBLENotifications.bind(this));
    this.pollDevice();
  }

  /**
   * onAdded is called when the user adds the device.
   */
  async onAdded() {
    this.log("Xiaomi LYWSD03MMC BLE (non ATC) has been added");
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log("Xiaomi LYWSD03MMC BLE (non ATC) settings were changed");

    if (changedKeys.includes("temperature_offset")) {
      this.temperatureOffset = newSettings.temperature_offset;
      this.log(`Device ${this.getName()} temperature offset: ${this.temperatureOffset}°C`);
    }

    if (changedKeys.includes("reconnect_interval")) {
      this.reconnectInterval = newSettings.reconnect_interval || 300;
      this.log(`Device ${this.getName()} reconnect interval: ${this.reconnectInterval} seconds`);
      this.pollDevice();
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log(`Device was renamed to ${name}`);
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    this.log("Xiaomi LYWSD03MMC BLE (non ATC) has been deleted");
    await this.stopBLESubscription();
    this.polling = false;
    clearInterval(this.pollingInterval);
  }

  /**
   * Subscribe to BLE notifications
   */
  async subscribeToBLENotifications() {
    this.log("Starting BLE for non ATC subscription");
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

      // Ensure 'measure_rssi' capability exists
      if (!this.hasCapability("measure_rssi")) {
        await this.addCapability("measure_rssi");
      }

      // Set the RSSI capability value
      await this.setCapabilityValue("measure_rssi", rssi).catch(this.error);

      const rssiPercentage = Math.round(Math.max(0, Math.min(100, ((rssi + 100) / 60) * 100)));
      this.log(`Device RSSI Percentage: ${rssiPercentage}%`);

      if (rssi < -80) {
        await this.setWarning(`RSSI (signal strength) is too low (${rssi} dBm) / ~ ${rssiPercentage}%`);
        setTimeout(() => this.setWarning(null), 15000);
      }

      // Use the correct UUIDs for the LYWSD03MMC device
      const temperatureHumidityServiceUuid = "ebe0ccb07a0a4b0c8a1a6ff2997da3a6";
      const temperatureHumidityCharacteristicUuid = "ebe0ccc17a0a4b0c8a1a6ff2997da3a6";

      const tempHumService = await peripheral.getService(temperatureHumidityServiceUuid);
      this.log(`Obtained service: ${temperatureHumidityServiceUuid}`);

      const tempHumCharacteristic = await tempHumService.getCharacteristic(temperatureHumidityCharacteristicUuid);
      this.log(`Obtained characteristic: ${temperatureHumidityCharacteristicUuid}`);

      // Subscribe to notifications with the callback
      await tempHumCharacteristic.subscribeToNotifications((data) => {
        const dataString = data.toString("hex");
        if (lastTempHumidityData !== dataString) {
          this.log("Received new notification temp/humidity: ", data);
          this.updateTag(data);
          lastTempHumidityData = dataString;
        } else {
          // Duplicate data received, ignoring.
        }
      });

      this.log(`Subscribed to notifications for device: ${uuid}`);
      this.setWarning(null);

      // **Set a timeout to disconnect after reconnectInterval seconds**
      this.log(`Disconnect timeout set for ${this.reconnectInterval} seconds.`);
      this.disconnectTimeout = setTimeout(async () => {
        this.log("Disconnect timeout reached. Initiating disconnect...");
        await this.stopBLESubscription();
      }, this.reconnectInterval * 1000);

      // Handle peripheral disconnect
      peripheral.once("disconnect", async () => {
        clearTimeout(this.disconnectTimeout);
        this.log(`Disconnected from device: ${uuid}`);
        // Optionally, you can delay reconnection
        // await this.delay(this.reconnectInterval);
        // await this.subscribeToBLENotifications();
      });

      this.peripheral = peripheral; // Save the peripheral to unsubscribe later
    } catch (error) {
      this.log(`Failed to subscribe to notifications: ${error}`);
      setTimeout(() => this.setWarning(null), 65000, await this.setWarning(`${error}`));
      // Optionally, you can delay reconnection
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
      await peripheral.disconnect();

      this.log(`Disconnected from device: ${peripheral.id}`);
    } catch (error) {
      this.log(`Failed to disconnect: ${error}`);
    }
  }

  /**
   * Update device with received data from BLE notifications
   */
  async updateTag(data) {
    this.log(`Updating measurements for ${this.getName()}`);

    const buffer = Buffer.from(data);

    // Parse temperature and humidity data
    // Adjust the parsing logic according to your device's data format
    const temperature = buffer.readInt16LE(0) / 100 + this.temperatureOffset;
    const humidity = buffer.readUInt8(2);
    const voltage = buffer.readUInt16LE(3) / 1000;

    const batteryPercentage = Math.round(((voltage - 2.1) / 0.9) * 100);

    this.setWarning(null);

    this.log(`Temperature: ${temperature}°C, Humidity: ${humidity}%, Voltage: ${voltage}V, Battery: ${batteryPercentage}%`);

    // Update capabilities if values are valid
    if (temperature > -20 && temperature < 50) {
      await this.setCapabilityValue("measure_temperature", temperature).catch(this.error);
    } else {
      this.log(`Ignoring temperature reading: ${temperature}°C`);
    }

    if (humidity >= 10 && humidity <= 99) {
      await this.setCapabilityValue("measure_humidity", humidity).catch(this.error);
    } else {
      this.log(`Ignoring humidity reading: ${humidity}%`);
    }

    if (batteryPercentage >= 0 && batteryPercentage <= 100) {
      await this.setCapabilityValue("measure_battery", batteryPercentage).catch(this.error);
    } else {
      this.log(`Ignoring battery reading: ${batteryPercentage}%`);
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
      this.log("Polling device...");
      this.subscribeToBLENotifications();
    }, this.reconnectInterval * 1000);
  }
}

module.exports = XiaomiThermometerDevice;
