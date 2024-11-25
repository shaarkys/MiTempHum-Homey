Monitoruj swoje otoczenie: Podłącz czujniki temperatury i wilgotności Mijia BLE (LYWSD03MMC i LYWSDCGQ/01ZM) bez wysiłku.

Pamiętaj, że czujnik LYWSD03MMC wymaga modyfikacji niestandardowym firmwarem 'ATC' za pomocą formatu reklamy ATC441. Aby to zrobić, odwiedź stronę https://github.com/pvvx/ATC_MiThermometer i użyj Telink Flasher do wgrania aktualnie obsługiwanej wersji firmware v3.5. Po wgraniu pamiętaj o ustawieniu formatu reklamy ATC1441. Aplikacja przefiltruje znalezione urządzenia według ich formatu danych (0x181A) i wyświetli je według nazwy.

Wielkie podziękowania dla Zsolta Reinhardta (oryginalnego twórcy tej aplikacji), "Horakmartin" za wkład oraz dla Roberta Klepa za implementację sterowników ZigBee!