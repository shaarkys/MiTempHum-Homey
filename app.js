'use strict';

const Homey = require('homey');
const { Device } = require('homey');
const { workerData } = require('worker_threads');

const SERVICE_UUID = '181a';

// Capture the original method for setWarning to prevent errors : Not Found: Device with ID
const originalSetWarning = Device.prototype.setWarning;

Device.prototype.setWarning = async function(message) {
  try {
    await originalSetWarning.call(this, message);
  } catch (err) {
    this.log(`Suppressed setWarning error: ${err.message}`);
  }
};

class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Xiaomi Mijia has been initialized');
  }

}

module.exports = MyApp;
