Overvåk miljøet ditt: Koble Mijia BLE Temperatur- og Fuktighetssensorer (LYWSD03MMC & LYWSDCGQ/01ZM) enkelt.

Vennligst merk at LYWSD03MMC-sensoren må moddes med tilpasset 'ATC'-firmware ved å bruke ATC441 annonseringsformat.
For dette, vennligst besøk https://github.com/pvvx/ATC_MiThermometer og du kan bruke Telink Flasher til å flashe den for øyeblikket støttede v3.5 firmware.
Etter flashing, ikke glem å sette ATC1441 annonseringsformat.
Appen vil filtrere de oppdagede enhetene etter deres dataformat (0x181A) og vil liste enhetene etter navn.

Stor takk til Zsolt Reinhardt (opprinnelig utvikler av denne appen), "Horakmartin" for bidraget og til Robert Klep for å ha implementert ZigBee-drivere også!