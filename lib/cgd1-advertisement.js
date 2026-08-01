"use strict";

const crypto = require("crypto");

const UUID_FE95 = "fe95";
const UUID_FDCD = "fdcd";
const CGD1_MIBEACON_DEVICE_ID = 0x0576;
const CGD1_QINGPING_DEVICE_ID = 0x0c;

const MIBEACON_OBJECTS = {
  temperature: 0x1004,
  humidity: 0x1006,
  battery: 0x100a,
  temperatureHumidity: 0x100d,
};

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

function parseMiBeaconObjects(payload) {
  const values = {};
  let offset = 0;

  while (payload.length >= offset + 3) {
    const objectType = payload.readUInt16LE(offset);
    const objectLength = payload.readUInt8(offset + 2);
    const nextOffset = offset + 3 + objectLength;
    if (payload.length < nextOffset) break;

    const objectData = payload.subarray(offset + 3, nextOffset);
    switch (objectType) {
      case MIBEACON_OBJECTS.temperature:
        if (objectData.length === 2) values.temperature = objectData.readInt16LE(0) / 10;
        break;
      case MIBEACON_OBJECTS.humidity:
        if (objectData.length === 2) values.humidity = objectData.readUInt16LE(0) / 10;
        break;
      case MIBEACON_OBJECTS.battery:
        if (objectData.length === 1) values.battery = objectData.readUInt8(0);
        break;
      case MIBEACON_OBJECTS.temperatureHumidity:
        if (objectData.length === 4) {
          values.temperature = objectData.readInt16LE(0) / 10;
          values.humidity = objectData.readUInt16LE(2) / 10;
        }
        break;
      default:
        break;
    }

    offset = nextOffset;
  }

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

function parseMiBeaconServiceData(rawData, address, bindkey) {
  const data = toBuffer(rawData);
  if (!data || data.length < 5 || data.readUInt16LE(2) !== CGD1_MIBEACON_DEVICE_ID) return null;

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
    deviceId: CGD1_MIBEACON_DEVICE_ID,
    deviceType: "CGD1",
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

  return {
    ...result,
    payloadHex: payload.toString("hex"),
    values: parseMiBeaconObjects(payload),
  };
}

function getQingpingPayloadOffset(data) {
  if (data.length >= 2 && data[0] === 0x08 && data[1] === CGD1_QINGPING_DEVICE_ID) return 0;
  if (
    data.length >= 4
    && data[0] === 0xcd
    && data[1] === 0xfd
    && data[2] === 0x08
    && data[3] === CGD1_QINGPING_DEVICE_ID
  ) return 2;
  if (
    data.length >= 5
    && data[0] === 0x16
    && data[1] === 0xcd
    && data[2] === 0xfd
    && data[3] === 0x08
    && data[4] === CGD1_QINGPING_DEVICE_ID
  ) return 3;
  return null;
}

function parseQingpingServiceData(rawData) {
  const data = toBuffer(rawData);
  if (!data) return null;

  const payloadOffset = getQingpingPayloadOffset(data);
  if (payloadOffset === null || data.length < payloadOffset + 8) return null;

  const mac = Buffer.from(data.subarray(payloadOffset + 2, payloadOffset + 8)).reverse();
  const values = {};
  let offset = payloadOffset + 8;

  while (data.length >= offset + 2) {
    const objectType = data.readUInt8(offset);
    const objectLength = data.readUInt8(offset + 1);
    const nextOffset = offset + 2 + objectLength;
    if (data.length < nextOffset) break;

    const objectData = data.subarray(offset + 2, nextOffset);
    if (objectType === 0x01 && objectData.length === 4) {
      values.temperature = objectData.readInt16LE(0) / 10;
      values.humidity = objectData.readUInt16LE(2) / 10;
    } else if (objectType === 0x02 && objectData.length === 1) {
      values.battery = objectData.readUInt8(0);
    }
    offset = nextOffset;
  }

  return {
    format: "qingping",
    serviceUuid: UUID_FDCD,
    deviceId: CGD1_QINGPING_DEVICE_ID,
    deviceType: "CGD1",
    encrypted: false,
    mac: mac.toString("hex"),
    rawHex: data.toString("hex"),
    values,
  };
}

function parseCgd1Advertisement(advertisement, bindkey = null) {
  const qingpingEntry = findServiceData(advertisement, UUID_FDCD);
  if (qingpingEntry) {
    const parsed = parseQingpingServiceData(qingpingEntry.data);
    if (parsed) return parsed;
  }

  const miBeaconEntry = findServiceData(advertisement, UUID_FE95);
  if (miBeaconEntry) {
    return parseMiBeaconServiceData(miBeaconEntry.data, advertisement && advertisement.address, bindkey);
  }

  return null;
}

module.exports = {
  CGD1_MIBEACON_DEVICE_ID,
  UUID_FDCD,
  UUID_FE95,
  normalizeMac,
  normalizeUuid,
  parseCgd1Advertisement,
  parseMiBeaconServiceData,
  parseQingpingServiceData,
  toBuffer,
};
