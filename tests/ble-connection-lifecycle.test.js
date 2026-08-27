"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function loadHomeyModule(relativePath) {
  const modulePath = require.resolve(relativePath);
  const originalModuleLoad = Module._load;

  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "homey") {
        return { Device: class StubDevice {} };
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createBle2Device(DeviceClass, homey) {
  const device = Object.create(DeviceClass.prototype);
  Object.assign(device, {
    homey,
    reconnectInterval: 300,
    advertisementSubscriptionActive: true,
    peripheral: null,
    notificationCharacteristic: null,
    connectionOperation: null,
    reconnectTimeout: null,
    notificationWatchdogTimeout: null,
    lastNotificationAt: null,
    lastTempHumidityData: null,
    shuttingDown: false,
    temperatureOffset: 0,
  });
  device.getStore = () => ({ peripheralUuid: "ble2-peripheral", address: "AA:BB:CC:DD:EE:FF" });
  device.getData = () => ({ id: "AA:BB:CC:DD:EE:FF" });
  device.log = () => {};
  device.error = () => {};
  device.setWarning = async () => {};
  device.setCapabilityValue = async () => {};
  device.processAdvertisementUpdate = async () => {};
  device.shouldSkipActiveConnection = async () => false;
  device.updateTag = async () => {};
  device.readFirmwareVersion = async () => {};
  device.readBatteryLevel = async () => {};
  return device;
}

function createBle2Connection(id) {
  let disconnectListener;
  const calls = {
    disconnect: 0,
    subscribe: 0,
    unsubscribe: 0,
  };
  const notificationCharacteristic = {
    subscribeToNotifications: async (callback) => {
      calls.subscribe += 1;
      calls.notificationCallback = callback;
    },
    unsubscribeFromNotifications: async () => {
      calls.unsubscribe += 1;
    },
  };
  const batteryCharacteristic = {
    read: async () => Buffer.from([78]),
  };
  const peripheral = {
    id,
    isConnected: true,
    once: (event, callback) => {
      if (event === "disconnect") disconnectListener = callback;
    },
    getService: async (uuid) => ({
      getCharacteristic: async () => (
        uuid === "0000180f00001000800000805f9b34fb"
          ? batteryCharacteristic
          : notificationCharacteristic
      ),
    }),
    disconnect: async () => {
      calls.disconnect += 1;
      peripheral.isConnected = false;
    },
  };
  return {
    calls,
    notificationCharacteristic,
    peripheral,
    emitDisconnect: () => disconnectListener && disconnectListener(),
  };
}

test("BLE2 coalesces concurrent connection requests and keeps one healthy subscription", async () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  const connection = createBle2Connection("ble2-1");
  let connectCalls = 0;
  let releaseEnable;
  const enablePending = new Promise((resolve) => {
    releaseEnable = resolve;
  });
  const device = createBle2Device(Ble2Device, {
    ble: {
      find: async () => ({
        connect: async () => {
          connectCalls += 1;
          return connection.peripheral;
        },
      }),
    },
    setTimeout: () => "reconnect-timeout",
    clearTimeout: () => {},
  });
  device.enableNotifications = async () => enablePending;

  const first = device.ensureBLESubscription({ reason: "first" });
  const second = device.ensureBLESubscription({ reason: "second" });
  await Promise.resolve();
  releaseEnable();
  await Promise.all([first, second]);

  assert.equal(connectCalls, 1);
  assert.equal(connection.calls.subscribe, 1);
  assert.equal(device.peripheral, connection.peripheral);
  assert.equal(device.notificationCharacteristic, connection.notificationCharacteristic);

  await device.ensureBLESubscription({ reason: "healthy check" });
  assert.equal(connectCalls, 1);
  assert.equal(connection.calls.subscribe, 1);
});

