'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { debug, CLUSTER } = require('zigbee-clusters');

// Enable debug logging of all relevant Zigbee communication
debug(false);

module.exports = class XiaomiThermometerZigbeeDevice extends ZigBeeDevice {

  async onNodeInit({ zclNode }) {
    this.printNode();

    // Log device information
    this.logDeviceInfo();

    if (this.isFirstInit()) {
      await this.configureAttributeReporting([{
        endpointId: 1,
        cluster: CLUSTER.POWER_CONFIGURATION,
        attributeName: 'batteryPercentageRemaining',
        minInterval: 65535,
        maxInterval: 0,
        minChange: 0,
      }]);
    }

    // measure_temperature
    zclNode.endpoints[1].clusters[CLUSTER.TEMPERATURE_MEASUREMENT.NAME]
      .on('attr.measuredValue', value => {
        const temperature = value / 100.0;
        if (temperature >= -60 && temperature <= 120) {
          this.setCapabilityValue('measure_temperature', temperature);
          this.log(`Device ${this.getName()} measured temperature: ${temperature}°C`);
        } else {
          this.log(`Device ${this.getName()} reported invalid temperature value: ${temperature}°C`);
        }
      });

    // measure_humidity
    zclNode.endpoints[1].clusters[CLUSTER.RELATIVE_HUMIDITY_MEASUREMENT.NAME]
      .on('attr.measuredValue', value => {
        const humidity = value / 100.0;
        if (humidity >= 0 && humidity <= 100) {
          this.setCapabilityValue('measure_humidity', humidity);
          this.log(`Device ${this.getName()} measured humidity: ${humidity}%`);
        } else {
          this.log(`Device ${this.getName()} reported invalid humidity value: ${humidity}%`);
        }
      });

    // measure_battery // alarm_battery
    zclNode.endpoints[1].clusters[CLUSTER.POWER_CONFIGURATION.NAME]
      .on('attr.batteryPercentageRemaining', value => {
        const batteryPercentage = Math.round(value / 2);
        this.log(`Device ${this.getName()} measured battery: ${batteryPercentage}%`);
        this.setCapabilityValue('measure_battery', batteryPercentage);
      });
  }

  // Method to log device info
  logDeviceInfo() {
    const deviceId = this.getData().id || this.getData().token;
    this.log(`Device ID: ${deviceId}, Name: ${this.getName()}`);
  }
};
