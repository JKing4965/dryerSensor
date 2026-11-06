#include <Adafruit_TinyUSB.h>

#include <nrf_gpio.h>

#define CHG_GPIO 17   // P0.17 = charger status (CHG), active LOW

void setup() {
  Serial.begin(115200);
  nrf_gpio_cfg_input(CHG_GPIO, NRF_GPIO_PIN_PULLUP);  // CHG is open-drain
}

void loop() {
  bool charging = (nrf_gpio_pin_read(CHG_GPIO) == 0);
  Serial.println(charging ? "Charging" : "Not charging / full");
  delay(1000);
}