test("BLE2 replaces a logically connected subscription after notifications become stale", async () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  const firstConnection = createBle2Connection("ble2-1");
  const secondConnection = createBle2Connection("ble2-2");
  const connections = [firstConnection, secondConnection];
  let connectCalls = 0;
  let watchdogCallback;
  const device = createBle2Device(Ble2Device, {
    ble: {
      find: async () => ({
        connect: async () => connections[connectCalls++].peripheral,
      }),
    },
    setTimeout: (callback) => {
      watchdogCallback = callback;
      return callback;
    },
    clearTimeout: () => {},
  });
  device.enableNotifications = async () => {};

  await device.ensureBLESubscription({ reason: "initial" });
  device.lastNotificationAt = Date.now() - 301000;
  watchdogCallback();
  await device.connectionOperation;

  assert.equal(connectCalls, 2);
  assert.equal(firstConnection.calls.unsubscribe, 1);
  assert.equal(firstConnection.calls.disconnect, 1);
  assert.equal(secondConnection.calls.subscribe, 1);
  assert.equal(device.peripheral, secondConnection.peripheral);
});

test("BLE2 disconnects even when notification unsubscription fails", async () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  let disconnectCalls = 0;
  const device = createBle2Device(Ble2Device, {});
  device.notificationCharacteristic = {
    unsubscribeFromNotifications: async () => {
      throw new Error("notification callback already gone");
    },
  };
  device.peripheral = {
    id: "ble2-1",
    disconnect: async () => {
      disconnectCalls += 1;
    },
  };

  await device.cleanupBLEConnection();

  assert.equal(disconnectCalls, 1);
  assert.equal(device.notificationCharacteristic, null);
  assert.equal(device.peripheral, null);
});

test("BLE2 clears stale ownership and schedules one reconnect after a disconnect event", () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  const scheduled = [];
  const peripheral = { id: "ble2-1" };
  const device = createBle2Device(Ble2Device, {
    setTimeout: (callback, delay) => {
      scheduled.push({ callback, delay });
      return "reconnect-timeout";
    },
  });
  device.peripheral = peripheral;
  device.notificationCharacteristic = {};
  device.lastNotificationAt = Date.now();

  device.handlePeripheralDisconnect(peripheral);
  device.handlePeripheralDisconnect(peripheral);

  assert.equal(device.peripheral, null);
  assert.equal(device.notificationCharacteristic, null);
  assert.equal(device.lastNotificationAt, null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 300000);
});

test("BLE2 notification watchdog is armed relative to each received notification", async () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  const connection = createBle2Connection("ble2-1");
  const scheduled = [];
  const cleared = [];
  const device = createBle2Device(Ble2Device, {
    ble: {
      find: async () => ({ connect: async () => connection.peripheral }),
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.push(timer),
  });
  device.enableNotifications = async () => {};

  await device.ensureBLESubscription({ reason: "initial" });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 300000);

  connection.calls.notificationCallback(Buffer.from("T=20.0 H=50.0"));
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].delay, 300000);
  assert.deepEqual(cleared, [scheduled[0]]);
});

test("BLE2 keeps a working notification subscription when ancillary reads fail", async () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  const connection = createBle2Connection("ble2-1");
  const device = createBle2Device(Ble2Device, {
    ble: {
      find: async () => ({ connect: async () => connection.peripheral }),
    },
    setTimeout: () => "notification-watchdog",
    clearTimeout: () => {},
  });
  device.enableNotifications = async () => {};
  device.readFirmwareVersion = async () => {
    throw new Error("firmware metadata unavailable");
  };
  device.readBatteryLevel = async () => {
    throw new Error("battery metadata unavailable");
  };

  await device.ensureBLESubscription({ reason: "initial" });
  await Promise.resolve();

  assert.equal(device.peripheral, connection.peripheral);
  assert.equal(device.notificationCharacteristic, connection.notificationCharacteristic);
  assert.equal(connection.calls.disconnect, 0);
});

test("BLE2 interval shortening replaces the old watchdog relative to the last notification", async () => {
  const Ble2Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble2/device");
  const cleared = [];
  const scheduled = [];
  const device = createBle2Device(Ble2Device, {
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.push(timer),
  });
  const oldWatchdog = { delay: 3600000 };
  device.reconnectInterval = 3600;
  device.notificationWatchdogTimeout = oldWatchdog;
  device.peripheral = { id: "ble2-1", isConnected: true };
  device.notificationCharacteristic = {};
  device.lastNotificationAt = Date.now() - 30000;
  device.getName = () => "MJ_HT_V1";
  device.pollDevice = () => {};

  await device.onSettings({
    newSettings: { reconnect_interval: 60 },
    changedKeys: ["reconnect_interval"],
  });

  assert.equal(device.reconnectInterval, 60);
  assert.deepEqual(cleared, [oldWatchdog]);
  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay <= 30000 && scheduled[0].delay > 29000);
});

