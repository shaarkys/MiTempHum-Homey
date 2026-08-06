"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const {
  XMWSDJ04MMC_MIBEACON_DEVICE_ID,
  parseXmwsdj04mmcAdvertisement,
  parseXmwsdj04mmcMiBeaconServiceData,
  parseXmwsdj04mmcObjects,
} = require("../lib/xmwsdj04mmc-advertisement");

const ADDRESS = "2C:11:65:25:70:04";
const BINDKEY = "b2cf9a553d53571b5657defd582d676e";
const ENCRYPTED_HUMIDITY_FIXTURE = "48590312a41b776e7c96add7000000f2bf545b";

function loadHomeyModule(relativePath) {
  const modulePath = require.resolve(relativePath);
  const originalModuleLoad = Module._load;

  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "homey") {
        return {
          Device: class StubDevice {},
          Driver: class StubDriver {},
        };
      }
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalModuleLoad;
    delete require.cache[modulePath];
  }
}

function createAdvertisementLifecycleDevice(DeviceClass, homey) {
  const device = Object.create(DeviceClass.prototype);
  device.homey = homey;
  device.advertisementSubscriptionActive = false;
  device.capabilityWriteErrorStates = new Map();
  device.getStore = () => ({ peripheralUuid: "xmwsdj04mmc-peripheral" });
  device.getData = () => ({ id: "xmwsdj04mmc-peripheral" });
  device.log = () => {};
  device.error = () => {};
  return device;
}

test("decrypts the published XMWSDJ04MMC MiBeacon v5 humidity fixture", () => {
  const parsed = parseXmwsdj04mmcMiBeaconServiceData(
    ENCRYPTED_HUMIDITY_FIXTURE,
    ADDRESS,
    Buffer.from(BINDKEY, "hex"),
  );

  assert.equal(parsed.format, "mibeacon");
  assert.equal(parsed.serviceUuid, "fe95");
  assert.equal(parsed.deviceId, XMWSDJ04MMC_MIBEACON_DEVICE_ID);
  assert.equal(parsed.deviceType, "XMWSDJ04MMC");
  assert.equal(parsed.version, 5);
  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.rawHex, ENCRYPTED_HUMIDITY_FIXTURE);
  assert.equal(parsed.payloadHex, "084c0400003442");
  assert.deepEqual(parsed.values, { humidity: 45 });
});

test("parses XMWSDJ04MMC temperature, humidity, and battery object forms", () => {
  const parsed = parseXmwsdj04mmcMiBeaconServiceData(
    "503003120104702565112c014c040000a041084c040000344203480158",
    ADDRESS,
  );

  assert.equal(parsed.encrypted, false);
  assert.deepEqual(parsed.values, {
    temperature: 20,
    humidity: 45,
    battery: 88,
  });

  assert.deepEqual(
    parseXmwsdj04mmcObjects(Buffer.from(
      "014c040000a041084c0400003442034801580148040000a8410248012e024c012f034c0159",
      "hex",
    )),
    {
      temperature: 21,
      humidity: 47,
      battery: 89,
    },
  );
  assert.deepEqual(parseXmwsdj04mmcObjects(Buffer.from("014c030000a0", "hex")), {});
});

test("accepts only XMWSDJ04MMC FE95 payloads", () => {
  const advertisement = {
    address: ADDRESS,
    serviceData: [
      {
        uuid: "0000fe95-0000-1000-8000-00805f9b34fb",
        data: Buffer.from(ENCRYPTED_HUMIDITY_FIXTURE, "hex"),
      },
    ],
  };

  assert.equal(parseXmwsdj04mmcAdvertisement(advertisement).bindkeyRequired, true);
  assert.equal(
    parseXmwsdj04mmcMiBeaconServiceData(
      "50307605034c94b438c1a40d10041001ea01",
      ADDRESS,
    ),
    null,
  );
});

