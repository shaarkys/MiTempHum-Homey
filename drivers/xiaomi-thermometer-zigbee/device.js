"use strict";

const { ZigBeeDevice } = require("homey-zigbeedriver");
const { debug, CLUSTER } = require("zigbee-clusters");

// Enable/disable debug logging of all relevant Zigbee communication
debug(false);

module.exports = class XiaomiThermometerZigbeeDevice extends ZigBeeDevice {
  /**
   * Override the log method to customize log format
   */
  log(...args) {
    const timestamp = new Date().toISOString();
    const deviceId = this.getData().id || this.getData().token;
    const deviceName = this.getName();
    console.log(`${timestamp} [Device: ${deviceName}] -`, ...args);
  }

  async onNodeInit({ zclNode }) {
    // **ADDED CAPABILITY FOR MEASURE_VOLTAGE IF MISSING**
    if (!this.hasCapability("measure_voltage")) {
      await this.addCapability("measure_voltage");
      this.log(`Added 'measure_voltage' capability to the device: ${this.getName()}`);
    }

    this.printNode();

    // Log device information
    this.logDeviceInfo();

    // Get initial settings
    this.temperatureOffset = this.getSetting("temperature_offset") || 0;

    if (this.isFirstInit()) {
      this.log(`Set batteryPercentageRemaining`);
      await this.configureAttributeReporting([
        {
          endpointId: 1,
          cluster: CLUSTER.POWER_CONFIGURATION,
          attributeName: "batteryPercentageRemaining",
          minInterval: 65535,
          maxInterval: 0,
          minChange: 0,
        },
      ]);
    }

    if (this.isFirstInit()) {
      this.log(`Set batteryVoltage precision`);
      await this.configureAttributeReporting([
        {
          endpointId: 1,
          cluster: CLUSTER.POWER_CONFIGURATION,
          attributeName: "batteryVoltage",
          minInterval: 30,  // Minimum interval (seconds)
          maxInterval: 3600, // Maximum interval (seconds)
          minChange: 1      // Minimum change to trigger a report (in tenths of volts)
        }
      ]);
    }

    // measure_voltage
    zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME].on("attr.batteryVoltage", (value) => {
      const voltage = value / 10; 
      this.log(`Device ${this.getName()} measured voltage: ${voltage}V`);
      this.setCapabilityValue("measure_voltage", voltage);
    });

    // measure_battery // alarm_battery
    zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME].on("attr.batteryPercentageRemaining", (value) => {
      let batteryPercentage = Math.round(value / 2);
      this.log(`Device ${this.getName()} measured battery: ${batteryPercentage}%`);
      this.setCapabilityValue("measure_battery", batteryPercentage);
    });

    // measure_temperature
    zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME].on("attr.measuredValue", (value) => {
      let temperature = value / 100.0 + this.temperatureOffset;
      if (temperature >= -30 && temperature <= 50) {
        this.latestTemperature = temperature; // Store the latest temperature for battery calculations
        this.setCapabilityValue("measure_temperature", temperature);
        this.log(`Device ${this.getName()} measured temperature: ${temperature}°C`);
      } else {
        this.log(`Device ${this.getName()} reported invalid temperature value: ${temperature}°C`);
      }
    });

    // measure_humidity
    zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME].on("attr.measuredValue", (value) => {
      const humidity = value / 100.0;
      if (humidity >= 0 && humidity <= 100) {
        this.setCapabilityValue("measure_humidity", humidity);
        this.log(`Device ${this.getName()} measured humidity: ${humidity}%`);
      } else {
        this.log(`Device ${this.getName()} reported invalid humidity value: ${humidity}%`);
      }
    });
  }

  // Method to log device info
  logDeviceInfo() {
    const deviceId = this.getData().id || this.getData().token;
    this.log(`Device ID: ${deviceId}, Name: ${this.getName()}`);
  }

  // Handle settings changes
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes("temperature_offset")) {
      this.temperatureOffset = newSettings.temperature_offset;
      this.log(`Device ${this.getName()} temperature offset: ${this.temperatureOffset}°C`);
    }
  }
};
