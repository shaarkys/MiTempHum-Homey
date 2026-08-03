"use strict";

const { Device } = require("homey");
const {
  normalizeMac,
  parseCgd1Advertisement,
} = require("../../lib/cgd1-advertisement");

const FALLBACK_POLL_INTERVAL_MS = 60000;
const BATTERY_JITTER_INTERVAL_MS = 15 * 60 * 1000;

class QingpingCgd1Device extends Device {
  async onInit() {
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;
    this.bindkey = this.getBindkeyBuffer();
    this.advertisementSubscriptionActive = false;
    this.advertisementQueue = Promise.resolve();
    this.firstSuccessfulAdvertisementLogged = false;
    this.warningState = undefined;
    this.lastBatteryWriteAt = null;
    this.capabilityWriteErrorStates = new Map();

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
        this.clearErrorTransition("subscribe");
        this.log("Subscribed to CGD1 BLE advertisements");
        return;
      } catch (error) {
        this.logErrorTransition(
          "subscribe",
          `Unable to subscribe to CGD1 advertisements: ${error.message || error}`,
        );
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
      .then(() => this.clearErrorTransition("processing"))
      .catch((error) => this.logErrorTransition(
        "processing",
        `Failed to process CGD1 advertisement: ${error.message || error}`,
      ));
  }

  async pollAdvertisement() {
    try {
      const peripheralUuid = this.getPeripheralUuid();
      if (!peripheralUuid) return;
      const advertisement = await this.homey.ble.find(peripheralUuid);
      this.clearErrorTransition("poll");
      if (advertisement) this.queueAdvertisement(advertisement);
    } catch (error) {
      this.logErrorTransition(
        "poll",
        `CGD1 fallback discovery failed: ${error.message || error}`,
      );
    }
  }

  logErrorTransition(key, message) {
    if (!this.capabilityWriteErrorStates) this.capabilityWriteErrorStates = new Map();
    if (this.capabilityWriteErrorStates.get(key) === message) return;
    this.capabilityWriteErrorStates.set(key, message);
    this.error(message);
  }

  clearErrorTransition(key) {
    if (this.capabilityWriteErrorStates) this.capabilityWriteErrorStates.delete(key);
  }

  readCapabilityValue(capabilityId) {
    try {
      const value = this.getCapabilityValue(capabilityId);
      this.clearErrorTransition(`read:${capabilityId}`);
      return { ok: true, value };
    } catch (error) {
      this.logErrorTransition(
        `read:${capabilityId}`,
        `Failed to read ${capabilityId} before update: ${error.message || error}`,
      );
      return { ok: false, value: undefined };
    }
  }

  async safeSetCapabilityValue(capabilityId, value) {
    const { value: currentValue } = this.readCapabilityValue(capabilityId);

    if (currentValue === value || (Number.isNaN(currentValue) && Number.isNaN(value))) {
      this.clearErrorTransition(`write:${capabilityId}`);
      return { ok: true, changed: false };
    }

    try {
      await this.setCapabilityValue(capabilityId, value);
      this.clearErrorTransition(`write:${capabilityId}`);
      return { ok: true, changed: true };
    } catch (error) {
      this.logErrorTransition(
        `write:${capabilityId}`,
        `Failed to set ${capabilityId}: ${error.message || error}`,
      );
      return { ok: false, changed: false };
    }
  }

  async safeSetBatteryValue(value) {
    const { value: currentValue } = this.readCapabilityValue("measure_battery");
    if (currentValue === value || (Number.isNaN(currentValue) && Number.isNaN(value))) {
      this.clearErrorTransition("write:measure_battery");
      return { ok: true, changed: false };
    }

    const now = Date.now();
    const absoluteChange = typeof currentValue === "number"
      ? Math.abs(value - currentValue)
      : null;
    if (
      absoluteChange === 1
      && this.lastBatteryWriteAt !== null
      && now - this.lastBatteryWriteAt < BATTERY_JITTER_INTERVAL_MS
    ) {
      return { ok: true, changed: false };
    }

    const result = await this.safeSetCapabilityValue("measure_battery", value);
    if (result.ok && result.changed) this.lastBatteryWriteAt = now;
    return result;
  }

  async setWarningState(message) {
    if (this.warningState === message) return true;

    try {
      await this.setWarning(message);
      this.warningState = message;
      this.clearErrorTransition("warning");
      return true;
    } catch (error) {
      this.logErrorTransition(
        "warning",
        `Failed to update CGD1 warning: ${error.message || error}`,
      );
      return false;
    }
  }

  async processAdvertisement(advertisement) {
    if (!advertisement || !this.advertisementMatchesDevice(advertisement)) return;

    let successfulMeasurements = 0;
    let failedWrites = 0;
    if (typeof advertisement.rssi === "number") {
      const result = await this.safeSetCapabilityValue("measure_rssi", advertisement.rssi);
      if (!result.ok) failedWrites += 1;
    }

    const parsed = parseCgd1Advertisement(advertisement, this.bindkey);
    if (!parsed) return;

    if (parsed.bindkeyRequired) {
      const message = parsed.decryptionFailed
        ? "CGD1 MiBeacon decryption failed. Check the 32-character BLE bindkey."
        : "CGD1 is sending encrypted MiBeacon data. Enter its 32-character BLE bindkey in Advanced Settings.";
      await this.setWarningState(message);
      return;
    }

    const { temperature, humidity, battery } = parsed.values;

    if (typeof temperature === "number") {
      const adjustedTemperature = temperature + this.temperatureOffset;
      if (adjustedTemperature >= -20 && adjustedTemperature <= 60) {
        const result = await this.safeSetCapabilityValue("measure_temperature", adjustedTemperature);
        if (result.ok) successfulMeasurements += 1;
        else failedWrites += 1;
      }
    }
    if (typeof humidity === "number" && humidity >= 0 && humidity <= 100) {
      const result = await this.safeSetCapabilityValue("measure_humidity", humidity);
      if (result.ok) successfulMeasurements += 1;
      else failedWrites += 1;
    }
    if (typeof battery === "number" && battery >= 0 && battery <= 100) {
      const result = await this.safeSetBatteryValue(battery);
      if (result.ok) successfulMeasurements += 1;
      else failedWrites += 1;
    }

    if (successfulMeasurements > 0) {
      await this.setWarningState(null);
    }
    if (successfulMeasurements > 0 && failedWrites === 0 && !this.firstSuccessfulAdvertisementLogged) {
      this.firstSuccessfulAdvertisementLogged = true;
      this.log(`Received first valid CGD1 ${parsed.format} measurement`);
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
        this.clearErrorTransition("unsubscribe");
      } catch (error) {
        this.logErrorTransition(
          "unsubscribe",
          `Unable to unsubscribe from CGD1 advertisements: ${error.message || error}`,
        );
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