function createBle3Device(DeviceClass, homey) {
  const device = Object.create(DeviceClass.prototype);
  Object.assign(device, {
    homey,
    reconnectInterval: 300,
    advertisementSubscriptionActive: false,
    subscriptionOperation: null,
    gattAttemptId: 0,
    gattAttemptCancellation: null,
    gattSetupTimeout: null,
    notificationCharacteristic: null,
    peripheral: null,
    disconnectTimeout: null,
    lastAdvertisementMeasurementAt: null,
    shuttingDown: false,
    temperatureOffset: 0,
  });
  device.getStore = () => ({ peripheralUuid: "ble3-peripheral" });
  device.getData = () => ({ id: "ble3-peripheral" });
  device.log = () => {};
  device.error = () => {};
  device.setWarning = async () => {};
  device.hasCapability = () => true;
  device.setCapabilityValue = async () => {};
  device.shouldSkipActiveConnection = async () => false;
  device.updateTag = async () => {};
  return device;
}

test("BLE3 uses complete advertisements without opening a GATT connection", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  let findCalls = 0;
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => {
        findCalls += 1;
      },
    },
  });
  device.advertisementSubscriptionActive = true;
  device.lastAdvertisementMeasurementAt = Date.now();

  await device.subscribeToBLENotifications();

  assert.equal(findCalls, 0);
  assert.equal(device.subscriptionOperation, null);
});

test("BLE3 GATT fallback disconnects a peripheral when setup fails", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  let disconnectCalls = 0;
  const peripheral = {
    id: "ble3-1",
    isConnected: true,
    once: () => {},
    getService: async () => {
      throw new Error("service discovery failed");
    },
    disconnect: async () => {
      disconnectCalls += 1;
      peripheral.isConnected = false;
    },
  };
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => ({
        rssi: -60,
        connect: async () => peripheral,
      }),
    },
    setTimeout: () => "gatt-setup-timeout",
    clearTimeout: () => {},
  });

  await device.subscribeToBLENotifications();

  assert.equal(disconnectCalls, 1);
  assert.equal(device.peripheral, null);
  assert.equal(device.notificationCharacteristic, null);
  assert.equal(device.subscriptionOperation, null);
});

test("BLE3 clears its setup deadline after a successful bounded GATT fallback", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  const timers = [];
  const cleared = [];
  const characteristic = {
    subscribeToNotifications: async () => {},
    unsubscribeFromNotifications: async () => {},
  };
  const peripheral = {
    id: "ble3-1",
    isConnected: true,
    once: () => {},
    getService: async () => ({
      getCharacteristic: async () => characteristic,
    }),
    disconnect: async () => {
      peripheral.isConnected = false;
    },
  };
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => ({
        rssi: -60,
        connect: async () => peripheral,
      }),
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.push(timer),
  });

  await device.subscribeToBLENotifications();

  assert.deepEqual(timers.map(({ delay }) => delay), [30000, 300000]);
  assert.deepEqual(cleared, [timers[0]]);
  assert.equal(device.disconnectTimeout, timers[1]);
  assert.equal(device.peripheral, peripheral);
  await device.stopBLESubscription();
});

test("BLE3 keeps one established fallback until its owned disconnect timer fires", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  const timers = [];
  let connectCalls = 0;
  let disconnectCalls = 0;
  const characteristic = {
    subscribeToNotifications: async () => {},
    unsubscribeFromNotifications: async () => {},
  };
  const peripheral = {
    id: "ble3-1",
    isConnected: true,
    once: () => {},
    getService: async () => ({ getCharacteristic: async () => characteristic }),
    disconnect: async () => {
      disconnectCalls += 1;
      peripheral.isConnected = false;
    },
  };
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => ({
        rssi: -60,
        connect: async () => {
          connectCalls += 1;
          return peripheral;
        },
      }),
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
  });

  await device.subscribeToBLENotifications();
  await device.subscribeToBLENotifications();

  assert.equal(connectCalls, 1);
  assert.deepEqual(timers.map(({ delay }) => delay), [30000, 300000]);
  assert.equal(device.peripheral, peripheral);
  assert.equal(device.disconnectTimeout, timers[1]);

  await timers[1].callback();
  assert.equal(disconnectCalls, 1);
  assert.equal(device.peripheral, null);
  assert.equal(device.notificationCharacteristic, null);
  assert.equal(device.disconnectTimeout, null);
});

