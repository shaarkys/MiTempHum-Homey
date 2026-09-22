"use strict";

const { Device } = require("homey");
const { normalizeMac } = require("../../lib/mibeacon-advertisement");
const { parseMjwsd05mmcAdvertisement } = require("../../lib/mjwsd05mmc-advertisement");

class XiaomiMjwsd05mmcDevice extends Device {
  async onInit() {
    await this.stopAdvertisementUpdates();
    this.stopping = false;
    this.stopPromise = null;
    this.advertisementQueue = Promise.resolve();
    this.errors = new Map();
    this.warningState = undefined;
    this.firstMeasurement = false;
    this.bindkey = this.getBindkeyBuffer(this.getSetting("bindkey"));
    this.temperatureOffset = this.getTemperatureOffset(this.getSetting("temperature_offset"));
    await this.startAdvertisementUpdates();
    this.log("MJWSD05MMC initialized; waiting for BLE measurements");
  }

  getBindkeyBuffer(value) {
    const key = typeof value === "string" ? value.trim() : "";
    return /^[0-9a-f]{32}$/i.test(key) ? Buffer.from(key, "hex") : null;
  }

  getTemperatureOffset(value) {
    const offset = Number(value);
    return Number.isFinite(offset) && offset >= -5 && offset <= 5 ? offset : 0;
  }

  getPeripheralUuid() {
    return (this.getStore() || {}).peripheralUuid || (this.getData() || {}).id;
  }

  matchesAdvertisement(advertisement) {
    const address = normalizeMac((this.getStore() || {}).address);
    const uuid = String(this.getPeripheralUuid() || "").toLowerCase().replace(/:/g, "");
    return Boolean(advertisement && (
      (address && address === normalizeMac(advertisement.address))
      || (uuid && uuid === String(advertisement.uuid || "").toLowerCase().replace(/:/g, ""))
    ));
  }

  logFailure(operation, error) {
    const message = error.message || String(error);
    if (this.errors.get(operation) === message) return;
    this.errors.set(operation, message);
    this.error("MJWSD05MMC " + operation + " failed: " + message);
  }

  startAdvertisementUpdates() {
    if (this.stopping || this.subscribed || this.pollInterval != null) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startUpdates().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async startUpdates() {
    const ble = this.homey.ble;
    if (typeof this.homey.hasFeature === "function" && this.homey.hasFeature("ble-advertisements")
      && typeof ble.subscribeToAdvertisements === "function"
      && typeof ble.unsubscribeFromAdvertisements === "function") {
      try {
        await ble.subscribeToAdvertisements(
          this.getPeripheralUuid(),
          { rateLimitMs: 5000 },
          (advertisement) => this.queueAdvertisement(advertisement),
        );
        this.subscribed = true;
        this.errors.delete("subscription");
        this.log("Subscribed to MJWSD05MMC BLE advertisements");
        return;
      } catch (error) {
        this.logFailure("subscription", error);
      }
    }
    if (this.stopping) return;
    this.log("MJWSD05MMC using one-minute BLE discovery fallback");
    await this.pollAdvertisement();
    if (!this.stopping) {
      this.pollInterval = this.homey.setInterval(() => this.pollAdvertisement(), 60000);
    }
  }

  pollAdvertisement() {
    if (this.stopping) return Promise.resolve();
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.findAdvertisement().finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  async findAdvertisement() {
    try {
      const advertisement = await this.homey.ble.find(this.getPeripheralUuid());
      this.errors.delete("discovery");
      await this.queueAdvertisement(advertisement);
    } catch (error) {
      this.logFailure("discovery", error);
    }
  }

  queueAdvertisement(advertisement) {
    if (this.stopping) return Promise.resolve();
    this.advertisementQueue = this.advertisementQueue
      .then(() => this.processAdvertisement(advertisement))
      .catch((error) => this.logFailure("processing", error));
    return this.advertisementQueue;
  }

  async updateCapability(id, value) {
    if (this.stopping) return false;
    try {
      if (this.getCapabilityValue(id) !== value) await this.setCapabilityValue(id, value);
      this.errors.delete(id);
      return true;
    } catch (error) {
      this.logFailure(id, error);
      return false;
    }
  }

  async updateWarning(key) {
    if (this.stopping || this.warningState === key) return;
    try {
      await this.setWarning(key ? this.homey.__("mjwsd05mmc." + key) : null);
      this.warningState = key;
      this.errors.delete("warning");
    } catch (error) {
      this.logFailure("warning", error);
    }
  }

  async processAdvertisement(advertisement) {
    if (this.stopping || !this.matchesAdvertisement(advertisement)) return;
    // Some Bridge callbacks omit the address; retain the address captured at pairing for the nonce.
    const parsed = parseMjwsd05mmcAdvertisement({
      ...advertisement,
      address: advertisement.address || (this.getStore() || {}).address,
    }, this.bindkey);
    if (!parsed) return;
    if (Number.isFinite(advertisement.rssi)) {
      await this.updateCapability("measure_rssi", advertisement.rssi);
    }
    if (parsed.bindkeyRequired) {
      await this.updateWarning(parsed.unsupportedEncryption ? "unsupported_encryption"
        : parsed.decryptionFailed ? "decryption_failed" : "bindkey_required");
      return;
    }
    let updated = false;
    const { temperature, humidity, battery } = parsed.values;
    if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 60) {
      updated = await this.updateCapability("measure_temperature", temperature + this.temperatureOffset) || updated;
    }
    if (Number.isFinite(humidity) && humidity >= 0 && humidity <= 100) {
      updated = await this.updateCapability("measure_humidity", humidity) || updated;
    }
    if (Number.isInteger(battery) && battery >= 0 && battery <= 100) {
      updated = await this.updateCapability("measure_battery", battery) || updated;
    }
    if (updated && !this.stopping) {
      await this.updateWarning(null);
      if (!this.firstMeasurement) {
        this.firstMeasurement = true;
        this.log("Received first valid MJWSD05MMC measurement; encrypted=" + parsed.encrypted);
      }
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes("bindkey")) {
      const key = typeof newSettings.bindkey === "string" ? newSettings.bindkey.trim() : "";
      if (key && !this.getBindkeyBuffer(key)) {
        throw new Error(this.homey.__("mjwsd05mmc.invalid_bindkey"));
      }
      this.bindkey = this.getBindkeyBuffer(key);
    }
    if (changedKeys.includes("temperature_offset")) {
      this.temperatureOffset = this.getTemperatureOffset(newSettings.temperature_offset);
    }
    if (changedKeys.includes("bindkey") || changedKeys.includes("temperature_offset")) {
      await this.pollAdvertisement();
    }
  }

  stopAdvertisementUpdates() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.pollInterval != null) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.stopPromise = this.stopUpdates();
    return this.stopPromise;
  }

  async stopUpdates() {
    // Wait for a pending subscription before removing it, so deletion cannot leak a listener.
    if (this.startPromise) await this.startPromise;
    if (this.subscribed) {
      try {
        await this.homey.ble.unsubscribeFromAdvertisements(this.getPeripheralUuid());
        this.subscribed = false;
      } catch (error) {
        this.logFailure("unsubscribe", error);
        throw error;
      }
    }
    if (this.pollPromise) await this.pollPromise;
    if (this.advertisementQueue) await this.advertisementQueue;
  }

  async onDeleted() {
    await this.stopAdvertisementUpdates();
  }

  async onUninit() {
    await this.stopAdvertisementUpdates();
  }
}

module.exports = XiaomiMjwsd05mmcDevice;
