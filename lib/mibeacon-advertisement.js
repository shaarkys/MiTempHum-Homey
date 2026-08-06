"use strict";

const crypto = require("crypto");

const UUID_FE95 = "fe95";

function normalizeUuid(uuid) {
  const normalized = typeof uuid === "string" ? uuid.toLowerCase().replace(/-/g, "") : "";
  if (normalized.length === 4) return normalized;
  const match = normalized.match(/^0000([0-9a-f]{4})00001000800000805f9b34fb$/);
  return match ? match[1] : normalized;
}

function normalizeMac(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/[^0-9a-f]/g, "");
  return normalized.length === 12 ? normalized : null;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex");
  }
  return null;
}

function findServiceData(advertisement, targetUuid) {
  const serviceData = Array.isArray(advertisement && advertisement.serviceData)
    ? advertisement.serviceData
    : [];
  return serviceData.find((entry) => normalizeUuid(entry && entry.uuid) === targetUuid) || null;
}

function forEachMiBeaconObject(payload, callback) {
  if (!Buffer.isBuffer(payload) || typeof callback !== "function") return;

  let offset = 0;
  while (payload.length >= offset + 3) {
    const objectType = payload.readUInt16LE(offset);
    const objectLength = payload.readUInt8(offset + 2);
    const nextOffset = offset + 3 + objectLength;
    if (payload.length < nextOffset) break;

    callback(objectType, payload.subarray(offset + 3, nextOffset));
    offset = nextOffset;
  }
}

function parseStandardMiBeaconObjects(payload) {
  const values = {};

  forEachMiBeaconObject(payload, (objectType, objectData) => {
    switch (objectType) {
      case 0x1004:
        if (objectData.length === 2) values.temperature = objectData.readInt16LE(0) / 10;
        break;
      case 0x1006:
        if (objectData.length === 2) values.humidity = objectData.readUInt16LE(0) / 10;
        break;
      case 0x100a:
        if (objectData.length === 1) values.battery = objectData.readUInt8(0);
        break;
      case 0x100d:
        if (objectData.length === 4) {
          values.temperature = objectData.readInt16LE(0) / 10;
          values.humidity = objectData.readUInt16LE(2) / 10;
        }
        break;
      default:
        break;
    }
  });

  return values;
}

function decryptMiBeaconV4V5(bindkey, data, payloadOffset, sourceMac) {
  const nonce = Buffer.concat([
    Buffer.from(sourceMac).reverse(),
    data.subarray(2, 5),
    data.subarray(-7, -4),
  ]);
  const encryptedPayload = data.subarray(payloadOffset, -7);
  const mic = data.subarray(-4);
  const decipher = crypto.createDecipheriv("aes-128-ccm", bindkey, nonce, { authTagLength: 4 });

  decipher.setAuthTag(mic);
  decipher.setAAD(Buffer.from([0x11]), { plaintextLength: encryptedPayload.length });
  return Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);
}

function parseMiBeaconServiceData(rawData, address, bindkey, options = {}) {
  const data = toBuffer(rawData);
  if (!data || data.length < 5) return null;

  const deviceId = data.readUInt16LE(2);
  if (options.expectedDeviceId !== undefined && deviceId !== options.expectedDeviceId) return null;

  const frameControl = data.readUInt16LE(0);
  const version = frameControl >> 12;
  const objectIncluded = ((frameControl >> 6) & 1) === 1;
  const capabilityIncluded = ((frameControl >> 5) & 1) === 1;
  const macIncluded = ((frameControl >> 4) & 1) === 1;
  const encrypted = ((frameControl >> 3) & 1) === 1;
  let offset = 5;
  let sourceMac;

  if (macIncluded) {
    if (data.length < offset + 6) return null;
    sourceMac = Buffer.from(data.subarray(offset, offset + 6)).reverse();
    offset += 6;
  } else {
    const normalizedAddress = normalizeMac(address);
    if (normalizedAddress) sourceMac = Buffer.from(normalizedAddress, "hex");
  }

  if (capabilityIncluded) {
    if (data.length < offset + 1) return null;
    const capability = data.readUInt8(offset);
    offset += 1;
    if ((capability & 0x20) !== 0) {
      if (data.length < offset + 1) return null;
      offset += 1;
    }
  }

  const result = {
    format: "mibeacon",
    serviceUuid: UUID_FE95,
    deviceId,
    deviceType: options.deviceType || "MiBeacon",
    version,
    encrypted,
    rawHex: data.toString("hex"),
    values: {},
  };

  if (!objectIncluded) return result;

  let payload;
  if (encrypted) {
    if (version < 4) {
      return { ...result, bindkeyRequired: true, unsupportedEncryption: true };
    }
    if (!Buffer.isBuffer(bindkey) || bindkey.length !== 16) {
      return { ...result, bindkeyRequired: true };
    }
    if (!sourceMac || sourceMac.length !== 6 || data.length < offset + 9) {
      return { ...result, bindkeyRequired: true, decryptionFailed: true };
    }

    try {
      payload = decryptMiBeaconV4V5(bindkey, data, offset, sourceMac);
    } catch {
      return { ...result, bindkeyRequired: true, decryptionFailed: true };
    }
  } else {
    payload = data.subarray(offset);
  }

  let values = {};
  if (typeof options.parseObjects === "function") {
    try {
      const parsedValues = options.parseObjects(payload);
      if (parsedValues && typeof parsedValues === "object") values = parsedValues;
    } catch {
      values = {};
    }
  }

  return {
    ...result,
    payloadHex: payload.toString("hex"),
    values,
  };
}

function parseMiBeaconAdvertisement(advertisement, bindkey = null, options = {}) {
  const entry = findServiceData(advertisement, UUID_FE95);
  if (!entry) return null;
  return parseMiBeaconServiceData(
    entry.data,
    advertisement && advertisement.address,
    bindkey,
    options,
  );
}

module.exports = {
  UUID_FE95,
  findServiceData,
  forEachMiBeaconObject,
  normalizeMac,
  normalizeUuid,
  parseMiBeaconAdvertisement,
  parseMiBeaconServiceData,
  parseStandardMiBeaconObjects,
  toBuffer,
};
