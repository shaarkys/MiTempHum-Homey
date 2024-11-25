'use strict';

const Homey = require('homey');
const { workerData } = require('worker_threads');

const SERVICE_UUID = '181a';
class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Xiaomi Mijia has been initialized');
  }

}

module.exports = MyApp;
