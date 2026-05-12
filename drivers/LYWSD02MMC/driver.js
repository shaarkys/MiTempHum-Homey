"use strict";

const { Driver } = require("homey");
const normalizeUuid = (uuid) => (uuid || "").toLowerCase().replace(/-/g, "");
const UUID_FE95_LONG = "0000fe9500001000800000805f9b34fb";
const UUID_FEF5_LONG = "0000fef500001000800000805f9b34fb";
const UUID_FEF5_SHORT = "fef5";
const UUID_FE95_SHORT = "fe95";
const DISCOVERY_SCAN_MS = 10000;
const DISCOVERY_WAIT_MS = 12500;
const DISCOVERY_CACHE_TTL_MS = 30000;
const DISCOVERY_SERVICE_UUIDS = [UUID_FE95_LONG, UUID_FEF5_LONG];
const FE95_SUPPORTED_DEVICE_IDS = new Set([0x045b, 0x16e4, 0x2542]);
const isUuidFe95 = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_FE95_SHORT || normalized === UUID_FE95_LONG;
};
const isUuidFef5 = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_FEF5_SHORT || normalized === UUID_FEF5_LONG;
};
const toBuffer = (value) => {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string" && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex");
  }

  return null;
};
const hasSupportedFe95Payload = (serviceData) => serviceData.some((entry) => {
  if (!entry || !isUuidFe95(entry.uuid)) {
    return false;
  }

  const data = toBuffer(entry.data);
  if (!data || data.length < 5) {
    return false;
  }

  return FE95_SUPPORTED_DEVICE_IDS.has(data.readUInt16LE(2));
});
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise.then((value) => ({ value, timedOut: false })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ value: null, timedOut: true }), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

class LYWSD02MMC_Driver extends Driver {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [Driver: LYWSD02MMC] -`, ...args);
  }

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log("BLE driver has been initialized");
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    this.log(`onPairListDevices method called for LYWSD02MMC discovery (scan: ${DISCOVERY_SCAN_MS}ms, wait: ${DISCOVERY_WAIT_MS}ms, post-filter: ${DISCOVERY_SERVICE_UUIDS.join(", ")})`);

    try {
      if (!this._discoveryPromise) {
        // Use unfiltered discover to support gateways that expose FE95 only in serviceData.
        this._discoveryPromise = this.homey.ble.discover([], DISCOVERY_SCAN_MS)
          .then((ads) => {
            this._lastAdvertisements = Array.isArray(ads) ? ads : [];
            this._lastDiscoveryAt = Date.now();
            return this._lastAdvertisements;
          })
          .catch((error) => {
            this.error("Error during BLE discovery:", error);
            return null;
          })
          .finally(() => {
            this._discoveryPromise = null;
          });
      }

      const discoveryPromise = this._discoveryPromise || Promise.resolve(null);
      const { value, timedOut } = await withTimeout(discoveryPromise, DISCOVERY_WAIT_MS);
      const cacheAge = this._lastDiscoveryAt ? Date.now() - this._lastDiscoveryAt : Number.POSITIVE_INFINITY;
      const cachedAdvertisements = cacheAge <= DISCOVERY_CACHE_TTL_MS ? this._lastAdvertisements : [];
      const advertisements = Array.isArray(value) ? value : cachedAdvertisements;

      if (timedOut) {
        this.log(`BLE discovery did not finish within ${DISCOVERY_WAIT_MS}ms; using cached results.`);
      }

      if (!advertisements || advertisements.length === 0) {
        this.log(timedOut ? "No cached BLE devices available yet." : "No BLE devices found during discovery.");
      } else {
        this.log(`Found ${advertisements.length} BLE devices.`);
        // Log details of each discovered device
        advertisements.forEach((ad) => {
          const serviceUuids = Array.isArray(ad.serviceUuids) ? ad.serviceUuids.join(", ") : "None";
          const serviceDataUuids = Array.isArray(ad.serviceData)
            ? ad.serviceData
              .map((entry) => entry && entry.uuid)
              .filter(Boolean)
              .join(", ")
            : "";
          const serviceDataLabel = serviceDataUuids.length > 0 ? serviceDataUuids : "None";
          this.log(`Scanned Device - MAC: ${ad.address}, Name: ${ad.localName || "Unknown"}, Manufacturer: ${ad.manufacturerName || "Unknown"}, Connectable: ${ad.connectable}, UUIDs: ${serviceUuids}, Service Data UUIDs: ${serviceDataLabel}`);
        });
      }

      const devicesById = new Map();

      advertisements
        .filter((advertisement) => {
          const serviceUuids = Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids : [];
          const serviceData = Array.isArray(advertisement.serviceData) ? advertisement.serviceData : [];
          const name = typeof advertisement.localName === "string" ? advertisement.localName : "";
          const nameLower = name.toLowerCase();
          const isLywsd02Name = nameLower.includes("lywsd02");
          const isConnectable = advertisement.connectable !== false;
          const hasFef5ServiceUuid = serviceUuids.some(isUuidFef5);
          const hasFef5ServiceData = serviceData.some((entry) => isUuidFef5(entry && entry.uuid));
          const hasSupportedFe95ServiceData = hasSupportedFe95Payload(serviceData);

          if (!isConnectable) {
            return false;
          }

          // Positive matching only:
          // - FE95 is shared by Xiaomi MiBeacon devices, so only supported LYWSD02 payload ids are accepted.
          // - FEF5 is retained for compatibility with earlier observed Bridge advertisements.
          // - If the name explicitly says LYWSD02, accept it as well.
          return hasSupportedFe95ServiceData || hasFef5ServiceUuid || hasFef5ServiceData || isLywsd02Name;
        })
        .forEach((advertisement) => {
          // Log the devices that will be added
          const deviceId = advertisement.uuid || advertisement.address;
          if (!deviceId) {
            return;
          }

          if (devicesById.has(deviceId)) {
            return;
          }

          this.log(`Device added for pairing - MAC: ${advertisement.address}, Name: ${advertisement.localName || `Device ${advertisement.address}`}, UUID: ${advertisement.uuid}`);
          devicesById.set(deviceId, {
            name: advertisement.localName || `Device ${advertisement.address}`,
            data: {
              id: deviceId,
            },
            store: {
              peripheralUuid: advertisement.uuid || deviceId,
              address: advertisement.address,
            },
          });
        });

      const devices = Array.from(devicesById.values());
      this.log(`Total devices added for pairing: ${devices.length}`);
      return devices;
    } catch (error) {
      this.error("Error during LYWSD02MMC listing:", error);
      throw error;
    }
  }
}

module.exports = LYWSD02MMC_Driver;
