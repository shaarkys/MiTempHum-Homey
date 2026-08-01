"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
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
