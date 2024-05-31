'use strict';

const { Driver } = require('homey');
const delay = s => new Promise(resolve => setTimeout(resolve, 1000 * s));

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('BLE driver has been initialized');

    // Check if any devices exist
    const devices = this.getDevices();
    if (devices.length > 0) {
      this.polling = true;
      this.addListener('poll', this.pollDevice);

      // Initiating device polling
      this.emit('poll');
    } else {
      this.log('No BLE devices found. Polling is disabled.');
      this.polling = false;
    }
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  
  async onPairListDevices() {
    try {
    let devices = [];
    const foundDevices = await this.homey.ble.discover([], 30000);
    foundDevices.forEach(device => {
      const sdata = device.serviceData;
      if(sdata !== null){
      sdata.forEach(uuid => {
        if(uuid.uuid=="0000181a-0000-1000-8000-00805f9b34fb" || uuid.uuid=="181a"){
          console.log(device.localName);
          let new_device =
            {
              name: device.localName,
              data: {
                id: device.address,
              },

            }
      

            // Example device data, note that `store` is optional
            // {
            //   name: 'My Device',
            //   data: {
            //     id: 'my-device',
            //   },
            //   store: {
            //     address: '127.0.0.1',
            //   },
            // },
       devices.push(new_device);
      }
      })
    }
    })
    return devices;
  } catch (error) {
    this.error('List device error:', error);
  }
}

  async pollDevice() {
    while (this.polling) {
        console.log(`Refreshing BLE devices`);
        let polling_interval = this.homey.settings.get('polling_interval');
        let scan_duration = this.homey.settings.get('scan_duration');

        //default value for polling and scan
        if (!polling_interval) polling_interval = 30;
        if (!scan_duration) scan_duration = 20;

        //listing all all Ruuvitag
        let devices = this.getDevices();

        
        const foundDevices = await this.homey.ble.discover([], scan_duration * 1000);
        this.log("Scan complete!")
        if (foundDevices.length === 0) {
          this.log("No new advertisements were detected. Retrying in 1 second.");
          setTimeout(() => this.pollDevice(), 1000);
          return;
        }
        //console.log(foundDevices, "Found devices in driver");
        devices.forEach(device => device.emit('updateTag', foundDevices));

        await delay(polling_interval);
    };
}
}

module.exports = MyDriver;
