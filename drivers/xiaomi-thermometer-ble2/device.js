"use strict";

const { Device } = require("homey");
const ADVERTISEMENT_RATE_LIMIT_MS = 5000;
const MIN_CONNECTABLE_RSSI = -85;
const DEFAULT_RECONNECT_INTERVAL_SECONDS = 5 * 60;

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
    return new Promise((resolve) => this.homey.setTimeout(resolve, 1000 * s));
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log("LYWSDCGQ/01ZM BLE device has been initialized - ", this.getData());
    // Reset all values
    try {
      await this.setCapabilityValue("measure_temperature", null);
    } catch (err) {
      this.error("Error setting 'measure_temperature':", err);
    }
    try {
      await this.setCapabilityValue("measure_humidity", null);
    } catch (err) {
      this.error("Error setting 'measure_humidity':", err);
    }
    try {
      await this.setCapabilityValue("measure_battery", null);
    } catch (err) {
      this.error("Error setting 'measure_battery':", err);
    }

    if (!this.hasCapability("measure_rssi")) {
      try {
        await this.addCapability("measure_rssi");
      } catch (err) {
        this.error("Error adding 'measure_rssi' capability:", err);
      }
    }

    try {
      await this.setCapabilityValue("measure_rssi", null);
    } catch (err) {
      this.error("Error setting 'measure_rssi':", err);
    }

    // Get the initial temperature offset setting
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;

    // Get the reconnect interval setting, default to 5 minutes
    this.reconnectInterval = this.getSetting("reconnect_interval") || DEFAULT_RECONNECT_INTERVAL_SECONDS;
    this.advertisementSubscriptionActive = false;
    this.peripheral = null;
    this.notificationCharacteristic = null;
    this.connectionOperation = null;
    this.reconnectTimeout = null;
    this.notificationWatchdogTimeout = null;
    this.lastNotificationAt = null;
    this.lastTempHumidityData = null;
    this.shuttingDown = false;

    await this.startAdvertisementSubscription();
    await this.ensureBLESubscription({ reason: "device initialization" });

    // Periodically verify that the GATT notification stream is still alive.
    this.pollDevice();
  }

  getPeripheralUuid() {
    const store = typeof this.getStore === "function" ? this.getStore() : {};
    const storePeripheralUuid = store && typeof store.peripheralUuid === "string" ? store.peripheralUuid : "";
    if (storePeripheralUuid) {
      return storePeripheralUuid.toLowerCase().replace(/:/g, "");
    }

    const data = this.getData() || {};
    const legacyId = typeof data.id === "string" ? data.id : "";
    return legacyId.toLowerCase().replace(/:/g, "");
  }

  advertisementMatchesTarget(advertisement) {
    const store = typeof this.getStore === "function" ? this.getStore() : {};
    const data = this.getData() || {};
    const targetAddress = (store.address || data.id || "").toLowerCase();
    const targetUuid = this.getPeripheralUuid();
    const advertisementAddress = (advertisement && advertisement.address || "").toLowerCase();
    const advertisementUuid = (advertisement && advertisement.uuid || "").toLowerCase().replace(/:/g, "");

    return Boolean(
      (targetAddress && advertisementAddress === targetAddress)
      || (targetUuid && advertisementUuid === targetUuid),
    );
  }

  supportsAdvertisementSubscriptions() {
    return Boolean(
      typeof this.homey.hasFeature === "function"
      && this.homey.hasFeature("ble-advertisements")
      && this.homey.ble
      && typeof this.homey.ble.subscribeToAdvertisements === "function"
      && typeof this.homey.ble.unsubscribeFromAdvertisements === "function",
    );
  }

  async startAdvertisementSubscription() {
    if (!this.supportsAdvertisementSubscriptions()) {
      this.log("BLE advertisement subscriptions are not available; using find/GATT fallback.");
      return;
    }

    const peripheralUuid = this.getPeripheralUuid();
    if (!peripheralUuid) {
      this.log("Missing peripheral UUID; using find/GATT fallback.");
      return;
    }

    try {
      await this.homey.ble.subscribeToAdvertisements(
        peripheralUuid,
        { rateLimitMs: ADVERTISEMENT_RATE_LIMIT_MS },
        (advertisement) => {
          this.processAdvertisementUpdate(advertisement).catch((error) => {
            this.error("Error processing advertisement:", error);
          });
        },
      );
      this.advertisementSubscriptionActive = true;
      this.log(`Subscribed to BLE advertisements for ${peripheralUuid}`);
    } catch (error) {
      this.advertisementSubscriptionActive = false;
      this.log(`Could not subscribe to BLE advertisements, using find/GATT fallback: ${error.message || error}`);
    }
  }

  async stopAdvertisementSubscription() {
    if (!this.advertisementSubscriptionActive || !this.supportsAdvertisementSubscriptions()) {
      return;
    }

    const peripheralUuid = this.getPeripheralUuid();
    if (!peripheralUuid) {
      return;
    }

    try {
      await this.homey.ble.unsubscribeFromAdvertisements(peripheralUuid);
      this.log(`Unsubscribed from BLE advertisements for ${peripheralUuid}`);
    } catch (error) {
      this.log(`Failed to unsubscribe from BLE advertisements: ${error.message || error}`);
    } finally {
      this.advertisementSubscriptionActive = false;
    }
  }

  async processAdvertisementUpdate(advertisement) {
    if (!advertisement || !this.advertisementMatchesTarget(advertisement)) {
      return;
    }

    if (typeof advertisement.rssi === "number") {
      await this.setCapabilityValue("measure_rssi", advertisement.rssi).catch((error) => {
        this.error("Error setting 'measure_rssi' from advertisement:", error);
      });
      if (advertisement.rssi <= MIN_CONNECTABLE_RSSI) {
        await this.setWarning(`RSSI too weak for active BLE connection (${advertisement.rssi} dBm); using advertisements only.`);
      } else {
        await this.setWarning(null).catch((error) => this.error("Error clearing RSSI warning:", error));
      }
    }

    const serviceData = Array.isArray(advertisement.serviceData) ? advertisement.serviceData : [];
    serviceData.forEach((entry) => {
      if (!entry || !entry.data) {
        return;
      }

      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "hex");
      const dataString = data.toString("ascii").trim();
      if (dataString.includes("T=") && dataString.includes("H=")) {
        this.updateTag(data).catch((error) => this.error("Error updating from advertisement:", error));
      }
    });
  }

  async shouldSkipActiveConnection(advertisement) {
    if (!advertisement || typeof advertisement.rssi !== "number" || advertisement.rssi > MIN_CONNECTABLE_RSSI) {
      return false;
    }

    await this.processAdvertisementUpdate(advertisement);
    this.log(`Skipping active BLE connection because RSSI is ${advertisement.rssi} dBm (threshold: ${MIN_CONNECTABLE_RSSI} dBm).`);
    return true;
  }

  /**
   * onAdded is called when the user adds the device.
   */
  async onAdded() {
    this.log("LYWSDCGQ/01ZM BLE has been added");
  }

  /**
   * onSettings is called when the user updates the device's settings.
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log("LYWSDCGQ/01ZM BLE settings were changed");

    if (changedKeys.includes("temperature_offset")) {
      this.temperatureOffset = newSettings.temperature_offset;
      this.log(`Device ${this.getName()} temperature offset: ${this.temperatureOffset}°C`);
    }

    if (changedKeys.includes("reconnect_interval")) {
      this.reconnectInterval = newSettings.reconnect_interval || DEFAULT_RECONNECT_INTERVAL_SECONDS;
      this.log(`Device ${this.getName()} reconnect interval: ${this.reconnectInterval} seconds`);
      this.clearReconnectTimeout();
      this.pollDevice();
      await this.applyReconnectIntervalChange();
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   */
  async onRenamed(name) {
    this.log("LYWSDCGQ/01ZM BLE was renamed");
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    this.log("LYWSDCGQ/01ZM BLE has been deleted");
    await this.shutdownBLE();
  }

  async onUninit() {
    await this.shutdownBLE();
  }

  async shutdownBLE() {
    this.shuttingDown = true;
    this.clearReconnectTimeout();
    this.clearNotificationWatchdog();
    if (this.pollingInterval) {
      this.homey.clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    await this.stopAdvertisementSubscription();
    await this.stopBLESubscription();
  }

  /**
   * Enable the sensor's temperature/humidity notification mode on an existing connection.
   */
  async enableNotifications(peripheral) {
    this.log("Enabling notifications for temperature, humidity, and battery");

    const serviceUuid = "0000fe9500001000800000805f9b34fb";
    const characteristicUuid = "0000001000001000800000805f9b34fb";
    const enableNotificationsData = Buffer.from([0x01, 0x00]);

    const service = await peripheral.getService(serviceUuid);
    this.log(`Obtained service: ${serviceUuid}`);
    const characteristic = await service.getCharacteristic(characteristicUuid);
    this.log(`Obtained characteristic: ${characteristicUuid}`);

    const currentValue = await characteristic.read();
    this.log(`Current value of characteristic: ${currentValue.toString("hex")}`);

    if (!currentValue.slice(0, enableNotificationsData.length).equals(enableNotificationsData)) {
      this.log("Notifications not enabled, writing enableNotificationsData...");
      await characteristic.write(enableNotificationsData);
      this.log("Enabled notifications for temperature and humidity");
    } else {
      this.log("Notifications for temperature and humidity are already enabled");
    }

  }

  async readFirmwareVersion(peripheral) {
    const deviceInformationServiceUuid = "0000180a00001000800000805f9b34fb";
    const firmwareCharacteristicUuid = "00002a2600001000800000805f9b34fb";
    const deviceInfoService = await peripheral.getService(deviceInformationServiceUuid);
    const firmwareCharacteristic = await deviceInfoService.getCharacteristic(firmwareCharacteristicUuid);
    const firmwareData = await firmwareCharacteristic.read();
    if (this.peripheral === peripheral) {
      this.log(`Firmware version: ${firmwareData.toString("utf-8")}`);
    }
  }

  async readBatteryLevel(peripheral) {
    const batteryServiceUuid = "0000180f00001000800000805f9b34fb";
    const batteryCharacteristicUuid = "00002a1900001000800000805f9b34fb";
    const batteryService = await peripheral.getService(batteryServiceUuid);
    const batteryCharacteristic = await batteryService.getCharacteristic(batteryCharacteristicUuid);
    const batteryData = await batteryCharacteristic.read();
    const battery = batteryData.readUInt8(0);
    if (this.peripheral !== peripheral) {
      return;
    }

    this.log(`Battery level: ${battery}%`);
    if (battery >= 0 && battery <= 100) {
      await this.setCapabilityValue("measure_battery", battery);
    }
  }

  /**
   * Ensure exactly one healthy BLE notification subscription exists.
   */
  async ensureBLESubscription({ force = false, reason = "BLE health check" } = {}) {
    if (this.shuttingDown) {
      return;
    }

    if (this.connectionOperation) {
      return this.connectionOperation;
    }

    const operation = this.refreshBLESubscription({ force, reason });
    this.connectionOperation = operation;
    try {
      await operation;
    } finally {
      if (this.connectionOperation === operation) {
        this.connectionOperation = null;
      }
    }
  }

  isBLESubscriptionHealthy() {
    if (!this.peripheral || !this.notificationCharacteristic || !this.lastNotificationAt) {
      return false;
    }

    if (this.peripheral.isConnected === false) {
      return false;
    }

    return Date.now() - this.lastNotificationAt < this.reconnectInterval * 1000;
  }

  async refreshBLESubscription({ force, reason }) {
    if (!force && this.isBLESubscriptionHealthy()) {
      return;
    }

    if (this.peripheral || this.notificationCharacteristic) {
      this.log(`Resetting BLE notification subscription: ${reason}`);
      await this.cleanupBLEConnection();
    }

    const peripheralUuid = this.getPeripheralUuid();
    if (!peripheralUuid) {
      this.log("Cannot start BLE notification subscription without a peripheral UUID.");
      return;
    }

    try {
      await this.setWarning(null).catch((error) => this.error("Error clearing warning before subscription:", error));
      const advertisement = await this.homey.ble.find(peripheralUuid);
      if (await this.shouldSkipActiveConnection(advertisement)) {
        this.scheduleReconnect("RSSI remains below the active connection threshold");
        return;
      }

      await this.processAdvertisementUpdate(advertisement);
      const peripheral = await advertisement.connect();
      if (this.shuttingDown) {
        await peripheral.disconnect().catch((error) => this.log(`Failed to disconnect during shutdown: ${error}`));
        return;
      }

      this.peripheral = peripheral;
      peripheral.once("disconnect", () => this.handlePeripheralDisconnect(peripheral));
      this.log(`Connected to device: ${peripheralUuid}`);

      await this.enableNotifications(peripheral);
      if (this.peripheral !== peripheral) {
        throw new Error("BLE peripheral disconnected while enabling notifications");
      }

      const temperatureHumidityServiceUuid = "226c000064764566756266734470666d";
      const temperatureHumidityCharacteristicUuid = "226caa5564764566756266734470666d";
      const tempHumService = await peripheral.getService(temperatureHumidityServiceUuid);
      const tempHumCharacteristic = await tempHumService.getCharacteristic(temperatureHumidityCharacteristicUuid);
      this.notificationCharacteristic = tempHumCharacteristic;

      await tempHumCharacteristic.subscribeToNotifications((data) => {
        if (this.peripheral !== peripheral) {
          return;
        }

        this.lastNotificationAt = Date.now();
        this.armNotificationWatchdog(peripheral);
        const dataString = data.toString("hex");
        if (this.lastTempHumidityData !== dataString) {
          this.log("Received new notification temp/humidity: ", data);
          this.updateTag(data).catch((error) => this.error("Error updating tag:", error));
          this.lastTempHumidityData = dataString;
        }
      });

      if (this.peripheral !== peripheral) {
        throw new Error("BLE peripheral disconnected while subscribing to notifications");
      }

      // Start the liveness window when subscribing; every notification refreshes it.
      this.lastNotificationAt = Date.now();
      this.lastTempHumidityData = null;
      this.armNotificationWatchdog(peripheral);

      this.clearReconnectTimeout();
      this.log(`Subscribed to notifications for device: ${peripheralUuid}`);
      await this.setWarning(null).catch((error) => this.error("Error clearing warning after subscription:", error));
      this.readFirmwareVersion(peripheral).catch((error) => {
        this.log(`Unable to read BLE firmware version: ${error.message || error}`);
      });
      this.readBatteryLevel(peripheral).catch((error) => {
        this.log(`Unable to read BLE battery level: ${error.message || error}`);
      });
    } catch (error) {
      this.log(`Failed to establish BLE notification subscription: ${error.message || error}`);
      await this.setWarning(`${error}`).catch((warningError) => {
        this.error("Error setting warning after BLE subscription failure:", warningError);
      });
      await this.cleanupBLEConnection();
      this.scheduleReconnect("previous subscription attempt failed");
    }
  }

  handlePeripheralDisconnect(peripheral) {
    if (this.peripheral !== peripheral) {
      return;
    }

    this.peripheral = null;
    this.notificationCharacteristic = null;
    this.lastNotificationAt = null;
    this.lastTempHumidityData = null;
    this.clearNotificationWatchdog();
    this.log(`Disconnected from device, will reconnect in ${this.reconnectInterval} seconds`);
    this.scheduleReconnect("peripheral disconnected");
  }

  scheduleReconnect(reason) {
    if (this.shuttingDown || this.reconnectTimeout) {
      return;
    }

    this.log(`Scheduling BLE reconnect in ${this.reconnectInterval} seconds: ${reason}`);
    this.reconnectTimeout = this.homey.setTimeout(() => {
      this.reconnectTimeout = null;
      this.ensureBLESubscription({ reason }).catch((error) => {
        this.error("Unexpected BLE reconnect error:", error);
      });
    }, this.reconnectInterval * 1000);
  }

  clearReconnectTimeout() {
    if (this.reconnectTimeout) {
      this.homey.clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  armNotificationWatchdog(peripheral, delayMs = this.reconnectInterval * 1000) {
    this.clearNotificationWatchdog();
    if (this.shuttingDown || this.peripheral !== peripheral) {
      return;
    }

    this.notificationWatchdogTimeout = this.homey.setTimeout(() => {
      this.notificationWatchdogTimeout = null;
      if (this.shuttingDown || this.peripheral !== peripheral) {
        return;
      }

      const notificationAgeMs = this.lastNotificationAt
        ? Date.now() - this.lastNotificationAt
        : this.reconnectInterval * 1000;
      const staleThresholdMs = this.reconnectInterval * 1000;
      if (notificationAgeMs < staleThresholdMs) {
        this.armNotificationWatchdog(peripheral, staleThresholdMs - notificationAgeMs);
        return;
      }

      this.ensureBLESubscription({
        force: true,
        reason: `no BLE notification received for ${Math.round(notificationAgeMs / 1000)} seconds`,
      }).catch((error) => {
        this.error("Unexpected BLE notification-watchdog error:", error);
      });
    }, delayMs);
  }

  clearNotificationWatchdog() {
    if (this.notificationWatchdogTimeout) {
      this.homey.clearTimeout(this.notificationWatchdogTimeout);
      this.notificationWatchdogTimeout = null;
    }
  }

  async applyReconnectIntervalChange() {
    this.clearNotificationWatchdog();
    if (this.peripheral && this.notificationCharacteristic && this.lastNotificationAt) {
      const staleThresholdMs = this.reconnectInterval * 1000;
      const notificationAgeMs = Date.now() - this.lastNotificationAt;
      if (notificationAgeMs >= staleThresholdMs) {
        await this.ensureBLESubscription({
          force: true,
          reason: `reconnect interval shortened below notification age (${Math.round(notificationAgeMs / 1000)} seconds)`,
        });
      } else {
        this.armNotificationWatchdog(this.peripheral, staleThresholdMs - notificationAgeMs);
      }
      return;
    }

    await this.ensureBLESubscription({
      force: Boolean(this.peripheral || this.notificationCharacteristic),
      reason: "reconnect interval changed while BLE subscription was missing",
    });
  }

  async checkBLESubscriptionHealth() {
    if (this.shuttingDown) {
      return;
    }

    if (this.peripheral && this.notificationCharacteristic) {
      if (!this.notificationWatchdogTimeout) {
        this.armNotificationWatchdog(this.peripheral);
      }
      return;
    }

    await this.ensureBLESubscription({
      force: Boolean(this.peripheral || this.notificationCharacteristic),
      reason: "BLE notification subscription is missing",
    });
  }

  /**
   * Stop BLE subscription
   */
  async stopBLESubscription() {
    this.clearReconnectTimeout();
    if (this.connectionOperation) {
      await this.connectionOperation.catch((error) => {
        this.log(`BLE connection operation failed during shutdown: ${error.message || error}`);
      });
    }
    await this.cleanupBLEConnection();
    this.log("Stopped BLE subscription");
  }

  /**
   * Release both the notification callback and its GATT connection.
   */
  async cleanupBLEConnection() {
    const characteristic = this.notificationCharacteristic;
    const peripheral = this.peripheral;

    // Clear ownership before disconnecting so the disconnect event cannot schedule a duplicate reconnect.
    this.clearNotificationWatchdog();
    this.notificationCharacteristic = null;
    this.peripheral = null;
    this.lastNotificationAt = null;
    this.lastTempHumidityData = null;

    if (characteristic) {
      try {
        await characteristic.unsubscribeFromNotifications();
        this.log("Unsubscribed from BLE notifications");
      } catch (error) {
        this.log(`Failed to unsubscribe from BLE notifications: ${error.message || error}`);
      }
    }

    if (peripheral) {
      try {
        await peripheral.disconnect();
        this.log(`Disconnected from device: ${peripheral.id}`);
      } catch (error) {
        this.log(`Failed to disconnect BLE peripheral: ${error.message || error}`);
      }
    }
  }

  /**
   * Update tag with received data from BLE notifications
   */
  async updateTag(data) {
    this.log(`Updating measurements for ${this.getName()}`);

    const dataString = data.toString("ascii").trim();
    const match = dataString.match(/T=([\d.]+)\s+H=([\d.]+)/);

    try {
      await this.setWarning(null);
    } catch (err) {
      this.error("Error clearing warning before updating measurements:", err);
    }

    if (match) {
      const temperature = parseFloat(match[1]) + this.temperatureOffset;
      const humidity = parseFloat(match[2]);

      this.log(`LYWSDCGQ temperature: ${temperature}°C, Humidity: ${humidity}%`);

      if (temperature !== undefined) {
        if (temperature < -20 || temperature > 50) {
          this.log(`Ignoring temperature reading: ${temperature}°C`);
        } else {
          try {
            await this.setCapabilityValue("measure_temperature", temperature);
          } catch (err) {
            this.error("Error setting 'measure_temperature' in updateTag:", err);
          }
        }
      }

      if (humidity !== undefined) {
        if (humidity < 10 || humidity > 99) {
          this.log(`Ignoring humidity reading: ${humidity}%`);
        } else {
          try {
            await this.setCapabilityValue("measure_humidity", humidity);
          } catch (err) {
            this.error("Error setting 'measure_humidity' in updateTag:", err);
          }
        }
      }
    } else {
      this.log(`Unexpected data format: ${dataString}`);
      try {
        await this.setWarning(`Unexpected data format`);
        setTimeout(async () => {
          try {
            await this.setWarning(null);
          } catch (innerErr) {
            this.error("Error clearing warning after unexpected data format:", innerErr);
          }
        }, 55000);
      } catch (err) {
        this.error("Error setting warning for unexpected data format:", err);
      }
    }
  }

  /**
   * Poll device periodically
   */
  pollDevice() {
    if (this.pollingInterval) {
      this.homey.clearInterval(this.pollingInterval);
    }
    this.pollingInterval = this.homey.setInterval(() => {
      this.checkBLESubscriptionHealth().catch((error) => {
        this.error("Unexpected BLE health-check error:", error);
      });
    }, this.reconnectInterval * 1000);
  }
}

module.exports = MyDevice;
