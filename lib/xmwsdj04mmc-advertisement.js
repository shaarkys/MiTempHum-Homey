"use strict";

const {
  forEachMiBeaconObject,
  parseMiBeaconAdvertisement,
  parseMiBeaconServiceData,
} = require("./mibeacon-advertisement");

const XMWSDJ04MMC_MIBEACON_DEVICE_ID = 0x1203;

function parseXmwsdj04mmcObjects(payload) {
  const values = {};

  forEachMiBeaconObject(payload, (objectType, objectData) => {
    let value;

    switch (objectType) {
      case 0x4c01:
      case 0x4801:
        if (objectData.length === 4) {
          value = objectData.readFloatLE(0);
          if (Number.isFinite(value)) values.temperature = value;
        }
        break;
      case 0x4c08:
        if (objectData.length === 4) {
          value = objectData.readFloatLE(0);
          if (Number.isFinite(value)) values.humidity = value;
        }
        break;
      case 0x4802:
      case 0x4c02:
        if (objectData.length === 1) values.humidity = objectData.readUInt8(0);
        break;
      case 0x4803:
      case 0x4c03:
        if (objectData.length === 1) values.battery = objectData.readUInt8(0);
        break;
      default:
        break;
    }
  });

  return values;
}

function parseXmwsdj04mmcMiBeaconServiceData(rawData, address, bindkey) {
  return parseMiBeaconServiceData(rawData, address, bindkey, {
    expectedDeviceId: XMWSDJ04MMC_MIBEACON_DEVICE_ID,
    deviceType: "XMWSDJ04MMC",
    parseObjects: parseXmwsdj04mmcObjects,
  });
}

function parseXmwsdj04mmcAdvertisement(advertisement, bindkey = null) {
  return parseMiBeaconAdvertisement(advertisement, bindkey, {
    expectedDeviceId: XMWSDJ04MMC_MIBEACON_DEVICE_ID,
    deviceType: "XMWSDJ04MMC",
    parseObjects: parseXmwsdj04mmcObjects,
  });
}

module.exports = {
  XMWSDJ04MMC_MIBEACON_DEVICE_ID,
  parseXmwsdj04mmcAdvertisement,
  parseXmwsdj04mmcMiBeaconServiceData,
  parseXmwsdj04mmcObjects,
};
