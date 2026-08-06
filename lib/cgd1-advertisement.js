"use strict";

const {
  UUID_FE95,
  findServiceData,
  normalizeMac,
  normalizeUuid,
  parseMiBeaconServiceData: parseSharedMiBeaconServiceData,
  parseStandardMiBeaconObjects,
  toBuffer,
} = require("./mibeacon-advertisement");

const UUID_FDCD = "fdcd";
const CGD1_MIBEACON_DEVICE_ID = 0x0576;
const CGD1_QINGPING_DEVICE_ID = 0x0c;

function parseMiBeaconServiceData(rawData, address, bindkey) {
  return parseSharedMiBeaconServiceData(rawData, address, bindkey, {
    expectedDeviceId: CGD1_MIBEACON_DEVICE_ID,
    deviceType: "CGD1",
    parseObjects: parseStandardMiBeaconObjects,
  });
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
