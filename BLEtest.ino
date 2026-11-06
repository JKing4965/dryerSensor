/*
 *  XIAO nRF52840 / XIAO nRF52840 Sense - BLE Setup Walkthrough
 *  File -> Preferences -> "Additional Boards Manager URLs", paste:
 *  https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
 *  Install Seeed nRF52 Boards in boards manager
 *  Upload and open the Serial Monitor
 *  ---------------------------------------------------------------------------
 *    Click Upload. Then Tools -> Serial Monitor, baud 115200,
 *    line ending "Newline".
 *
 *  ---------------------------------------------------------------------------
 *  Connect from your phone
 *  ---------------------------------------------------------------------------
 *    Install "nRF Connect" (Nordic) or "Adafruit Bluefruit LE Connect".
 *    Scan for "XIAO-BLE", tap Connect, then open the UART module
 *    (Bluefruit LE Connect) or enable notifications on the UART TX
 *    characteristic and write to RX (nRF Connect).
 *    Tip: use these apps rather than your phone's Bluetooth settings menu,
 *    which usually hides BLE-only devices.
 * ============================================================================
 */

#include <bluefruit.h>   // Ships with the "Seeed nRF52 Boards" core

BLEUart bleuart;         // Nordic UART Service (serial over Bluetooth)

// Called when a phone connects / disconnects
void connectCallback(uint16_t conn_handle) {
  Serial.println("Phone connected!");
  digitalWrite(LED_BUILTIN, LOW);    // LED is active-low: LOW = on
}

void disconnectCallback(uint16_t conn_handle, uint8_t reason) {
  Serial.println("Phone disconnected. Advertising again...");
  digitalWrite(LED_BUILTIN, HIGH);   // LED off
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, HIGH);

  Serial.begin(115200);
  while (!Serial && millis() < 3000) delay(10);  // wait up to 3 s for Serial

  Serial.println("XIAO nRF52840 BLE demo starting...");

  // 1. Start the Bluetooth stack
  Bluefruit.begin();
  Bluefruit.setTxPower(4);              // dBm: -40,-20,-16,-12,-8,-4,0,4,8
  Bluefruit.setName("XIAO-BLE");        // Name shown when scanning

  // 2. Register connection events
  Bluefruit.Periph.setConnectCallback(connectCallback);
  Bluefruit.Periph.setDisconnectCallback(disconnectCallback);

  // 3. Start the UART service
  bleuart.begin();

  // 4. Set up advertising (how phones find the board)
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);   // units of 0.625 ms
  Bluefruit.Advertising.setFastTimeout(30);     // seconds of fast advertising
  Bluefruit.Advertising.start(0);               // 0 = advertise forever

  Serial.println("Advertising as 'XIAO-BLE'. Open nRF Connect and scan.");
}

void loop() {
  // Phone -> Serial Monitor
  while (bleuart.available()) {
    Serial.write((char)bleuart.read());
  }

  // Serial Monitor -> Phone
  while (Serial.available()) {
    bleuart.write(Serial.read());
  }
}