test("BLE3 coalesces concurrent GATT setup and releases it at the setup deadline", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  const pendingFind = createDeferred();
  const timers = [];
  let findCalls = 0;
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => {
        findCalls += 1;
        return pendingFind.promise;
      },
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
  });

  const first = device.subscribeToBLENotifications();
  const second = device.subscribeToBLENotifications();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(findCalls, 1);
  assert.equal(timers[0].delay, 30000);

  timers[0].callback();
  await Promise.all([first, second]);

  assert.equal(device.subscriptionOperation, null);
  assert.equal(device.gattSetupTimeout, null);
  pendingFind.resolve({});
  await Promise.resolve();
});

test("BLE3 fresh passive data cancels an in-flight GATT fallback before it connects", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  const pendingFind = createDeferred();
  const pendingRssiWrite = createDeferred();
  let connectCalls = 0;
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => pendingFind.promise,
    },
    setTimeout: () => "gatt-setup-timeout",
    clearTimeout: () => {},
  });
  device.advertisementSubscriptionActive = true;
  device.advertisementMatchesTarget = () => true;
  device.setCapabilityValue = async (capabilityId) => {
    if (capabilityId === "measure_rssi") {
      await pendingRssiWrite.promise;
    }
  };

  const setup = device.subscribeToBLENotifications();
  await Promise.resolve();
  const advertisementUpdate = device.processAdvertisementUpdate({
    rssi: -60,
    serviceData: [{ data: Buffer.from([0xd0, 0x07, 50, 0xb8, 0x0b]) }],
  });
  await setup;

  pendingFind.resolve({
    connect: async () => {
      connectCalls += 1;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connectCalls, 0);
  pendingRssiWrite.resolve();
  await advertisementUpdate;
  assert.equal(device.subscriptionOperation, null);
});

test("BLE3 setup deadline prevents a late continuation from creating a disconnect timer", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  const pendingFinalWarning = createDeferred();
  const timers = [];
  let warningCalls = 0;
  let disconnectCalls = 0;
  const characteristic = {
    subscribeToNotifications: async () => {},
    unsubscribeFromNotifications: async () => {},
  };
  const peripheral = {
    id: "ble3-1",
    isConnected: true,
    once: () => {},
    getService: async () => ({ getCharacteristic: async () => characteristic }),
    disconnect: async () => {
      disconnectCalls += 1;
      peripheral.isConnected = false;
    },
  };
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => ({ rssi: -60, connect: async () => peripheral }),
    },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: () => {},
  });
  device.setWarning = async () => {
    warningCalls += 1;
    if (warningCalls === 2) {
      await pendingFinalWarning.promise;
    }
  };

  const setup = device.subscribeToBLENotifications();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30000);

  timers[0].callback();
  await setup;
  pendingFinalWarning.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(timers.length, 1);
  assert.equal(disconnectCalls, 1);
  assert.equal(device.disconnectTimeout, null);
});

test("BLE3 shutdown cancels and awaits an in-flight GATT setup", async () => {
  const Ble3Device = loadHomeyModule("../drivers/xiaomi-thermometer-ble3/device");
  const pendingFind = createDeferred();
  const device = createBle3Device(Ble3Device, {
    ble: {
      find: async () => pendingFind.promise,
    },
    setTimeout: () => "gatt-setup-timeout",
    clearTimeout: () => {},
  });
  device.stopAdvertisementSubscription = async () => {};

  const setup = device.subscribeToBLENotifications();
  await Promise.resolve();
  await device.shutdownBLE();
  await setup;

  assert.equal(device.shuttingDown, true);
  assert.equal(device.subscriptionOperation, null);
  assert.equal(device.peripheral, null);
  pendingFind.resolve({});
  await Promise.resolve();
});
