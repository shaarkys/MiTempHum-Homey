# MiTemp_BLE

App for Mijia (BLE) Tempereature and Humidity sensor (LYWSD03MMC) and LYWSDCGQ/01ZM (BLE)

Please note, that the LYWSD03MMC sensor needs to be modded with custom 'ATC' firmware using ATC441 advertising format.
For that please visit https://github.com/pvvx/ATC_MiThermometer and you can use the Telink Flasher to flash the currently supported v3.5 firmware.
After flashing, don't forget to set the ATC1441 advertising format.
The app will filter the dicovered devices by their dataformat (0x181A) and will list the devices by their name.

Big Thanks for Zsolt Reinhardt (original developer of this app), "Horakmartin" for the contribution and for Robert Klep for implementing ZigBee drivers also!
