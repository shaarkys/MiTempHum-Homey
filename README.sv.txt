Övervaka din miljö: Anslut Mijia BLE-temperatur- och fuktighetssensorer (LYWSD03MMC & LYWSDCGQ/01ZM) utan krångel.

Observera att LYWSD03MMC-sensorn måste modifieras med anpassad 'ATC'-firmware med ATC441-annonsformat.
För att göra detta, besök https://github.com/pvvx/ATC_MiThermometer, och du kan använda Telink Flasher för att flasha den aktuellt stödda firmware v3.5.
Efter flashningen, glöm inte att ställa in ATC1441-annonsformatet.
Appen kommer att filtrera de upptäckta enheterna efter deras dataformat (0x181A) och kommer att lista enheterna efter deras namn.

Stort tack till Zsolt Reinhardt (ursprunglig utvecklare av denna app), "Horakmartin" för bidraget och till Robert Klep för att ha implementerat ZigBee-drivrutiner också!