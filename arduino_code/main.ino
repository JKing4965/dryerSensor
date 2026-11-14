#include <Wire.h>
#include <SPI.h>
#include <Adafruit_Sensor.h>
#include "Adafruit_BMP5xx.h" //Adafruit BMP5xx library
#include <bluefruit.h>   // Ships with the "Seeed nRF52 Boards" core
#include <Adafruit_TinyUSB.h>
#include <LSM6DS3.h>
#include <bluefruit.h>   // Ships with the "Seeed nRF52 Boards" core

// Starts advertising BLE -> connects to mobile device -> senses dryer vibration via IMU -> 
// Starts recording temperature and air pressure values (needs to send initial temp and air pressure reading before dryer starts
// -> sends data over BLE -> ends when accelerometers senses no vibration -> reads input for "filter cleaned button" ->
// -> if true: resets the system for the next cycle; if false: continues monitoring for the next cycle and remind user to clean lint

