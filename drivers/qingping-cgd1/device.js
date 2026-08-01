"use strict";

const { Device } = require("homey");
const {
  normalizeMac,
  parseCgd1Advertisement,
  toBuffer,
} = require("../../lib/cgd1-advertisement");

const FALLBACK_POLL_INTERVAL_MS = 60000;

class QingpingCgd1Device extends Device {
  async onInit() {
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;
    this.bindkey = this.getBindkeyBuffer();
    this.advertisementSubscriptionActive = false;
    this.advertisementQueue = Promise.resolve();

    for (const capabilityId of [
      "measure_temperature",
      "measure_humidity",
      "measure_battery",
      "measure_rssi",
    ]) {
      if (!this.hasCapability(capabilityId)) await this.addCapability(capabilityId);
    }

    await this.startAdvertisementUpdates();
    this.log("Qingping CGD1 initialized; waiting for BLE advertisements");
  }

  getBindkeyBuffer(rawValue = this.getSetting("bindkey")) {
    const normalized = typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
    return /^[0-9a-f]{32}$/.test(normalized) ? Buffer.from(normalized, "hex") : null;
  }

  getPeripheralUuid() {
    const store = this.getStore() || {};
    if (typeof store.peripheralUuid === "string" && store.peripheralUuid) return store.peripheralUuid;
    const data = this.getData() || {};
    return typeof data.id === "string" ? data.id : null;
  }

  advertisementMatchesDevice(advertisement) {
    const store = this.getStore() || {};
    const targetAddress = normalizeMac(store.address);
    const advertisementAddress = normalizeMac(advertisement && advertisement.address);
    const targetUuid = String(store.peripheralUuid || this.getData().id || "").toLowerCase().replace(/:/g, "");
    const advertisementUuid = String(advertisement && advertisement.uuid || "").toLowerCase().replace(/:/g, "");
    return Boolean(
      (targetAddress && advertisementAddress === targetAddress)
      || (targetUuid && advertisementUuid === targetUuid),
    );
  }

  formatServiceData(advertisement) {
    const serviceData = Array.isArray(advertisement && advertisement.serviceData)
      ? advertisement.serviceData
      : [];
    return serviceData.map((entry) => {
      const data = toBuffer(entry && entry.data);
      return `${entry && entry.uuid ? entry.uuid : "unknown"}:${data ? data.toString("hex") : "invalid"}`;
    }).join(", ") || "none";
  }

  supportsAdvertisementSubscriptions() {
    return Boolean(
      typeof this.homey.hasFeature === "function"
      && this.homey.hasFeature("ble-advertisements")
      && this.homey.ble
      && typeof this.homey.ble.subscribeToAdvertisements === "function",
    );
  }

  async startAdvertisementUpdates() {
    const peripheralUuid = this.getPeripheralUuid();
    if (this.supportsAdvertisementSubscriptions() && peripheralUuid) {
      try {
        await this.homey.ble.subscribeToAdvertisements(peripheralUuid, (advertisement) => {
          this.queueAdvertisement(advertisement);
        });
        this.advertisementSubscriptionActive = true;
        this.log(`Subscribed to CGD1 advertisements for ${peripheralUuid}`);
        return;
      } catch (error) {
        this.error(`Unable to subscribe to CGD1 advertisements: ${error.message || error}`);
      }
    }

    this.log("BLE advertisement subscriptions unavailable; using one-minute discovery fallback");
    await this.pollAdvertisement();
    this.pollInterval = this.homey.setInterval(
      () => this.pollAdvertisement(),
      FALLBACK_POLL_INTERVAL_MS,
    );
  }

  queueAdvertisement(advertisement) {
    this.advertisementQueue = this.advertisementQueue
      .then(() => this.processAdvertisement(advertisement))
      .catch((error) => this.error(`Failed to process CGD1 advertisement: ${error.message || error}`));
  }

