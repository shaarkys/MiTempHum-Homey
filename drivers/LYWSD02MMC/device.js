"use strict";

const crypto = require("crypto");
const { Device } = require("homey");
const BLE_BASE_UUID_SUFFIX = "00001000800000805f9b34fb";
const normalizeUuid = (uuid) => (uuid || "").toLowerCase().replace(/-/g, "");
const normalizeMac = (address) => (address || "").toLowerCase().replace(/:/g, "");
const expandBleUuid = (uuid) => {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4) {
    return `0000${normalized}${BLE_BASE_UUID_SUFFIX}`;
  }
  if (normalized.length === 8) {
    return `${normalized}${BLE_BASE_UUID_SUFFIX}`;
  }
  return normalized;
};
const uuidsMatch = (left, right) => expandBleUuid(left) === expandBleUuid(right);
const toHomeyLookupUuid = (uuid) => {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4 || normalized.length === 8) {
    return normalized;
  }
  if (normalized.length === 32 && normalized.endsWith(BLE_BASE_UUID_SUFFIX) && normalized.startsWith("0000")) {
    return normalized.slice(4, 8);
  }
  if (normalized.length === 32) {
    return normalized.slice(0, 8);
  }
  return normalized;
};

const UUIDS = {
  clientCharacteristicConfig: "2902",
  deviceInformationService: "180a",
  miBeaconService: "fe95",
  firmwareCharacteristic: "2a26",
  lywsd02Service: "ebe0ccb07a0a4b0c8a1a6ff2997da3a6",
  lywsd02DataCharacteristic: "ebe0ccc17a0a4b0c8a1a6ff2997da3a6",
  lywsd02BatteryCharacteristic: "ebe0ccc47a0a4b0c8a1a6ff2997da3a6",
};
const FE95_SUPPORTED_DEVICE_TYPES = {
  0x045b: "LYWSD02",
  0x16e4: "LYWSD02MMC",
  0x2542: "LYWSD02MMC",
};
const FE95_OBJECTS = {
  temperature: 0x1004,
  humidity: 0x1006,
  battery: 0x100a,
  temperatureHumidity: 0x100d,
};
const PASSIVE_FE95_DISCOVERY_MS = 4000;

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
    return new Promise((resolve) => this.homey.setTimeout(resolve, 1000 * s));
  }

  async safeSetCapabilityValue(capabilityId, value) {
    try {
      await this.setCapabilityValue(capabilityId, value);
    } catch (error) {
      this.log(`Failed to set capability ${capabilityId}: ${error}`);
    }
  }

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    try {
      this.log("LYWSD02MMC BLE device has been initialized - ", this.getData());
      // Reset all values
      await this.safeSetCapabilityValue("measure_temperature", null);
      await this.safeSetCapabilityValue("measure_humidity", null);
      await this.safeSetCapabilityValue("measure_battery", null);

      if (!this.hasCapability("measure_rssi")) await this.addCapability("measure_rssi");

      await this.safeSetCapabilityValue("measure_rssi", null);

      // Get the initial temperature offset setting
      this.temperatureOffset = this.getSetting("temperature_offset") || 0;

      // Get the reconnect interval setting, default to 5 minutes
      this.reconnectInterval = this.getSetting("reconnect_interval") || 5 * 60;
      this.bindkey = this.getBindkeyBuffer();
      this.notificationTimeoutMs = 10000;
      this.subscriptionInProgress = false;
      this.notificationTimeout = null;
      this.notificationCharacteristic = null;

      // Enable notifications and subscribe to them
      // not working / not required ?
      // await this.enableNotifications();
      await this.getfirmware();
      await this.delay(1);
      await this.subscribeToBLENotifications();

      // Set up polling
      this.addListener("poll", this.subscribeToBLENotifications.bind(this));
      this.pollDevice();
    } catch (error) {
      this.log(`Error during initialization: ${error}`);
    }
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

  formatUuidList(items, fallback = "none") {
    if (!Array.isArray(items) || items.length === 0) {
      return fallback;
    }

    return items.map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item.uuid === "string") {
        return item.uuid;
      }

      return String(item);
    }).join(", ");
  }

  formatBufferHex(value) {
    if (Buffer.isBuffer(value)) {
      return value.toString("hex");
    }

    if (value && Buffer.isBuffer(value.data)) {
      return value.data.toString("hex");
    }

    return String(value);
  }

  getBindkeyBuffer(rawValue = this.getSetting("bindkey")) {
    const normalized = typeof rawValue === "string" ? rawValue.trim().toLowerCase() : "";
    if (!normalized) {
      return null;
    }

    if (/^[0-9a-f]{32}$/.test(normalized)) {
      return Buffer.from(normalized, "hex");
    }

    if (/^[0-9a-f]{24}$/.test(normalized)) {
      const expandedLegacyKey = `${normalized.slice(0, 12)}8d3d3c97${normalized.slice(12)}`;
      this.log("Using 24-character legacy Xiaomi bindkey format expanded to 16 bytes.");
      return Buffer.from(expandedLegacyKey, "hex");
    }

    if (!/^[0-9a-f]+$/.test(normalized)) {
      this.log(`Ignoring invalid bindkey format: expected hexadecimal characters, got "${rawValue}"`);
      return null;
    }

    if (normalized.length !== 24 && normalized.length !== 32) {
      this.log(`Ignoring invalid bindkey length: expected 24 or 32 hex characters, got ${normalized.length}`);
      return null;
    }

    return null;
  }

  logAdvertisementContext(advertisement) {
    const serviceUuids = this.formatUuidList(advertisement && advertisement.serviceUuids);
    const serviceData = Array.isArray(advertisement && advertisement.serviceData)
      ? advertisement.serviceData.map((entry) => `${entry.uuid}:${this.formatBufferHex(entry && entry.data)}`).join(", ")
      : "none";

    this.log(
      `Advertisement context - gateway: ${advertisement.gateway || "n/a"}, address: ${advertisement.address || "n/a"}, connectable: ${advertisement.connectable}, serviceUuids: ${serviceUuids}, serviceData: ${serviceData}`,
    );
  }

  logErrorDetails(context, error) {
    const message = error && error.message ? error.message : String(error);
    const stack = error && error.stack ? error.stack : "no stack";
    this.log(`${context}: ${message}`);
    this.log(`${context} stack: ${stack}`);
  }

  async getServiceByUuid(peripheral, expectedUuid) {
    const services = await peripheral.discoverServices();
    this.log(`Discovered services: ${this.formatUuidList(services)}`);
    const service = services.find((candidate) => uuidsMatch(candidate.uuid, expectedUuid));

    if (!service) {
      const availableServices = services.map((candidate) => candidate.uuid).join(", ") || "none";
      throw new Error(`Service not found: ${expectedUuid}. Available services: ${availableServices}`);
    }

    return service;
  }

  async getCharacteristicByUuid(service, expectedUuid) {
    const characteristics = await service.discoverCharacteristics();
    this.log(`Discovered characteristics for ${service.uuid}: ${this.formatUuidList(characteristics)}`);
    const characteristic = characteristics.find((candidate) => uuidsMatch(candidate.uuid, expectedUuid));

    if (!characteristic) {
      const availableCharacteristics = characteristics.map((candidate) => candidate.uuid).join(", ") || "none";
      throw new Error(`Characteristic not found: ${expectedUuid}. Available characteristics: ${availableCharacteristics}`);
    }

    return characteristic;
  }

  async getDirectService(peripheral, serviceUuid) {
    const lookupUuid = expandBleUuid(serviceUuid);
    this.log(`Attempting direct service lookup: ${serviceUuid} -> ${lookupUuid}`);
    const service = await peripheral.getService(lookupUuid);
    this.log(`Direct service lookup succeeded: ${service.uuid}`);
    return service;
  }

  async getDirectCharacteristic(service, characteristicUuid) {
    const shortLookupUuid = toHomeyLookupUuid(characteristicUuid);
    const expandedLookupUuid = expandBleUuid(characteristicUuid);

    try {
      this.log(`Attempting direct characteristic lookup on ${service.uuid}: ${characteristicUuid} -> ${shortLookupUuid}`);
      const characteristic = await service.getCharacteristic(shortLookupUuid);
      this.log(`Direct characteristic lookup succeeded: ${characteristic.uuid}`);
      return characteristic;
    } catch (error) {
      this.logErrorDetails(`Direct characteristic lookup failed using ${shortLookupUuid}`, error);
      if (shortLookupUuid === expandedLookupUuid) {
        throw error;
      }

      this.log(`Retrying direct characteristic lookup on ${service.uuid}: ${characteristicUuid} -> ${expandedLookupUuid}`);
      const characteristic = await service.getCharacteristic(expandedLookupUuid);
      this.log(`Direct characteristic lookup succeeded on retry: ${characteristic.uuid}`);
      return characteristic;
    }
  }

  async getDescriptorByUuid(characteristic, expectedUuid) {
    const descriptors = await characteristic.discoverDescriptors();
    this.log(`Discovered descriptors for ${characteristic.uuid}: ${this.formatUuidList(descriptors)}`);
    const descriptor = descriptors.find((candidate) => uuidsMatch(candidate.uuid, expectedUuid));

    if (!descriptor) {
      const availableDescriptors = descriptors.map((candidate) => candidate.uuid).join(", ") || "none";
      throw new Error(`Descriptor not found: ${expectedUuid}. Available descriptors: ${availableDescriptors}`);
    }

    return descriptor;
  }

  async enableTemperatureHumidityNotifications(characteristic) {
    this.log(`Enabling notifications for characteristic: ${characteristic.uuid}`);
    const cccdDescriptor = await this.getDescriptorByUuid(characteristic, UUIDS.clientCharacteristicConfig);
    await cccdDescriptor.writeValue(Buffer.from([0x01, 0x00]));
    this.log(`Enabled notifications through CCCD descriptor: ${cccdDescriptor.uuid}`);
  }

  shouldUseDiscoveryFallback(error) {
    return Boolean(
      error
      && typeof error.message === "string"
      && (
        error.message.includes("Invalid uuid")
        || error.message.includes("No characteristic found with UUID")
      ),
    );
  }

  getFe95ServiceData(advertisement) {
    const serviceData = Array.isArray(advertisement && advertisement.serviceData) ? advertisement.serviceData : [];
    return serviceData.find((entry) => uuidsMatch(entry && entry.uuid, UUIDS.miBeaconService)) || null;
  }

  advertisementMatchesTarget(advertisement, targetAddress, targetUuid) {
    const normalizedAddress = normalizeMac(advertisement && advertisement.address);
    const normalizedUuid = normalizeMac(advertisement && advertisement.uuid);
    return (
      (targetAddress && normalizedAddress === normalizeMac(targetAddress))
      || (targetUuid && normalizedUuid === normalizeMac(targetUuid))
    );
  }

  parseMiBeaconPayload(payload) {
    const parsed = {};
    let offset = 0;

    while (payload.length >= offset + 3) {
      const objectType = payload.readUInt16LE(offset);
      const objectLength = payload.readUInt8(offset + 2);
      const nextOffset = offset + 3 + objectLength;

      if (payload.length < nextOffset) {
        this.log(`Incomplete MiBeacon object 0x${objectType.toString(16)} in payload: ${payload.toString("hex")}`);
        break;
      }

      const objectData = payload.slice(offset + 3, nextOffset);
      switch (objectType) {
        case FE95_OBJECTS.temperature:
          if (objectData.length === 2) {
            parsed.temperature = objectData.readInt16LE(0) / 10;
          }
          break;
        case FE95_OBJECTS.humidity:
          if (objectData.length === 2) {
            parsed.humidity = objectData.readUInt16LE(0) / 10;
          }
          break;
        case FE95_OBJECTS.battery:
          if (objectData.length >= 1) {
            parsed.battery = objectData.readUInt8(0);
          }
          break;
        case FE95_OBJECTS.temperatureHumidity:
          if (objectData.length === 4) {
            parsed.temperature = objectData.readInt16LE(0) / 10;
            parsed.humidity = objectData.readUInt16LE(2) / 10;
          }
          break;
        default:
          break;
      }

      offset = nextOffset;
    }

    return parsed;
  }

  decryptMiBeaconV4V5(bindkey, data, payloadOffset, sourceMac) {
    if (!bindkey || bindkey.length !== 16) {
      throw new Error("Missing 16-byte bindkey for encrypted FE95 payload");
    }

    if (data.length < payloadOffset + 9) {
      throw new Error(`Encrypted FE95 payload too short: ${data.length} bytes`);
    }

    const nonce = Buffer.concat([
      Buffer.from(sourceMac).reverse(),
      data.slice(2, 5),
      data.slice(-7, -4),
    ]);
    const encryptedPayload = data.slice(payloadOffset, -7);
    const mic = data.slice(-4);
    const decipher = crypto.createDecipheriv("aes-128-ccm", bindkey, nonce, { authTagLength: 4 });

    decipher.setAuthTag(mic);
    decipher.setAAD(Buffer.from([0x11]), { plaintextLength: encryptedPayload.length });

    return Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
  }

  parseFe95Advertisement(advertisement) {
    const serviceDataEntry = this.getFe95ServiceData(advertisement);
    if (!serviceDataEntry || !Buffer.isBuffer(serviceDataEntry.data)) {
      return null;
    }

    const data = serviceDataEntry.data;
    if (data.length < 5) {
      this.log(`Skipping FE95 payload with invalid length: ${data.toString("hex")}`);
      return null;
    }

    const frameControl = data.readUInt16LE(0);
    const version = frameControl >> 12;
    const objectIncluded = ((frameControl >> 6) & 1) === 1;
    const capabilityIncluded = ((frameControl >> 5) & 1) === 1;
    const macIncluded = ((frameControl >> 4) & 1) === 1;
    const encrypted = ((frameControl >> 3) & 1) === 1;
    const deviceId = data.readUInt16LE(2);
    const deviceType = FE95_SUPPORTED_DEVICE_TYPES[deviceId];

    if (!deviceType) {
      this.log(`Ignoring unsupported FE95 device id 0x${deviceId.toString(16)} payload: ${data.toString("hex")}`);
      return null;
    }

    let offset = 5;
    let sourceMac = Buffer.from(normalizeMac(advertisement.address), "hex");

    if (macIncluded) {
      if (data.length < offset + 6) {
        this.log(`Invalid FE95 payload, missing MAC bytes: ${data.toString("hex")}`);
        return null;
      }
      sourceMac = Buffer.from(data.slice(offset, offset + 6)).reverse();
      offset += 6;
    }

    if (capabilityIncluded) {
      if (data.length < offset + 1) {
        this.log(`Invalid FE95 payload, missing capability byte: ${data.toString("hex")}`);
        return null;
      }
      const capability = data.readUInt8(offset);
      offset += 1;
      if ((capability & 0x20) !== 0) {
        if (data.length < offset + 1) {
          this.log(`Invalid FE95 payload, missing capability IO byte: ${data.toString("hex")}`);
          return null;
        }
        offset += 1;
      }
    }

    if (!objectIncluded) {
      this.log(`FE95 payload for ${deviceType} has no object data: ${data.toString("hex")}`);
      return {
        encrypted,
        deviceId,
        deviceType,
        version,
        values: {},
      };
    }

    let payload;
    if (encrypted) {
      if (version <= 3) {
        this.log(`Encrypted FE95 payload uses unsupported legacy MiBeacon v${version}: ${data.toString("hex")}`);
        return {
          encrypted,
          deviceId,
          deviceType,
          version,
          values: {},
          bindkeyRequired: true,
        };
      }

      if (!this.bindkey) {
        this.log(`Encrypted FE95 payload for ${deviceType} detected but bindkey is not configured: ${data.toString("hex")}`);
        return {
          encrypted,
          deviceId,
          deviceType,
          version,
          values: {},
          bindkeyRequired: true,
        };
      }

      try {
        payload = this.decryptMiBeaconV4V5(this.bindkey, data, offset, sourceMac);
      } catch (error) {
        this.logErrorDetails("Failed to decrypt FE95 payload", error);
        return {
          encrypted,
          deviceId,
          deviceType,
          version,
          values: {},
          bindkeyRequired: true,
          decryptionFailed: true,
        };
      }
    } else {
      payload = data.slice(offset);
    }

    return {
      encrypted,
      deviceId,
      deviceType,
      version,
      payloadHex: payload.toString("hex"),
      rawHex: data.toString("hex"),
      values: this.parseMiBeaconPayload(payload),
    };
  }

  async applyParsedAdvertisementValues(parsed) {
    if (!parsed || !parsed.values) {
      return {
        hasTemperature: false,
        hasHumidity: false,
        hasCompleteMeasurement: false,
      };
    }

    const { temperature, humidity, battery } = parsed.values;
    const hasTemperature = temperature !== undefined;
    const hasHumidity = humidity !== undefined;

    this.log(
      `Parsed FE95 advertisement - model: ${parsed.deviceType}, version: ${parsed.version}, encrypted: ${parsed.encrypted}, payload: ${parsed.payloadHex || "n/a"}, values: ${JSON.stringify(parsed.values)}`,
    );

    if (battery !== undefined && battery >= 0 && battery <= 100) {
      await this.safeSetCapabilityValue("measure_battery", battery);
      this.log(`Battery level from FE95 advertisement: ${battery}%`);
    }

    if (temperature !== undefined) {
      const adjustedTemperature = temperature + this.temperatureOffset;
      if (adjustedTemperature < -20 || adjustedTemperature > 50) {
        this.log(`Ignoring FE95 temperature reading: ${adjustedTemperature}°C`);
      } else {
        await this.safeSetCapabilityValue("measure_temperature", adjustedTemperature);
        this.log(`Passive temperature from FE95: ${adjustedTemperature}°C`);
      }
    }

    if (humidity !== undefined) {
      if (humidity < 0 || humidity > 100) {
        this.log(`Ignoring FE95 humidity reading: ${humidity}%`);
      } else {
        await this.safeSetCapabilityValue("measure_humidity", humidity);
        this.log(`Passive humidity from FE95: ${humidity}%`);
      }
    }

    return {
      hasTemperature,
      hasHumidity,
      hasCompleteMeasurement: hasTemperature && hasHumidity,
    };
  }

  shouldPreferPassiveOnly(advertisement, parsedAdvertisement) {
    const serviceUuids = Array.isArray(advertisement && advertisement.serviceUuids) ? advertisement.serviceUuids : [];
    return Boolean(
      parsedAdvertisement
      && parsedAdvertisement.deviceType === "LYWSD02MMC"
      && serviceUuids.length === 0,
    );
  }

  async waitForAdditionalFe95Measurements(targetAddress, targetUuid) {
    this.log(`Starting passive FE95 rescan for ${PASSIVE_FE95_DISCOVERY_MS}ms to collect additional LYWSD02MMC advertisements.`);
    const advertisements = await this.homey.ble.discover([], PASSIVE_FE95_DISCOVERY_MS);
    const matchingAdvertisements = Array.isArray(advertisements)
      ? advertisements.filter((advertisement) => this.advertisementMatchesTarget(advertisement, targetAddress, targetUuid))
      : [];

    this.log(`Passive FE95 rescan found ${matchingAdvertisements.length} matching advertisements.`);

    const mergedValues = {};
    let lastParsedAdvertisement = null;

    for (const candidate of matchingAdvertisements) {
      this.logAdvertisementContext(candidate);
      const parsedAdvertisement = this.parseFe95Advertisement(candidate);
      if (!parsedAdvertisement) {
        continue;
      }

      lastParsedAdvertisement = parsedAdvertisement;
      Object.assign(mergedValues, parsedAdvertisement.values);

      if (mergedValues.temperature !== undefined && mergedValues.humidity !== undefined) {
        return {
          ...parsedAdvertisement,
          values: mergedValues,
          payloadHex: parsedAdvertisement.payloadHex || "merged",
        };
      }
    }

    if (!lastParsedAdvertisement) {
      return null;
    }

    return {
      ...lastParsedAdvertisement,
      values: mergedValues,
      payloadHex: lastParsedAdvertisement.payloadHex || "merged",
    };
  }

  async resolveSensorCharacteristics(peripheral) {
    try {
      const service = await this.getDirectService(peripheral, UUIDS.lywsd02Service);
      this.log("Sensor characteristic resolution mode: direct");
      return {
        mode: "direct",
        tempHumCharacteristic: await this.getDirectCharacteristic(service, UUIDS.lywsd02DataCharacteristic),
        batteryCharacteristic: await this.getDirectCharacteristic(service, UUIDS.lywsd02BatteryCharacteristic),
      };
    } catch (error) {
      if (!this.shouldUseDiscoveryFallback(error)) {
        this.logErrorDetails("Direct UUID lookup failed with non-fallback error", error);
        throw error;
      }

      this.log(`Direct UUID lookup failed, switching to discovery fallback: ${error.message}`);
      const service = await this.getServiceByUuid(peripheral, UUIDS.lywsd02Service);
      this.log("Sensor characteristic resolution mode: discovery fallback");
      return {
        mode: "fallback",
        tempHumCharacteristic: await this.getCharacteristicByUuid(service, UUIDS.lywsd02DataCharacteristic),
        batteryCharacteristic: await this.getCharacteristicByUuid(service, UUIDS.lywsd02BatteryCharacteristic),
      };
    }
  }

  async subscribeToTemperatureHumidity(characteristic, onData) {
    this.notificationCharacteristic = characteristic;
    this.log(`Calling subscribeToNotifications on characteristic: ${characteristic.uuid}`);
    await characteristic.subscribeToNotifications((data) => {
      try {
        this.clearNotificationTimeout();
        onData(data);
      } catch (error) {
        this.log(`Error processing notification data: ${error}`);
      }
    });
    this.setNotificationTimeout();
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

      if (changedKeys.includes("bindkey")) {
        this.bindkey = this.getBindkeyBuffer(newSettings.bindkey);
        this.log(`Device ${this.getName()} bindkey was ${this.bindkey ? "updated" : "cleared or invalid"}`);
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
    const peripheralUuid = this.getPeripheralUuid();
    if (!peripheralUuid) {
      throw new Error("Missing peripheral UUID in device store/data");
    }
    let peripheral;

    try {
      const advertisement = await this.homey.ble.find(peripheralUuid);
      peripheral = await advertisement.connect();
      this.log(`Connected to device: ${peripheralUuid}`);

      const serviceUuid = UUIDS.lywsd02Service;
      const characteristicUuid = UUIDS.lywsd02DataCharacteristic;

      const service = await this.getServiceByUuid(peripheral, serviceUuid);
      this.log(`Obtained service: ${serviceUuid}`);
      const characteristic = await this.getCharacteristicByUuid(service, characteristicUuid);
      this.log(`Obtained characteristic: ${characteristicUuid}`);
      await this.enableTemperatureHumidityNotifications(characteristic);

      // Logging RSSI and checking signal strength
      const rssi = advertisement.rssi;
      this.log(`Device RSSI: ${rssi} dBm`);

      const rssiPercentage = Math.round(Math.max(0, Math.min(100, ((rssi + 100) / 60) * 100)));
      //workaround even this shall be solved by oninit
      if (!this.hasCapability("measure_rssi")) await this.addCapability("measure_rssi");
      this.log(`Device RSSI Percentage: ${rssiPercentage}%`);

      // Set the RSSI capability value
      await this.safeSetCapabilityValue("measure_rssi", rssi);

      if (rssi < -80) {
        this.setWarning(`RSSI (signal strength) is too low (${rssi} dBm) / ~ ${rssiPercentage}%`);
        this.homey.setTimeout(() => this.setWarning(null), 15000);
      }

      const deviceInfoService = await this.getServiceByUuid(peripheral, UUIDS.deviceInformationService);
      const firmwareCharacteristic = await this.getCharacteristicByUuid(deviceInfoService, UUIDS.firmwareCharacteristic);
      const firmwareData = await firmwareCharacteristic.read();
      this.log(`Firmware version: ${firmwareData.toString("utf-8")}`);
    } catch (error) {
      this.log(`Failed to enable notifications: ${error}`);
      setTimeout(() => this.setWarning(null), 95000, await this.setWarning(`${error}`));
    } finally {
      if (peripheral) {
        try {
          await peripheral.disconnect();
        } catch (error) {
          this.log(`Failed to disconnect after enabling notifications: ${error}`);
        }
      }
    }
  }

  /**
   * Enable notifications for temperature, humidity, and battery
   */
  async getfirmware() {
    let peripheral;
    try {
      const peripheralUuid = this.getPeripheralUuid();
      if (!peripheralUuid) {
        throw new Error("Missing peripheral UUID in device store/data");
      }

      const advertisement = await this.homey.ble.find(peripheralUuid);
      peripheral = await advertisement.connect();
      this.log(`Connected to device: ${peripheralUuid}`);
      const deviceInfoService = await this.getServiceByUuid(peripheral, UUIDS.deviceInformationService);
      const firmwareCharacteristic = await this.getCharacteristicByUuid(deviceInfoService, UUIDS.firmwareCharacteristic);
      const firmwareData = await firmwareCharacteristic.read();
      this.log(`Firmware version: ${firmwareData.toString("utf-8")}`);
    } catch (error) {
      this.log(`Failed to get firmware version ${error}`);
    } finally {
      if (peripheral) {
        try {
          await peripheral.disconnect();
        } catch (error) {
          this.log(`Failed to disconnect after getting firmware: ${error}`);
        }
      }
    }
  }

  /**
   * Subscribe to BLE notifications and read battery level
   */
  async subscribeToBLENotifications() {
    if (this.subscriptionInProgress) {
      this.log("BLE subscription already in progress, skipping.");
      return;
    }
    this.subscriptionInProgress = true;
    this.log("Starting BLE subscription");
    const peripheralUuid = this.getPeripheralUuid();
    if (!peripheralUuid) {
      this.subscriptionInProgress = false;
      throw new Error("Missing peripheral UUID in device store/data");
    }
    let lastTempHumidityData = null;
    this.setWarning(null);
    let peripheral;

    try {
      await this.stopBLESubscription();
      const advertisement = await this.homey.ble.find(peripheralUuid);
      this.logAdvertisementContext(advertisement);

      // Logging RSSI and checking signal strength
      const rssi = advertisement.rssi;
      this.log(`Device RSSI: ${rssi} dBm`);

      //workaround even this shall be solved by oninit
      if (!this.hasCapability("measure_rssi")) await this.addCapability("measure_rssi");

      // Set the RSSI capability value
      await this.safeSetCapabilityValue("measure_rssi", rssi);

      const rssiPercentage = Math.round(Math.max(0, Math.min(100, ((rssi + 100) / 60) * 100)));
      this.log(`Device RSSI Percentage: ${rssiPercentage}%`);

      if (rssi < -80) {
        this.setWarning(`RSSI (signal strength) is too low (${rssi} dBm) / ~ ${rssiPercentage}%`);
        this.homey.setTimeout(() => this.setWarning(null), 15000);
      }

      const parsedAdvertisement = this.parseFe95Advertisement(advertisement);
      if (parsedAdvertisement) {
        let effectiveParsedAdvertisement = parsedAdvertisement;
        let passiveResult = await this.applyParsedAdvertisementValues(effectiveParsedAdvertisement);

        if (!passiveResult.hasCompleteMeasurement && this.shouldPreferPassiveOnly(advertisement, effectiveParsedAdvertisement)) {
          this.log("Passive FE95 advertisement is incomplete for LYWSD02MMC with no exposed service UUIDs; rescanning before any GATT fallback.");
          const rescannedAdvertisement = await this.waitForAdditionalFe95Measurements(advertisement.address, peripheralUuid);
          if (rescannedAdvertisement) {
            effectiveParsedAdvertisement = rescannedAdvertisement;
            passiveResult = await this.applyParsedAdvertisementValues(effectiveParsedAdvertisement);
          }
        }

        if (passiveResult.hasCompleteMeasurement) {
          this.log("Using passive FE95 advertisement data, skipping GATT subscription.");
          this.setWarning(null);
          return;
        }

        if (passiveResult.hasTemperature || passiveResult.hasHumidity) {
          this.log(
            `Passive FE95 advertisement was partial (temperature: ${passiveResult.hasTemperature}, humidity: ${passiveResult.hasHumidity}); continuing to GATT subscription for missing values.`,
          );
        } else if (this.shouldPreferPassiveOnly(advertisement, effectiveParsedAdvertisement)) {
          this.log("Passive FE95 advertisement still has no measurement objects after rescan; continuing to GATT fallback for this poll on LYWSD02MMC.");
        }
      }

      peripheral = await advertisement.connect();
      this.peripheral = peripheral;
      this.log(`Connected to device: ${peripheralUuid}`);

      const { mode, tempHumCharacteristic, batteryCharacteristic } = await this.resolveSensorCharacteristics(peripheral);
      this.log(`Resolved sensor characteristics using mode: ${mode}`);
      const batteryData = await batteryCharacteristic.read();

      this.log(`Battery data buffer: ${batteryData.toString("hex")}`);

      const battery = batteryData.readUInt8(0);
      this.log(`Battery level: ${battery}%`);
      if (battery >= 0 && battery <= 100) {
        await this.safeSetCapabilityValue("measure_battery", battery);
      }

      peripheral.once("disconnect", async () => {
        this.notificationCharacteristic = null;
        this.peripheral = null;
        this.log(`Disconnected from device: ${peripheralUuid}, will reconnect in ${this.reconnectInterval} seconds`);
      });

      if (mode === "fallback") {
        await this.enableTemperatureHumidityNotifications(tempHumCharacteristic);
      }

      try {
        await this.subscribeToTemperatureHumidity(tempHumCharacteristic, (data) => {
          const dataString = data.toString("hex");
          if (lastTempHumidityData !== dataString) {
            this.log("Received new notification temp/humidity: ", data);
            this.updateTag(data);
            lastTempHumidityData = dataString;
          }
        });
      } catch (error) {
        this.notificationCharacteristic = null;
        this.logErrorDetails(`subscribeToNotifications failed in mode ${mode}`, error);
        if (mode !== "fallback" || !this.shouldUseDiscoveryFallback(error)) {
          throw error;
        }

        this.log(`Falling back to direct read after notification subscribe failure in discovery mode: ${error.message}`);
        const tempHumData = await tempHumCharacteristic.read();
        this.log(`Temperature/humidity data buffer: ${tempHumData.toString("hex")}`);

        if (tempHumData.length >= 3) {
          await this.updateTag(tempHumData, { disconnectAfter: false });
          await this.stopBLESubscription();
          this.setWarning(null);
          return;
        }

        throw error;
      }

      this.log(`Subscribed to notifications for device: ${peripheralUuid}`);
      this.setWarning(null);
    } catch (error) {
      this.log(`Failed to subscribe to notifications: ${error}`);
      this.logErrorDetails("Final subscribeToBLENotifications error", error);
      await this.stopBLESubscription();
      await this.setWarning(`${error}`);
      this.homey.setTimeout(() => this.setWarning(null), 65000);
    } finally {
      this.subscriptionInProgress = false;
      if (peripheral && peripheral.state === "connected" && !this.peripheral) {
        try {
          await peripheral.disconnect();
        } catch (error) {
          this.log(`Failed to disconnect after subscription failure: ${error}`);
        }
      }
    }
  }

  setNotificationTimeout() {
    this.clearNotificationTimeout();
    this.notificationTimeout = this.homey.setTimeout(async () => {
      this.log("No BLE notification received in time; disconnecting to recover.");
      await this.stopBLESubscription();
    }, this.notificationTimeoutMs);
  }

  clearNotificationTimeout() {
    if (this.notificationTimeout) {
      this.homey.clearTimeout(this.notificationTimeout);
      this.notificationTimeout = null;
    }
  }

  /**
   * Stop BLE subscription
   */
  async stopBLESubscription() {
    try {
      this.clearNotificationTimeout();
      // Clear any timeouts if you're using Homey.setTimeout
      if (this.disconnectTimeout) {
        this.homey.clearTimeout(this.disconnectTimeout);
        this.disconnectTimeout = null;
      }

      if (this.notificationCharacteristic || this.peripheral) {
        await this.unsubscribeFromBLENotifications();
      }
      this.log("Stopped BLE subscription");
    } catch (error) {
      this.log("Error during unsubscribe:", error);
    }
  }

  /**
   * Unsubscribe from BLE notifications
   */
  async unsubscribeFromBLENotifications() {
    try {
      if (this.notificationCharacteristic) {
        await this.notificationCharacteristic.unsubscribeFromNotifications();
        this.log("Unsubscribed from BLE notifications");
      }
    } catch (error) {
      this.log(`Failed to unsubscribe from notifications: ${error}`);
    } finally {
      this.notificationCharacteristic = null;
    }

    try {
      if (this.peripheral) {
        const peripheralId = this.peripheral.id;
        await this.peripheral.disconnect();
        this.log(`Disconnected from device: ${peripheralId}`);
      }
    } catch (error) {
      this.log(`Failed to disconnect from device: ${error}`);
    } finally {
      this.peripheral = null;
    }
  }

  /**
   * Update tag with received data from BLE notifications
   */
  async updateTag(data, { disconnectAfter = true } = {}) {
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

      this.log(`LYWSD02 temperature: ${temperature}°C, Humidity: ${humidity}%`);

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
    if (disconnectAfter) {
      await this.stopBLESubscription();
    }
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