test("pairs a non-connectable XMWSDJ04MMC advertisement without a bindkey", async () => {
  const XiaomiXmwsdj04mmcDriver = loadHomeyModule("../drivers/xiaomi-xmwsdj04mmc/driver");
  const logs = [];
  const driver = Object.create(XiaomiXmwsdj04mmcDriver.prototype);
  driver.log = (message) => logs.push(message);
  driver.homey = {
    ble: {
      discover: async () => [
        {
          address: ADDRESS,
          uuid: "xmwsdj04mmc-peripheral",
          localName: "Mijia",
          connectable: false,
          rssi: -61,
          serviceData: [
            {
              uuid: "fe95",
              data: Buffer.from(ENCRYPTED_HUMIDITY_FIXTURE, "hex"),
            },
          ],
        },
        {
          address: "58:2D:34:52:65:BF",
          uuid: "cgd1-peripheral",
          serviceData: [
            {
              uuid: "fe95",
              data: Buffer.from("50307605034c94b438c1a40d10041001ea01", "hex"),
            },
          ],
        },
      ],
    },
  };

  const devices = await driver.onPairListDevices();

  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0].data, { id: "xmwsdj04mmc-peripheral" });
  assert.deepEqual(devices[0].store, {
    address: ADDRESS,
    peripheralUuid: "xmwsdj04mmc-peripheral",
  });
  assert.ok(logs.some((message) => message.includes("press the device button")));
});

test("updates only values present in an encrypted partial XMWSDJ04MMC frame", async () => {
  const XiaomiXmwsdj04mmcDevice = loadHomeyModule("../drivers/xiaomi-xmwsdj04mmc/device");
  const capabilityValues = {
    measure_temperature: 19.4,
    measure_humidity: 40,
    measure_battery: 70,
    measure_rssi: -65,
  };
  const writes = [];
  const warnings = [];
  const device = Object.create(XiaomiXmwsdj04mmcDevice.prototype);
  device.temperatureOffset = 0;
  device.bindkey = Buffer.from(BINDKEY, "hex");
  device.warningState = "XMWSDJ04MMC is sending encrypted MiBeacon data.";
  device.firstSuccessfulAdvertisementLogged = false;
  device.lastBatteryWriteAt = null;
  device.capabilityWriteErrorStates = new Map();
  device.getStore = () => ({
    address: ADDRESS,
    peripheralUuid: "xmwsdj04mmc-peripheral",
  });
  device.getData = () => ({ id: "xmwsdj04mmc-peripheral" });
  device.getCapabilityValue = (capabilityId) => capabilityValues[capabilityId];
  device.setCapabilityValue = async (capabilityId, value) => {
    writes.push({ capabilityId, value });
    capabilityValues[capabilityId] = value;
  };
  device.setWarning = async (message) => warnings.push(message);
  device.log = () => {};
  device.error = () => {};

  await device.processAdvertisement({
    address: ADDRESS,
    rssi: -61,
    serviceData: [
      {
        uuid: "fe95",
        data: Buffer.from(ENCRYPTED_HUMIDITY_FIXTURE, "hex"),
      },
    ],
  });

  assert.equal(capabilityValues.measure_temperature, 19.4);
  assert.equal(capabilityValues.measure_humidity, 45);
  assert.equal(capabilityValues.measure_battery, 70);
  assert.equal(capabilityValues.measure_rssi, -61);
  assert.deepEqual(
    writes.map(({ capabilityId }) => capabilityId),
    ["measure_rssi", "measure_humidity"],
  );
  assert.deepEqual(warnings, [null]);
});

test("subscribes to XMWSDJ04MMC advertisements with the Homey rate limit contract", async () => {
  const XiaomiXmwsdj04mmcDevice = loadHomeyModule("../drivers/xiaomi-xmwsdj04mmc/device");
  const subscriptionCalls = [];
  let intervalCalls = 0;
  const device = createAdvertisementLifecycleDevice(XiaomiXmwsdj04mmcDevice, {
    hasFeature: (feature) => feature === "ble-advertisements",
    ble: {
      subscribeToAdvertisements: async (...args) => subscriptionCalls.push(args),
      unsubscribeFromAdvertisements: async () => {},
    },
    setInterval: () => {
      intervalCalls += 1;
      return "unexpected-interval";
    },
  });

  await device.startAdvertisementUpdates();

  assert.equal(device.advertisementSubscriptionActive, true);
  assert.equal(subscriptionCalls.length, 1);
  assert.equal(subscriptionCalls[0][0], "xmwsdj04mmc-peripheral");
  assert.deepEqual(subscriptionCalls[0][1], { rateLimitMs: 5000 });
  assert.equal(typeof subscriptionCalls[0][2], "function");
  assert.equal(intervalCalls, 0);
  assert.equal(device.pollInterval, undefined);
});

