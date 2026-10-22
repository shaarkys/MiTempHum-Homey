"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP_ROOT = path.resolve(__dirname, "..");
const ZIGBEE_DRIVER_ID = "xiaomi-thermometer-zigbee";
const DRIVER_ROOT = path.join(APP_ROOT, "drivers", ZIGBEE_DRIVER_ID);
const firmwareCompose = JSON.parse(
  fs.readFileSync(path.join(DRIVER_ROOT, "driver.firmware.compose.json"), "utf8"),
);

test("generated app manifest includes the composed Zigbee firmware updates", () => {
  const appManifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "app.json"), "utf8"));
  const zigbeeDriver = appManifest.drivers.find(({ id }) => id === ZIGBEE_DRIVER_ID);

  assert.ok(zigbeeDriver, `Missing ${ZIGBEE_DRIVER_ID} in app.json`);
  assert.deepEqual(zigbeeDriver.firmwareUpdates, firmwareCompose);
});

test("packaged OTA files match their manifest metadata and Zigbee headers", () => {
  for (const update of firmwareCompose.updates) {
    for (const file of update.files) {
      const bytes = fs.readFileSync(path.join(DRIVER_ROOT, "assets", "firmware", file.name));
      assert.ok(bytes.length >= 56, `${file.name}: incomplete OTA header`);
      assert.equal(bytes.readUInt32LE(0), 0x0beef11e, `${file.name}: OTA magic`);
      assert.equal(bytes.readUInt16LE(4), 0x0100, `${file.name}: header version`);
      assert.ok(bytes.readUInt16LE(6) >= 56 && bytes.readUInt16LE(6) <= bytes.length);
      assert.equal(bytes.readUInt16LE(10), file.manufacturerCode, `${file.name}: manufacturer`);
      assert.equal(bytes.readUInt16LE(12), file.imageType, `${file.name}: image type`);
      assert.equal(bytes.readUInt32LE(14), file.fileVersion, `${file.name}: file version`);
      assert.equal(bytes.readUInt32LE(52), bytes.length, `${file.name}: OTA total size`);
      assert.equal(bytes.length, file.size, `${file.name}: manifest size`);
      assert.equal(`sha512:${createHash("sha512").update(bytes).digest("hex")}`, file.integrity,
        `${file.name}: SHA-512 integrity`);
    }
  }
});

test("LYWSD03MMC-z offers the verified 20983809 image with its own OTA identity", () => {
  const update = firmwareCompose.updates.find(({ device }) => device.productId.includes("LYWSD03MMC-z"));
  assert.equal(update.device.manufacturerName, "Xiaomi");
  assert.deepEqual(update.device.productId, ["LYWSD03MMC-z"]);
  assert.equal(update.files.length, 1);
  assert.deepEqual(update.files[0], {
    fileVersion: 20983809,
    imageType: 0x020a,
    manufacturerCode: 0x1141,
    size: 133922,
    name: "1141-020a-01403001-Z03MMC.zigbee",
    integrity: "sha512:2247834994fbc2f88a6cd7c593bd32af1015cee5ac70255f67d479272a5083dd392a3103fba4bb4dc1bc66f0a9759241e42bd55564d5565324b062ad6b7bec29",
  });
});

test("legacy devbis migration retains its version gates and separate image type", () => {
  const update = firmwareCompose.updates.find(({ device }) => device.productId.includes("LYWSD03MMC"));
  assert.equal(update.files.length, 2);
  for (const [index, sourceVersion] of [0x10063001, 0x11003001].entries()) {
    const file = update.files[index];
    assert.equal(file.manufacturerCode, [0x1141, 0xdb15][index]);
    assert.equal(file.imageType, 0x0203);
    assert.equal(file.fileVersion, 0x79993001);
    assert.equal(file.minFileVersion, sourceVersion);
    assert.equal(file.maxFileVersion, sourceVersion);
  }
});
