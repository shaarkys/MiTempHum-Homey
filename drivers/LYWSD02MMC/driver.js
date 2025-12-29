"use strict";

const { Driver } = require("homey");
const normalizeUuid = (uuid) => (uuid || "").toLowerCase().replace(/-/g, "");
const UUID_181A_LONG = "0000181a00001000800000805f9b34fb";
const UUID_181A_SHORT = "181a";
const UUID_FE95_LONG = "0000fe9500001000800000805f9b34fb";
const UUID_FE95_SHORT = "fe95";
const UUID_FEF5_LONG = "0000fef500001000800000805f9b34fb";
const UUID_FEF5_SHORT = "fef5";
const DISCOVERY_WAIT_MS = 9500;
const DISCOVERY_CACHE_TTL_MS = 30000;
const DISCOVERY_SERVICE_UUIDS = [UUID_181A_LONG, UUID_FEF5_LONG, UUID_FE95_LONG];
const isUuid181a = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_181A_SHORT || normalized === UUID_181A_LONG;
};
const isUuidFe95 = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_FE95_SHORT || normalized === UUID_FE95_LONG;
};
const isUuidFef5 = (uuid) => {
  const normalized = normalizeUuid(uuid);
  return normalized === UUID_FEF5_SHORT || normalized === UUID_FEF5_LONG;
};
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
    this.log(`onPairListDevices method called for LYWSD02MMC discovery (wait: ${DISCOVERY_WAIT_MS}ms, filter: ${DISCOVERY_SERVICE_UUIDS.join(", ")})`);

    try {
      if (!this._discoveryPromise) {
        this._discoveryPromise = this.homey.ble.discover(DISCOVERY_SERVICE_UUIDS)
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
          this.log(`Scanned Device - MAC: ${ad.address}, Name: ${ad.localName || "Unknown"}, UUIDs: ${serviceUuids}, Service Data UUIDs: ${serviceDataLabel}`);
        });
      }

      const devices = advertisements
        .filter((advertisement) => {
          const serviceUuids = Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids : [];
          const serviceData = Array.isArray(advertisement.serviceData) ? advertisement.serviceData : [];
          const name = typeof advertisement.localName === "string" ? advertisement.localName : "";
          const isLywsd02Name = name.toLowerCase().includes("lywsd02");
          const has181a = serviceUuids.some(isUuid181a) || serviceData.some((entry) => isUuid181a(entry.uuid));
          const hasFef5 = serviceUuids.some(isUuidFef5) || serviceData.some((entry) => isUuidFef5(entry.uuid));

          // Check for service UUIDs or service data, since some bridges omit advertised UUIDs
          return (
            has181a ||
            hasFef5 ||
            isLywsd02Name ||
            (serviceUuids.some(isUuidFe95) || serviceData.some((entry) => isUuidFe95(entry.uuid))) && isLywsd02Name
          );
        })
        .map((advertisement) => {
          // Log the devices that will be added
          const deviceId = advertisement.uuid || advertisement.address;
          this.log(`Device added for pairing - MAC: ${advertisement.address}, Name: ${advertisement.localName || `Device ${advertisement.address}`}, UUID: ${advertisement.uuid}`);
          return {
            name: advertisement.localName || `Device ${advertisement.address}`,
            data: {
              id: deviceId,
            },
            store: {
              peripheralUuid: advertisement.uuid,
              address: advertisement.address,
            },
          };
        });

      this.log(`Total devices added for pairing: ${devices.length}`);
      return devices;
    } catch (error) {
      this.error("Error during LYWSD02MMC listing:", error);
      throw error;
    }
  }
}

module.exports = LYWSD02MMC_Driver;
