환경을 모니터링하세요: Mijia BLE 온도 및 습도 센서(LYWSD03MMC & LYWSDCGQ/01ZM)를 간편하게 연결하세요.

LYWSD03MMC 센서는 ATC441 광고 형식을 사용하는 맞춤형 'ATC' 펌웨어로 수정해야 합니다. 이를 위해 https://github.com/pvvx/ATC_MiThermometer를 방문하시고 Telink Flasher를 사용하여 현재 지원되는 v3.5 펌웨어를 플래시할 수 있습니다. 플래시 후에는 ATC1441 광고 형식을 설정하는 것을 잊지 마세요. 앱은 데이터 형식(0x181A)에 따라 발견된 장치를 필터링하고 장치 이름으로 나열할 것입니다.

이 앱의 원개발자인 Zsolt Reinhardt, 기여자인 "Horakmartin", 그리고 ZigBee 드라이버를 구현한 Robert Klep에게 큰 감사를 드립니다!