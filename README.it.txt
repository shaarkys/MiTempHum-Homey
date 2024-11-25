Monitora il tuo ambiente: collega i sensori di temperatura e umidità Mijia BLE (LYWSD03MMC e LYWSDCGQ/01ZM) senza sforzo.

Nota bene: il sensore LYWSD03MMC deve essere modificato con un firmware personalizzato 'ATC' utilizzando il formato di pubblicità ATC441. Per questo, visita https://github.com/pvvx/ATC_MiThermometer e puoi utilizzare il Telink Flasher per aggiornare il firmware attualmente supportato v3.5. Dopo aver effettuato il flashing, non dimenticare di impostare il formato di pubblicità ATC1441. L'app filtrerà i dispositivi scoperti in base al loro formato dati (0x181A) e elencherà i dispositivi per nome.

Un grande grazie a Zsolt Reinhardt (sviluppatore originale di questa app), "Horakmartin" per il contributo e a Robert Klep per l'implementazione anche dei driver ZigBee!