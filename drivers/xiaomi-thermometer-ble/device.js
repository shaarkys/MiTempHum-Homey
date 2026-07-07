"use strict";

const { Device } = require("homey");
const normalizeUuid = (uuid) => (uuid || "").toLowerCase().replace(/-/g, "");
const UUID_181A_LONG = "0000181a00001000800000805f9b34fb";
const UUID_181A_SHORT = "181a";
const isUuid181a = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_181A_SHORT || normalized === UUID_181A_LONG;
};

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
    this.log("Xiaomi BLE ATC device has been initialized");
    this.log(this.getData());
    this.addListener("updateTag", this.updateTag);

    // Get the initial temperature offset setting
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;
    this.advertisementSubscriptionActive = false;
    await this.startAdvertisementSubscription();
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

  supportsAdvertisementSubscriptions() {
    return Boolean(
      typeof this.homey.hasFeature === "function"
      && this.homey.hasFeature("ble-advertisements")
      && this.homey.ble
      && typeof this.homey.ble.subscribeToAdvertisements === "function"
      && typeof this.homey.ble.unsubscribeFromAdvertisements === "function",
    );
  }

  isUsingAdvertisementSubscription() {
    return this.advertisementSubscriptionActive === true;
  }

  async startAdvertisementSubscription() {
    if (!this.supportsAdvertisementSubscriptions()) {
      this.log("BLE advertisement subscriptions are not available; using discovery polling fallback.");
      return;
    }

    const peripheralUuid = this.getPeripheralUuid();
    if (!peripheralUuid) {
      this.log("Missing peripheral UUID; using discovery polling fallback.");
      return;
    }

    try {
      await this.homey.ble.subscribeToAdvertisements(
        peripheralUuid,
        { rateLimitMs: 5000 },
        (advertisement) => {
          this.updateTag(advertisement).catch((error) => this.error("Error processing advertisement:", error));
        },
      );
      this.advertisementSubscriptionActive = true;
      this.log(`Subscribed to BLE advertisements for ${peripheralUuid}`);
      if (this.driver && typeof this.driver.managePolling === "function") {
        this.driver.managePolling();
      }
    } catch (error) {
      this.advertisementSubscriptionActive = false;
      this.log(`Could not subscribe to BLE advertisements, using polling fallback: ${error.message || error}`);
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

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log("Xiaomi BLE ATC has been added");
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
    this.log("Xiaomi BLE ATC settings were changed");

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
    this.log("Xiaomi ATC BLE was renamed");
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log("Xiaomi ATC BLE has been deleted");
    await this.stopAdvertisementSubscription();
  }

  async onUninit() {
    await this.stopAdvertisementSubscription();
  }

  async updateTag(foundDevices) {
    try {
      this.log(`Updating measurements ${this.getName()}`);
      let mac = this.getData();

      // Add safeguard check if device is still available
      if (!this.getAvailable()) {
        this.log(`Device ${this.getName()} is no longer available.`);
        return;
      }

      const advertisements = Array.isArray(foundDevices) ? foundDevices : [foundDevices];
      advertisements.forEach((device) => {
        if (device.address === mac["id"]) {
          this.log("Match!", mac, device.address);
          //this.log("Service Data:", device.serviceData);
          const sdata = Array.isArray(device.serviceData) ? device.serviceData : [];
          this.log("sdata:", sdata);
          sdata.forEach((uuid) => {
            if (isUuid181a(uuid.uuid)) {
              const dattta = Buffer.from(uuid["data"], "hex");
              this.log(`Parsed Buffer from hex: ${dattta.toString("hex")}`);
              // incorrect for negative temps
              // const rawTemp = ((dattta[6] << 8) | dattta[7]) / 10;
              const rawTemp = dattta.readInt16BE(6) / 10;
              const temperature = rawTemp + (this.temperatureOffset || 0);
              const humidity = dattta[8];
              const battery = dattta[9];
              this.log(`${device.localName} - Temp: ${temperature}°C, Humidity: ${humidity}%, Battery: ${battery}%`);
              this.setCapabilityValue("measure_temperature", temperature).catch((error) => this.error("Error setting temperature:", error));
              this.setCapabilityValue("measure_humidity", humidity).catch((error) => this.error("Error setting humidity:", error));
              this.setCapabilityValue("measure_battery", battery).catch((error) => this.error("Error setting battery:", error));
            }
          });
        } else {
          //     this.log(`Device ${device.localName} does not match with current device ID.`);
        }
      });
    } catch (error) {
      this.error("Error in updateTag:", error);
    }
  }
}
function readTemperature(buffer) {
  const data = Buffer.from(uuid["data"], "hex");
  this.log(((data[6] << 8) | data[7]) / 10), "readtemperature";
  return ((data[6] << 8) | data[7]) / 10;
}
module.exports = MyDevice;
