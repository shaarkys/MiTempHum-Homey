"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const {
  parseCgd1Advertisement,
  parseMiBeaconServiceData,
  parseQingpingServiceData,
} = require("../lib/cgd1-advertisement");

function createEncryptedMiBeaconFixture({ key, mac, plaintext }) {
  const header = Buffer.from("585876052c", "hex");
  const reversedMac = Buffer.from(mac.replace(/:/g, ""), "hex").reverse();
  const payloadCounter = Buffer.from("010000", "hex");
  const nonce = Buffer.concat([reversedMac, header.subarray(2, 5), payloadCounter]);
  const cipher = crypto.createCipheriv("aes-128-ccm", key, nonce, { authTagLength: 4 });
  cipher.setAAD(Buffer.from([0x11]), { plaintextLength: plaintext.length });
  const encryptedPayload = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, reversedMac, encryptedPayload, payloadCounter, cipher.getAuthTag()]);
}

test("parses a captured unencrypted Qingping CGD1 advertisement", () => {
  const parsed = parseQingpingServiceData("080cbf6552342d580104f100ad01020125");

  assert.equal(parsed.format, "qingping");
  assert.equal(parsed.deviceType, "CGD1");
  assert.equal(parsed.mac, "582d345265bf");
  assert.deepEqual(parsed.values, {
    temperature: 24.1,
    humidity: 42.9,
    battery: 37,
  });
});

test("parses an unencrypted MiBeacon CGD1 temperature and humidity object", () => {
  const parsed = parseMiBeaconServiceData(
    "50307605034c94b438c1a40d10041001ea01",
    "A4:C1:38:B4:94:4C",
  );

  assert.equal(parsed.format, "mibeacon");
  assert.equal(parsed.deviceId, 0x0576);
  assert.equal(parsed.encrypted, false);
  assert.deepEqual(parsed.values, {
    temperature: 27.2,
    humidity: 49,
  });
});

test("decrypts MiBeacon v5 CGD1 data with a 32-character bindkey", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const mac = "58:2D:34:52:65:BF";
  const plaintext = Buffer.from("0d1004f100ad010a100125", "hex");
  const data = createEncryptedMiBeaconFixture({ key, mac, plaintext });

  const parsed = parseMiBeaconServiceData(data, mac, key);

  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.bindkeyRequired, undefined);
  assert.deepEqual(parsed.values, {
    temperature: 24.1,
    humidity: 42.9,
    battery: 37,
  });
});

test("reports when encrypted CGD1 data needs a bindkey", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const mac = "58:2D:34:52:65:BF";
  const data = createEncryptedMiBeaconFixture({
    key,
    mac,
    plaintext: Buffer.from("0d1004f100ad01", "hex"),
  });

  const parsed = parseMiBeaconServiceData(data, mac);

  assert.equal(parsed.bindkeyRequired, true);
  assert.equal(parsed.decryptionFailed, undefined);
  assert.deepEqual(parsed.values, {});
});

test("keeps the CGD1 MiBeacon wrapper strict to the CGD1 product ID", () => {
  const parsed = parseMiBeaconServiceData(
    "48590312a41b776e7c96add7000000f2bf545b",
    "2C:11:65:25:70:04",
    Buffer.from("b2cf9a553d53571b5657defd582d676e", "hex"),
  );

  assert.equal(parsed, null);
});

test("prefers unencrypted Qingping service data when both formats are present", () => {
  const parsed = parseCgd1Advertisement({
    address: "58:2D:34:52:65:BF",
    serviceData: [
      {
        uuid: "0000fe95-0000-1000-8000-00805f9b34fb",
        data: Buffer.from("50307605034c94b438c1a40d10041001ea01", "hex"),
      },
      {
        uuid: "0000fdcd-0000-1000-8000-00805f9b34fb",
        data: Buffer.from("080cbf6552342d580104f100ad01020125", "hex"),
      },
    ],
  });

  assert.equal(parsed.format, "qingping");
  assert.equal(parsed.values.battery, 37);
});

test("prefers a complete captured FDCD frame over encrypted FE95 without a bindkey", () => {
  const mac = "02:00:00:12:34:56";
  const parsed = parseCgd1Advertisement({
    address: mac,
    serviceData: [
      {
        uuid: "0000fe95-0000-1000-8000-00805f9b34fb",
        data: Buffer.from("585876052c563412000002eb0d197d69ef73e86b1ae58e010000a39228c4", "hex"),
      },
      {
        uuid: "0000fdcd-0000-1000-8000-00805f9b34fb",
        data: Buffer.from("080c563412000002010422010d02020126", "hex"),
      },
    ],
  });

  assert.equal(parsed.format, "qingping");
  assert.deepEqual(parsed.values, {
    temperature: 29,
    humidity: 52.5,
    battery: 38,
  });
});

test("changing a valid bindkey retains an existing warning until valid sensor data arrives", async () => {
  const devicePath = require.resolve("../drivers/qingping-cgd1/device");
  const originalModuleLoad = Module._load;
  let QingpingCgd1Device;

  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "homey") {
        return { Device: class StubDevice {} };
      }
      return originalModuleLoad.call(this, request, parent, isMain);
    };
    QingpingCgd1Device = require(devicePath);
  } finally {
    Module._load = originalModuleLoad;
    delete require.cache[devicePath];
  }

  const warningCalls = [];
  let pollCalled = false;
  const device = Object.create(QingpingCgd1Device.prototype);
  device.warningState = "Encrypted CGD1 data requires a bindkey.";
  device.setWarning = async (value) => warningCalls.push(value);
  device.pollAdvertisement = async () => {
    pollCalled = true;
  };

  await device.onSettings({
    newSettings: { bindkey: "00112233445566778899aabbccddeeff" },
    changedKeys: ["bindkey"],
  });

  assert.equal(pollCalled, true);
  assert.equal(device.bindkey.toString("hex"), "00112233445566778899aabbccddeeff");
  assert.deepEqual(warningCalls, []);
  assert.equal(device.warningState, "Encrypted CGD1 data requires a bindkey.");
});

test("generated app manifest exposes the CGD1 driver and optional bindkey", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "app.json"), "utf8"));
  const driver = manifest.drivers.find(({ id }) => id === "qingping-cgd1");

  assert.ok(driver, "Missing qingping-cgd1 in app.json");
  assert.deepEqual(driver.capabilities, [
    "measure_temperature",
    "measure_humidity",
    "measure_battery",
    "measure_rssi",
  ]);
  assert.deepEqual(driver.energy.batteries, ["AA", "AA"]);
  assert.ok(driver.settings.some(({ id }) => id === "bindkey"));
});
