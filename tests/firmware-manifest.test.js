"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const APP_ROOT = path.resolve(__dirname, "..");
const ZIGBEE_DRIVER_ID = "xiaomi-thermometer-zigbee";

test("generated app manifest includes the composed Zigbee firmware updates", () => {
  const appManifest = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "app.json"), "utf8"));
  const firmwareCompose = JSON.parse(
    fs.readFileSync(
      path.join(APP_ROOT, "drivers", ZIGBEE_DRIVER_ID, "driver.firmware.compose.json"),
      "utf8",
    ),
  );
  const zigbeeDriver = appManifest.drivers.find(({ id }) => id === ZIGBEE_DRIVER_ID);

  assert.ok(zigbeeDriver, `Missing ${ZIGBEE_DRIVER_ID} in app.json`);
  assert.deepEqual(zigbeeDriver.firmwareUpdates, firmwareCompose);
});
