"use strict";

const {
  findServiceData,
  forEachMiBeaconObject,
  parseMiBeaconServiceData,
  parseStandardMiBeaconObjects,
  toBuffer,
} = require("./mibeacon-advertisement");

// Both hardware revisions are mapped by Bluetooth-Devices/xiaomi-ble.
const MJWSD05MMC_DEVICE_IDS = [0x2832, 0x4c47];

function parseMjwsd05mmcObjects(payload) {
  const values = parseStandardMiBeaconObjects(payload);
  forEachMiBeaconObject(payload, (type, data) => {
    let key;
    switch (type) {
      case 0x4801:
      case 0x4c01:
        key = "temperature";
        break;
      case 0x4808:
      case 0x4c08:
        key = "humidity";
        break;
      case 0x4802:
      case 0x4c02:
        if (data.length === 1) values.humidity = data[0];
        return;
      case 0x4803:
      case 0x4c03:
        if (data.length === 1) values.battery = data[0];
        return;
      default:
        return;
    }
    if (data.length === 4) {
      const value = data.readFloatLE(0);
      if (Number.isFinite(value)) values[key] = value;
    }
  });
  return values;
}

function parseMjwsd05mmcAdvertisement(advertisement, bindkey = null) {
  const entry = findServiceData(advertisement, "fe95");
  const data = entry && toBuffer(entry.data);
  if (!data || data.length < 5 || !MJWSD05MMC_DEVICE_IDS.includes(data.readUInt16LE(2))) return null;
  return parseMiBeaconServiceData(data, advertisement.address, bindkey, {
    deviceType: "MJWSD05MMC",
    parseObjects: parseMjwsd05mmcObjects,
  });
}

module.exports = { MJWSD05MMC_DEVICE_IDS, parseMjwsd05mmcAdvertisement, parseMjwsd05mmcObjects };
