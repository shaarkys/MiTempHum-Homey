"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const test = require("node:test");

const ADDRESS = "A4:C1:38:E7:27:B2";
const UUID = "a4c138e727b2";
const SERVICE_UUID = "0000181a-0000-1000-8000-00805f9b34fb";

function loadHomeyModule(path) {
  const modulePath = require.resolve(path);
  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "homey") return { Device: EventEmitter, Driver: EventEmitter };
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[modulePath];
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
}

function advertisement(address = ADDRESS) {
  return {
    address,
    uuid: UUID,
    localName: "ATC_E727B2",
    serviceData: [{ uuid: SERVICE_UUID, data: Buffer.from("a4c138e727b200e927420af5ee", "hex") }],
  };
}

function createDevice(bleOverrides = {}) {
  const DeviceClass = loadHomeyModule("../drivers/xiaomi-thermometer-ble/device");
  const device = new DeviceClass();
  const intervals = new Map();
  const writes = [];
  const unsubscriptions = [];
  let callback;
  let pollingCalls = 0;
  device.homey = {
    hasFeature: () => true,
    ble: {
      subscribeToAdvertisements: async (uuid, options, handler) => { callback = handler; },
      unsubscribeFromAdvertisements: async (uuid) => { unsubscriptions.push(uuid); },
      ...bleOverrides,
    },
    setInterval: (fn, ms) => { const id = {}; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
  };
  device.driver = { managePolling: () => { pollingCalls += 1; } };
  device.getData = () => ({ id: ADDRESS });
  device.getStore = () => ({ peripheralUuid: UUID });
  device.getName = () => "ATC test";
  device.getSetting = () => 0;
  device.getAvailable = () => true;
  device.setCapabilityValue = async (id, value) => { writes.push([id, value]); };
  device.log = () => {};
  device.error = () => {};
  return {
    device, intervals, writes, unsubscriptions,
    get callback() { return callback; },
    get pollingCalls() { return pollingCalls; },
  };
}

test("silent ATC subscription falls back to discovery polling without a restart", async () => {
  const state = createDevice();
  await state.device.onInit();
  assert.equal(state.device.isUsingAdvertisementSubscription(), true);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.pollingCalls, 1);

  await state.device.checkAdvertisementFreshness(state.device.lastAdvertisementAt + 5 * 60 * 1000 - 1);
  assert.equal(state.device.isUsingAdvertisementSubscription(), true);

  await state.device.checkAdvertisementFreshness(state.device.lastAdvertisementAt + 5 * 60 * 1000);
  assert.equal(state.device.isUsingAdvertisementSubscription(), false);
  assert.deepEqual(state.unsubscriptions, [UUID]);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.pollingCalls, 2);

  state.callback(advertisement());
  assert.deepEqual(state.writes, []);
  await state.device.onUninit();
  assert.deepEqual(state.unsubscriptions, [UUID]);
});

test("valid callback without address updates values and refreshes subscription liveness", async () => {
  const state = createDevice();
  await state.device.onInit();
  state.device.lastAdvertisementAt -= 5 * 60 * 1000;
  const previousTime = state.device.lastAdvertisementAt;
  state.callback(advertisement(null));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(state.writes, [
    ["measure_temperature", 23.3],
    ["measure_humidity", 39],
    ["measure_battery", 66],
  ]);
  assert.ok(state.device.lastAdvertisementAt > previousTime);
  await state.device.checkAdvertisementFreshness(state.device.lastAdvertisementAt + 5 * 60 * 1000 - 1);
  assert.equal(state.device.isUsingAdvertisementSubscription(), true);
  await state.device.onUninit();
});

test("subscription failure retains discovery polling", async () => {
  const state = createDevice({ subscribeToAdvertisements: async () => { throw new Error("BLE unavailable"); } });
  await state.device.onInit();
  assert.equal(state.device.isUsingAdvertisementSubscription(), false);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.pollingCalls, 1);
});

test("reinitialization replaces one subscription and watchdog", async () => {
  const state = createDevice();
  await state.device.onInit();
  await state.device.onInit();
  assert.deepEqual(state.unsubscriptions, [UUID]);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.device.listenerCount("updateTag"), 1);
  await state.device.onUninit();
  assert.deepEqual(state.unsubscriptions, [UUID, UUID]);
  assert.equal(state.intervals.size, 0);
  assert.equal(state.device.listenerCount("updateTag"), 0);
});

test("polling transition never starts a second concurrent scan loop", async () => {
  const DriverClass = loadHomeyModule("../drivers/xiaomi-thermometer-ble/driver");
  const driver = new DriverClass();
  let resolvePoll;
  let starts = 0;
  let subscribed = false;
  driver.getDevices = () => [{ isUsingAdvertisementSubscription: () => subscribed }];
  driver.pollDevice = () => {
    starts += 1;
    return new Promise((resolve) => { resolvePoll = resolve; });
  };
  driver.log = () => {};
  driver.managePolling();
  assert.equal(starts, 1);
  subscribed = true;
  driver.managePolling();
  subscribed = false;
  driver.managePolling();
  assert.equal(starts, 1);
  driver.polling = false;
  resolvePoll();
  await driver.pollTask;
});