test("uses the immediate one-minute polling fallback when subscription fails", async () => {
  const XiaomiXmwsdj04mmcDevice = loadHomeyModule("../drivers/xiaomi-xmwsdj04mmc/device");
  const intervalCalls = [];
  let immediatePollCalls = 0;
  const device = createAdvertisementLifecycleDevice(XiaomiXmwsdj04mmcDevice, {
    hasFeature: (feature) => feature === "ble-advertisements",
    ble: {
      subscribeToAdvertisements: async () => {
        throw new Error("subscription unavailable");
      },
      unsubscribeFromAdvertisements: async () => {},
    },
    setInterval: (callback, interval) => {
      intervalCalls.push({ callback, interval });
      return "fallback-interval";
    },
  });
  device.pollAdvertisement = async () => {
    immediatePollCalls += 1;
  };

  await device.startAdvertisementUpdates();
  await device.startAdvertisementUpdates();

  assert.equal(immediatePollCalls, 2);
  assert.equal(intervalCalls.length, 1);
  assert.equal(intervalCalls[0].interval, 60000);
  assert.equal(typeof intervalCalls[0].callback, "function");
  assert.equal(device.pollInterval, "fallback-interval");
});

test("cleans up an XMWSDJ04MMC advertisement subscription only once", async () => {
  const XiaomiXmwsdj04mmcDevice = loadHomeyModule("../drivers/xiaomi-xmwsdj04mmc/device");
  const unsubscribedUuids = [];
  const device = createAdvertisementLifecycleDevice(XiaomiXmwsdj04mmcDevice, {
    hasFeature: (feature) => feature === "ble-advertisements",
    ble: {
      subscribeToAdvertisements: async () => {},
      unsubscribeFromAdvertisements: async (uuid) => unsubscribedUuids.push(uuid),
    },
    clearInterval: () => {},
  });
  device.advertisementSubscriptionActive = true;

  await device.stopAdvertisementUpdates();
  await device.stopAdvertisementUpdates();

  assert.deepEqual(unsubscribedUuids, ["xmwsdj04mmc-peripheral"]);
  assert.equal(device.advertisementSubscriptionActive, false);
});

test("validates XMWSDJ04MMC bindkeys and Compose metadata", async () => {
  const XiaomiXmwsdj04mmcDevice = loadHomeyModule("../drivers/xiaomi-xmwsdj04mmc/device");
  const device = Object.create(XiaomiXmwsdj04mmcDevice.prototype);
  device.pollAdvertisement = async () => {};

  assert.equal(device.getBindkeyBuffer(BINDKEY).toString("hex"), BINDKEY);
  assert.equal(device.getBindkeyBuffer("abcd"), null);
  await assert.rejects(
    device.onSettings({
      newSettings: { bindkey: "abcd" },
      changedKeys: ["bindkey"],
    }),
    /exactly 32 hexadecimal characters/,
  );

  const driver = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "drivers", "xiaomi-xmwsdj04mmc", "driver.compose.json"),
    "utf8",
  ));
  const settings = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "..", "drivers", "xiaomi-xmwsdj04mmc", "driver.settings.compose.json"),
    "utf8",
  ));
  assert.deepEqual(driver.capabilities, [
    "measure_temperature",
    "measure_humidity",
    "measure_battery",
    "measure_rssi",
  ]);
  assert.deepEqual(driver.energy.batteries, ["CR2450"]);
  assert.deepEqual(settings.map(({ id }) => id), ["temperature_offset", "bindkey"]);
  const bindkeySetting = settings.find(({ id }) => id === "bindkey");
  assert.match(bindkeySetting.hint.en, /32-character hexadecimal BLE bindkey is required/i);
  assert.match(bindkeySetting.hint.en, /can remain empty for pairing/i);
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "..", "drivers", "xiaomi-xmwsdj04mmc", "assets", "icon.svg")),
    true,
  );
});