  async pollAdvertisement() {
    try {
      const peripheralUuid = this.getPeripheralUuid();
      if (!peripheralUuid) return;
      const advertisement = await this.homey.ble.find(peripheralUuid);
      if (advertisement) this.queueAdvertisement(advertisement);
    } catch (error) {
      this.error(`CGD1 fallback discovery failed: ${error.message || error}`);
    }
  }

  async safeSetCapabilityValue(capabilityId, value) {
    try {
      await this.setCapabilityValue(capabilityId, value);
    } catch (error) {
      this.error(`Failed to set ${capabilityId}: ${error.message || error}`);
    }
  }

  async processAdvertisement(advertisement) {
    if (!advertisement || !this.advertisementMatchesDevice(advertisement)) return;

    this.log(
      `CGD1 advertisement - address: ${advertisement.address || "unknown"}, `
      + `uuid: ${advertisement.uuid || "unknown"}, rssi: ${advertisement.rssi}, `
      + `serviceData: ${this.formatServiceData(advertisement)}`,
    );

    if (typeof advertisement.rssi === "number") {
      await this.safeSetCapabilityValue("measure_rssi", advertisement.rssi);
    }

    const parsed = parseCgd1Advertisement(advertisement, this.bindkey);
    if (!parsed) return;

    if (parsed.bindkeyRequired) {
      const message = parsed.decryptionFailed
        ? "CGD1 MiBeacon decryption failed. Check the 32-character BLE bindkey."
        : "CGD1 is sending encrypted MiBeacon data. Enter its 32-character BLE bindkey in Advanced Settings.";
      await this.setWarning(message);
      this.log(`${message} Raw ${parsed.serviceUuid} payload: ${parsed.rawHex}`);
      return;
    }

    const { temperature, humidity, battery } = parsed.values;
    let updated = false;

    if (typeof temperature === "number") {
      const adjustedTemperature = temperature + this.temperatureOffset;
      if (adjustedTemperature >= -20 && adjustedTemperature <= 60) {
        await this.safeSetCapabilityValue("measure_temperature", adjustedTemperature);
        updated = true;
      }
    }
    if (typeof humidity === "number" && humidity >= 0 && humidity <= 100) {
      await this.safeSetCapabilityValue("measure_humidity", humidity);
      updated = true;
    }
    if (typeof battery === "number" && battery >= 0 && battery <= 100) {
      await this.safeSetCapabilityValue("measure_battery", battery);
      updated = true;
    }

    if (updated) {
      await this.setWarning(null);
      this.log(
        `Parsed CGD1 ${parsed.format} data - temperature: ${temperature}, `
        + `humidity: ${humidity}, battery: ${battery}`,
      );
    }
  }

  async stopAdvertisementUpdates() {
    if (this.pollInterval) {
      this.homey.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (
      this.advertisementSubscriptionActive
      && this.homey.ble
      && typeof this.homey.ble.unsubscribeFromAdvertisements === "function"
    ) {
      try {
        await this.homey.ble.unsubscribeFromAdvertisements(this.getPeripheralUuid());
      } catch (error) {
        this.error(`Unable to unsubscribe from CGD1 advertisements: ${error.message || error}`);
      }
    }
    this.advertisementSubscriptionActive = false;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes("temperature_offset")) {
      this.temperatureOffset = newSettings.temperature_offset || 0;
    }
    if (changedKeys.includes("bindkey")) {
      const normalized = typeof newSettings.bindkey === "string"
        ? newSettings.bindkey.trim()
        : "";
      if (normalized && !/^[0-9a-f]{32}$/i.test(normalized)) {
        throw new Error("The BLE bindkey must contain exactly 32 hexadecimal characters.");
      }
      this.bindkey = this.getBindkeyBuffer(normalized);
      await this.setWarning(null);
      await this.pollAdvertisement();
    }
  }

  async onDeleted() {
    await this.stopAdvertisementUpdates();
  }

  async onUninit() {
    await this.stopAdvertisementUpdates();
  }
}

module.exports = QingpingCgd1Device;
