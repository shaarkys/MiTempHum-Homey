"use strict";

const { Device } = require("homey");
const ADVERTISEMENT_RATE_LIMIT_MS = 5000;
const MIN_CONNECTABLE_RSSI = -85;
const GATT_SETUP_TIMEOUT_MS = 30000;

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
    this.advertisementSubscriptionActive = false;
    this.subscriptionOperation = null;
    this.gattAttemptId = 0;
    this.gattAttemptCancellation = null;
    this.gattSetupTimeout = null;
    this.notificationCharacteristic = null;
    this.peripheral = null;
    this.disconnectTimeout = null;
    this.lastAdvertisementMeasurementAt = null;
    this.shuttingDown = false;
    this.log(`Reconnect interval is set to ${this.reconnectInterval} seconds.`);

    await this.startAdvertisementSubscription();
    if (!this.advertisementSubscriptionActive) {
      await this.subscribeToBLENotifications();
    }
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

    let measurementData = null;
    const serviceData = Array.isArray(advertisement.serviceData) ? advertisement.serviceData : [];
    for (const entry of serviceData) {
      if (!entry || !entry.data) {
        continue;
      }

      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "hex");
      if (data.length === 5) {
        measurementData = data;
        this.lastAdvertisementMeasurementAt = Date.now();
        // Invalidate in-flight GATT work before any capability write can yield.
        this.cancelGattSetup("fresh passive advertisement received");
        break;
      }
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

    if (measurementData) {
      await this.cleanupBLEConnection();
      await this.updateTag(measurementData, { disconnectAfter: false });
    }
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
    await this.shutdownBLE();
  }

  async onUninit() {
    await this.shutdownBLE();
  }

  async shutdownBLE() {
    this.shuttingDown = true;
    const subscriptionOperation = this.subscriptionOperation;
    if (this.pollingInterval) {
      this.homey.clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    await this.stopAdvertisementSubscription();
    await this.stopBLESubscription();
    if (subscriptionOperation) {
      await subscriptionOperation.catch((error) => {
        this.log(`BLE setup operation ended during shutdown: ${error.message || error}`);
      });
    }
  }

  /**
   * Subscribe to BLE notifications
   */
  async subscribeToBLENotifications() {
    if (this.shuttingDown || this.hasRecentAdvertisementMeasurement()) {
      return;
    }

    if (this.subscriptionOperation) {
      return this.subscriptionOperation;
    }

    if (this.peripheral || this.notificationCharacteristic) {
      this.log("BLE GATT fallback is already established; waiting for its owned disconnect timer.");
      return;
    }

    const attemptId = ++this.gattAttemptId;
    const operation = this.runGattSetup(attemptId);
    this.subscriptionOperation = operation;
    try {
      await operation;
    } finally {
      if (this.subscriptionOperation === operation) {
        this.subscriptionOperation = null;
      }
    }
  }

  async runGattSetup(attemptId) {
    let cancelAttempt;
    const cancellationPromise = new Promise((_, reject) => {
      cancelAttempt = (reason) => {
        const error = new Error(reason);
        error.code = "BLE_GATT_SETUP_CANCELLED";
        reject(error);
      };
    });
    this.gattAttemptCancellation = { attemptId, cancel: cancelAttempt };

    let setupTimeout;
    const timeoutPromise = new Promise((_, reject) => {
      setupTimeout = this.homey.setTimeout(() => {
        if (this.gattAttemptId !== attemptId) {
          return;
        }
        this.gattAttemptId += 1;
        const error = new Error(`BLE GATT setup timed out after ${GATT_SETUP_TIMEOUT_MS / 1000} seconds`);
        error.code = "BLE_GATT_SETUP_TIMEOUT";
        reject(error);
      }, GATT_SETUP_TIMEOUT_MS);
    });
    this.gattSetupTimeout = setupTimeout;

    try {
      await Promise.race([
        this.establishGattSubscription(attemptId),
        cancellationPromise,
        timeoutPromise,
      ]);
    } catch (error) {
      if (error.code === "BLE_GATT_SETUP_CANCELLED") {
        this.log(`BLE GATT setup cancelled: ${error.message}`);
      } else {
        this.log(`Failed to subscribe to notifications: ${error.message || error}`);
        await this.setWarning(`${error}`).catch((warningError) => {
          this.error("Error setting warning after subscription failure:", warningError);
        });
      }
      await this.cleanupBLEConnection();
    } finally {
      if (this.gattSetupTimeout === setupTimeout) {
        this.homey.clearTimeout(setupTimeout);
        this.gattSetupTimeout = null;
      }
      if (this.gattAttemptCancellation && this.gattAttemptCancellation.attemptId === attemptId) {
        this.gattAttemptCancellation = null;
      }
    }
  }

  async establishGattSubscription(attemptId) {
    this.log("Starting BLE for non ATC subscription");
    const uuid = this.getPeripheralUuid();
    let lastTempHumidityData = null;

    await this.setWarning(null).catch((error) => this.error("Error clearing warning before subscription:", error));
    this.assertGattAttemptActive(attemptId);

    const advertisement = await this.homey.ble.find(uuid);
    this.assertGattAttemptActive(attemptId);
    const skipActiveConnection = await this.shouldSkipActiveConnection(advertisement);
    this.assertGattAttemptActive(attemptId);
    if (skipActiveConnection) {
      return;
    }

    const peripheral = await advertisement.connect();
    if (!this.isGattAttemptActive(attemptId)) {
      await peripheral.disconnect().catch((error) => {
        this.log(`Failed to disconnect late BLE peripheral: ${error.message || error}`);
      });
      this.assertGattAttemptActive(attemptId);
    }

    this.peripheral = peripheral;
    peripheral.once("disconnect", () => {
      if (this.peripheral === peripheral) {
        this.peripheral = null;
        this.notificationCharacteristic = null;
        if (this.disconnectTimeout) {
          this.homey.clearTimeout(this.disconnectTimeout);
          this.disconnectTimeout = null;
        }
        this.log(`Disconnected from device: ${uuid}`);
      }
    });
    this.log(`Connected to device: ${uuid}`);

    const rssi = advertisement.rssi;
    this.log(`Device RSSI: ${rssi} dBm`);
    if (!this.hasCapability("measure_rssi")) {
      await this.addCapability("measure_rssi");
      this.assertGattAttemptActive(attemptId);
    }
    await this.setCapabilityValue("measure_rssi", rssi).catch((error) => {
      this.error("Error setting 'measure_rssi':", error);
    });
    this.assertGattAttemptActive(attemptId);

    const rssiPercentage = Math.round(Math.max(0, Math.min(100, ((rssi + 100) / 60) * 100)));
    this.log(`Device RSSI Percentage: ${rssiPercentage}%`);
    if (rssi < -80) {
      await this.setWarning(`RSSI (signal strength) is too low (${rssi} dBm) / ~ ${rssiPercentage}%`);
      this.assertGattAttemptActive(attemptId);
    }

    const temperatureHumidityServiceUuid = "ebe0ccb07a0a4b0c8a1a6ff2997da3a6";
    const temperatureHumidityCharacteristicUuid = "ebe0ccc17a0a4b0c8a1a6ff2997da3a6";
    const tempHumService = await peripheral.getService(temperatureHumidityServiceUuid);
    this.assertGattAttemptActive(attemptId);
    this.log(`Obtained service: ${temperatureHumidityServiceUuid}`);

    const tempHumCharacteristic = await tempHumService.getCharacteristic(temperatureHumidityCharacteristicUuid);
    this.assertGattAttemptActive(attemptId);
    this.log(`Obtained characteristic: ${temperatureHumidityCharacteristicUuid}`);
    this.notificationCharacteristic = tempHumCharacteristic;

    await tempHumCharacteristic.subscribeToNotifications((data) => {
      if (this.peripheral !== peripheral) {
        return;
      }
      const dataString = data.toString("hex");
      if (lastTempHumidityData !== dataString) {
        this.log("Received new notification temp/humidity: ", data);
        this.updateTag(data).catch((error) => this.error("Error updating tag:", error));
        lastTempHumidityData = dataString;
      }
    });
    this.assertGattAttemptActive(attemptId);

    this.log(`Subscribed to notifications for device: ${uuid}`);
    await this.setWarning(null).catch((error) => this.error("Error clearing warning after subscription:", error));
    this.assertGattAttemptActive(attemptId);

    this.log(`Disconnect timeout set for ${this.reconnectInterval} seconds.`);
    this.disconnectTimeout = this.homey.setTimeout(async () => {
      if (this.peripheral !== peripheral) {
        return;
      }
      this.log("Disconnect timeout reached. Initiating disconnect...");
      await this.stopBLESubscription();
    }, this.reconnectInterval * 1000);
  }

  isGattAttemptActive(attemptId) {
    return Boolean(
      !this.shuttingDown
      && this.gattAttemptId === attemptId
      && !this.hasRecentAdvertisementMeasurement(),
    );
  }

  assertGattAttemptActive(attemptId) {
    if (this.isGattAttemptActive(attemptId)) {
      return;
    }

    const error = new Error("BLE GATT setup is no longer current");
    error.code = "BLE_GATT_SETUP_CANCELLED";
    throw error;
  }

  cancelGattSetup(reason) {
    const cancellation = this.gattAttemptCancellation;
    if (!cancellation) {
      return;
    }

    if (this.gattAttemptId === cancellation.attemptId) {
      this.gattAttemptId += 1;
    }
    this.gattAttemptCancellation = null;
    cancellation.cancel(reason);
  }

  hasRecentAdvertisementMeasurement() {
    return Boolean(
      this.advertisementSubscriptionActive
      && this.lastAdvertisementMeasurementAt
      && Date.now() - this.lastAdvertisementMeasurementAt < this.reconnectInterval * 1000,
    );
  }

  /**
   * Stop BLE subscription
   */
  async stopBLESubscription() {
    this.cancelGattSetup("BLE subscription stopped");
    await this.cleanupBLEConnection();
    this.log("Stopped BLE subscription");
  }

  async cleanupBLEConnection() {
    if (this.disconnectTimeout) {
      this.homey.clearTimeout(this.disconnectTimeout);
      this.disconnectTimeout = null;
    }

    const characteristic = this.notificationCharacteristic;
    const peripheral = this.peripheral;
    this.notificationCharacteristic = null;
    this.peripheral = null;

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
        this.log(`Failed to disconnect: ${error.message || error}`);
      }
    }

  }

  /**
   * Update device with received data from BLE notifications
   */
  async updateTag(data, { disconnectAfter = true } = {}) {
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
    if (disconnectAfter) {
      await this.stopBLESubscription();
    }
  }

  /**
   * Poll device periodically
   */
  pollDevice() {
    if (this.pollingInterval) {
      this.homey.clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.shuttingDown) {
      return;
    }
    this.pollingInterval = this.homey.setInterval(() => {
      this.log("Polling device...");
      this.subscribeToBLENotifications().catch((error) => {
        this.error("Unexpected BLE polling error:", error);
      });
    }, this.reconnectInterval * 1000);
  }
}

module.exports = XiaomiThermometerDevice;
