"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { parseMjwsd05mmcAdvertisement, parseMjwsd05mmcObjects } = require("../lib/mjwsd05mmc-advertisement");
const { parseXmwsdj04mmcAdvertisement } = require("../lib/xmwsdj04mmc-advertisement");

// Synthetic key/address only; fixtures below exercise AES-CCM and both hardware IDs.
const KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const ADDRESS = "A4:C1:38:11:22:33";
const UUID = "sensor-3";

function advertisement(productId = 0x4c47, payload = "0148040000b8410848040000484203480158", macIncluded = false) {
  const header = Buffer.alloc(5);
  header.writeUInt16LE(macIncluded ? 0x5958 : 0x5948, 0);
  header.writeUInt16LE(productId, 2);
  header[4] = 0x0a;
  const mac = Buffer.from("33221138c1a4", "hex");
  const counter = Buffer.from("080000", "hex");
  const plaintext = Buffer.from(payload, "hex");
  const nonce = Buffer.concat([mac, header.subarray(2), counter]);
  const cipher = crypto.createCipheriv("aes-128-ccm", KEY, nonce, { authTagLength: 4 });
  cipher.setAAD(Buffer.from([0x11]), { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    address: ADDRESS,
    uuid: UUID,
    localName: "Unrelated advertised name",
    connectable: false,
    rssi: -61,
    serviceData: [{
      uuid: "0000fe95-0000-1000-8000-00805f9b34fb",
      data: Buffer.concat([header, ...(macIncluded ? [mac] : []), ciphertext, counter, cipher.getAuthTag()]),
    }],
  };
}

function loadHomeyModule(relativePath) {
  const modulePath = require.resolve(relativePath);
  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "homey") return { Device: class {}, Driver: class {} };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createDevice(ble = {}) {
  const DeviceClass = loadHomeyModule("../drivers/xiaomi-mjwsd05mmc/device");
  const device = new DeviceClass();
  const values = { measure_temperature: 19, measure_humidity: 40, measure_battery: 70 };
  const writes = [];
  const warnings = [];
  const logs = [];
  const intervals = new Map();
  const translations = require("../locales/en.json").mjwsd05mmc;
  device.homey = {
    hasFeature: () => true,
    __: (key) => translations[key.split(".")[1]],
    ble: {
      find: async () => advertisement(),
      subscribeToAdvertisements: async () => {},
      unsubscribeFromAdvertisements: async () => {},
      ...ble,
    },
    setInterval: (callback, ms) => { const id = {}; intervals.set(id, { callback, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
  };
  device.getSetting = (id) => id === "bindkey" ? KEY.toString("hex") : 0;
  device.getStore = () => ({ address: ADDRESS, peripheralUuid: UUID });
  device.getData = () => ({ id: UUID });
  device.getCapabilityValue = (id) => values[id];
  device.setCapabilityValue = async (id, value) => { values[id] = value; writes.push([id, value]); };
  device.setWarning = async (warning) => warnings.push(warning);
  device.log = (...args) => logs.push(args.join(" "));
  device.error = device.log;
  return { device, values, writes, warnings, logs, intervals };
}

for (const productId of [0x2832, 0x4c47]) {
  test("decrypts temperature, float humidity and battery for product " + productId.toString(16), () => {
    for (const macIncluded of [false, true]) {
      const sample = advertisement(productId, undefined, macIncluded);
      if (macIncluded) delete sample.address;
      const result = parseMjwsd05mmcAdvertisement(sample, KEY);
      assert.equal(result.deviceId, productId);
      assert.equal(result.version, 5);
      assert.deepEqual(result.values, { temperature: 23, humidity: 50, battery: 88 });
      assert.equal(parseXmwsdj04mmcAdvertisement(sample, KEY), null);
    }
  });
}

test("recognises the upstream captured newer-revision packet without requiring its private key", () => {
  // https://github.com/Bluetooth-Devices/xiaomi-ble/pull/336 (no decryption claim for this capture).
  const result = parseMjwsd05mmcAdvertisement({ serviceData: [{ uuid: "fe95", data: "4859474c0a7c85cacdaae56e080000cebdaa3d" }] });
  assert.equal(result.deviceId, 0x4c47);
  assert.equal(result.version, 5);
  assert.equal(result.bindkeyRequired, true);
});

test("handles missing/wrong keys, tampered packets and missing nonce addresses without producing measurements", () => {
  const sample = advertisement();
  assert.equal(parseMjwsd05mmcAdvertisement(sample).bindkeyRequired, true);
  assert.equal(parseMjwsd05mmcAdvertisement(sample, Buffer.alloc(16)).decryptionFailed, true);
  sample.serviceData[0].data[6] ^= 1;
  assert.deepEqual(parseMjwsd05mmcAdvertisement(sample, KEY).values, {});
  const missingAddress = advertisement();
  delete missingAddress.address;
  assert.equal(parseMjwsd05mmcAdvertisement(missingAddress, KEY).decryptionFailed, true);
});

test("ignores other models, non-FE95, short and malformed payloads", () => {
  assert.equal(parseMjwsd05mmcAdvertisement(advertisement(0x1203), KEY), null);
  assert.equal(parseMjwsd05mmcAdvertisement(null), null);
  assert.equal(parseMjwsd05mmcAdvertisement({ serviceData: [{ uuid: "181a", data: "4859474c0a" }] }), null);
  for (const data of ["", "4859474c", "zz", Buffer.alloc(0), {}]) {
    assert.equal(parseMjwsd05mmcAdvertisement({ serviceData: [{ uuid: "fe95", data }] }), null);
  }
  assert.deepEqual(parseMjwsd05mmcObjects(Buffer.from("014803000000", "hex")), {});
  assert.deepEqual(parseMjwsd05mmcObjects(Buffer.from("0148040000c07f0848040000807f", "hex")), {});
});

test("decodes standard and alternate MiBeacon object encodings", () => {
  assert.deepEqual(parseMjwsd05mmcObjects(Buffer.from("0d1004e600f4010a100158", "hex")), {
    temperature: 23, humidity: 50, battery: 88,
  });
  for (const payload of ["014c040000b841084c0400004842034c0158", "0148040000b8410248013203480158", "014c040000b841024c0132034c0158"]) {
    assert.deepEqual(parseMjwsd05mmcObjects(Buffer.from(payload, "hex")), { temperature: 23, humidity: 50, battery: 88 });
  }
});

test("discovers both IDs without keys, deduplicates and excludes the existing model", async () => {
  const DriverClass = loadHomeyModule("../drivers/xiaomi-mjwsd05mmc/driver");
  const driver = new DriverClass();
  const logs = [];
  driver.log = (message) => logs.push(message);
  const older = { ...advertisement(0x2832), uuid: "older" };
  driver.homey = { ble: { discover: async (...args) => {
    assert.equal(args.length, 0);
    return [older, advertisement(), advertisement(), advertisement(0x1203)];
  } } };
  const devices = await driver.onPairListDevices();
  assert.deepEqual(devices.map((item) => item.data.id), ["older", UUID]);
  assert.deepEqual(devices[1].store, { address: ADDRESS, peripheralUuid: UUID });
  assert.ok(logs.some((line) => line.includes("4 advertisement(s), 2 matching")));
});

test("applies partial encrypted readings, stored MAC fallback and offset without overwriting absent values", async () => {
  const { device, values, writes, logs } = createDevice();
  await device.onInit();
  device.temperatureOffset = 1.5;
  const sample = advertisement(0x4c47, "0148040000b841");
  delete sample.address;
  await device.queueAdvertisement(sample);
  assert.equal(values.measure_temperature, 24.5);
  assert.equal(values.measure_humidity, 40);
  assert.equal(values.measure_battery, 70);
  assert.equal(values.measure_rssi, -61);
  const count = writes.length;
  await device.queueAdvertisement(sample);
  assert.equal(writes.length, count);
  await device.queueAdvertisement({ ...advertisement(), uuid: "other", address: "11:22:33:44:55:66" });
  assert.equal(writes.length, count);
  assert.equal(logs.filter((line) => line.includes("first valid")).length, 1);
  await device.onUninit();
});

test("reports missing/wrong keys, validates settings, recovers with the correct key and never logs it", async () => {
  const { device, values, warnings, logs } = createDevice();
  device.getSetting = () => "";
  await device.onInit();
  await device.queueAdvertisement(advertisement());
  assert.match(warnings.at(-1), /Enter.*bindkey/);
  assert.equal(values.measure_temperature, 19);
  await assert.rejects(device.onSettings({ newSettings: { bindkey: "abcd" }, changedKeys: ["bindkey"] }), /32 hexadecimal/);
  await device.onSettings({ newSettings: { bindkey: "00".repeat(16) }, changedKeys: ["bindkey"] });
  assert.match(warnings.at(-1), /decryption failed/);
  assert.equal(values.measure_temperature, 19);
  await device.onSettings({ newSettings: { bindkey: " " + KEY.toString("hex").toUpperCase() + " ", temperature_offset: -1 }, changedKeys: ["bindkey", "temperature_offset"] });
  assert.equal(values.measure_temperature, 22);
  assert.equal(values.measure_humidity, 50);
  assert.equal(warnings.at(-1), null);
  assert.ok(!logs.join("\n").includes(KEY.toString("hex")));
  await device.onUninit();
});

test("does not apply invalid readings and retries failed capability writes on later packets", async () => {
  const { device, values, logs } = createDevice();
  await device.onInit();
  await device.queueAdvertisement(advertisement(0x4c47, "014804000080bf024801ff034801ff"));
  assert.equal(values.measure_temperature, 19);
  assert.equal(values.measure_humidity, 40);
  assert.equal(values.measure_battery, 70);
  const original = device.setCapabilityValue;
  device.setCapabilityValue = async (id, value) => {
    if (id === "measure_temperature") throw new Error("temporary write failure");
    return original(id, value);
  };
  await device.queueAdvertisement(advertisement());
  await device.queueAdvertisement(advertisement());
  assert.equal(logs.filter((line) => line.includes("temporary write failure")).length, 1);
  device.setCapabilityValue = original;
  await device.queueAdvertisement(advertisement());
  assert.equal(values.measure_temperature, 23);
  await device.onUninit();
});

test("subscription uses the SDK contract and is removed once on deletion, including pending startup", async () => {
  const pending = deferred();
  let callback;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const { device, writes, intervals } = createDevice({
    subscribeToAdvertisements: async (uuid, options, handler) => {
      subscriptions += 1;
      assert.equal(uuid, UUID);
      assert.deepEqual(options, { rateLimitMs: 5000 });
      callback = handler;
      await pending.promise;
    },
    unsubscribeFromAdvertisements: async () => { unsubscriptions += 1; },
  });
  const init = device.onInit();
  await new Promise(setImmediate);
  const duplicateStart = device.startAdvertisementUpdates();
  const stop = device.onDeleted();
  pending.resolve();
  await Promise.all([init, duplicateStart, stop]);
  await callback(advertisement());
  await device.onUninit();
  assert.equal(subscriptions, 1);
  assert.equal(unsubscriptions, 1);
  assert.equal(intervals.size, 0);
  assert.equal(writes.length, 0);
});

test("fallback has one timer, serialises polling and drops packets arriving after shutdown", async () => {
  const pending = deferred();
  let finds = 0;
  const { device, writes, intervals } = createDevice({
    subscribeToAdvertisements: async () => { throw new Error("subscription unavailable"); },
    find: async () => { finds += 1; return finds === 1 ? advertisement() : pending.promise; },
  });
  await device.onInit();
  await device.startAdvertisementUpdates();
  assert.equal(intervals.size, 1);
  assert.equal([...intervals.values()][0].ms, 60000);
  const poll = device.pollAdvertisement();
  assert.equal(device.pollAdvertisement(), poll);
  assert.equal(finds, 2);
  const writeCount = writes.length;
  const stop = device.onUninit();
  pending.resolve(advertisement(0x4c47, "0148040000c841"));
  await Promise.all([poll, stop]);
  assert.equal(intervals.size, 0);
  assert.equal(writes.length, writeCount);
});

test("reinitialisation replaces subscriptions and supports feature-unavailable fallback", async () => {
  let subscribed = 0;
  let unsubscribed = 0;
  const { device, intervals } = createDevice({
    subscribeToAdvertisements: async () => { subscribed += 1; },
    unsubscribeFromAdvertisements: async () => { unsubscribed += 1; },
  });
  await device.onInit();
  await device.onInit();
  assert.equal(subscribed, 2);
  assert.equal(unsubscribed, 1);
  device.homey.hasFeature = () => false;
  await device.onInit();
  assert.equal(unsubscribed, 2);
  assert.equal(intervals.size, 1);
  await device.onUninit();
  assert.equal(intervals.size, 0);
});

test("Compose exposes the intended capabilities, settings and battery; all warnings are translated", () => {
  const root = path.join(__dirname, "..", "drivers", "xiaomi-mjwsd05mmc");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "driver.compose.json"), "utf8"));
  assert.deepEqual(manifest.capabilities, ["measure_temperature", "measure_humidity", "measure_battery", "measure_rssi"]);
  assert.deepEqual(manifest.energy.batteries, ["CR2450"]);
  const settings = JSON.parse(fs.readFileSync(path.join(root, "driver.settings.compose.json"), "utf8"));
  assert.deepEqual(settings.map(({ id }) => id), ["temperature_offset", "bindkey"]);
  for (const key of ["bindkey_required", "decryption_failed", "unsupported_encryption", "invalid_bindkey"]) {
    assert.equal(typeof require("../locales/en.json").mjwsd05mmc[key], "string");
  }
});
