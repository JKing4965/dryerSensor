/*
 * main.ino - firmware for the dryer lint monitor (Seeed XIAO nRF52840 Sense).
 *
 * WHAT IT DOES
 *   Follows the flow planned for this project:
 *   advertise over Bluetooth -> sense dryer vibration with the built-in IMU ->
 *   record temperature + air pressure from two BMP585 sensors (inside the dryer
 *   under the lint screen, and outside in room air) -> send it to the computer ->
 *   end the cycle when the vibration stops.
 *     - While idle, an "initial" baseline reading is taken every 45 s; the latest one
 *       goes into the cycle-start line, so the computer knows the readings from
 *       before the dryer started.
 *     - Every cycle is saved in the board's 2 MB flash chip, so a cycle recorded while
 *       no computer is connected is uploaded later, and survives a reset.
 *     - "Filter cleaned" and the reminder to clean lint live in the dashboard, not here.
 *     - TEST CYCLES: the dashboard's "Start / End test cycle" buttons send M,1[,seconds] / M,0,
 *       which start and end a cycle without vibration (bench or lint-simulation testing).
 *       The vibration level is ignored while one runs. See docs/protocol.md section 4.
 *
 * TALKS TO
 *   - The Python receiver (backend/, `--source ble`) over the Nordic UART Service.
 *     Every line follows docs/protocol.md exactly (H, B, C, S, E out; T, A in).
 *   - Design and test checkpoints: docs/firmware_plan.md.
 *
 * HARDWARE
 *   - BMP585 INSIDE  (under the lint screen): I2C address 0x47 (BMP5XX_ALTERNATIVE_ADDRESS)
 *   - BMP585 OUTSIDE (room air):              I2C address 0x46 (BMP5XX_DEFAULT_ADDRESS)
 *     Both on Wire (SDA = D4, SCL = D5). The IMU is on its own internal bus (Wire1).
 *
 * HOW TO UPLOAD
 *   - Arduino IDE board: "Seeed XIAO nRF52840 Sense" from "Seeed nRF52 Boards"
 *     (NOT the "(No Updates)" mbed version - it has no bluefruit.h).
 *   - Libraries: Adafruit BMP5xx, Adafruit Unified Sensor, Adafruit BusIO,
 *     Seeed Arduino LSM6DS3, Adafruit SPIFlash (+ SdFat Adafruit Fork).
 *   - Open the Serial Monitor at 115200 to watch the debug log (optional; the board
 *     runs fine without USB).
 *
 * LEDS (see LED_ON_LEVEL below if they look inverted)
 *   blue  = computer connected      green = recording a cycle (blinks while confirming)
 *   red   = sensor problem, or flash not found (RAM-only fallback)
 *
 * FILE LAYOUT
 *   1. Settings  2. Protocol line helpers  3. Sensors  4. Vibration  5. Storage (flash log)
 *   6. Bluetooth link  7. Cycle state machine  8. setup() / loop()
 */

#include <Adafruit_TinyUSB.h>  // USB serial on this core (as in the test sketches)
#include <Wire.h>
#include <bluefruit.h>         // ships with the "Seeed nRF52 Boards" core
#include <Adafruit_Sensor.h>
#include <Adafruit_BMP5xx.h>   // Adafruit BMP5xx library (used in BMP585_test.ino)
#include <LSM6DS3.h>           // Seeed LSM6DS3 library (used in accel_LED_test.ino)
#include <Adafruit_SPIFlash.h> // the 2 MB QSPI flash chip
#include <InternalFileSystem.h>
#include <nrf_soc.h>           // hardware random numbers for boot_id

namespace LFS = Adafruit_LittleFS_Namespace;  // SdFat (pulled in by SPIFlash) also has a "File"

// =====================================================================================
// 1. SETTINGS - everything you might want to tune is here
// =====================================================================================

#define DEBUG 1      // 1 = print a status line every second on USB serial (115200)
#define DEBUG_BLE 0  // 1 = also send short "#" debug comments over Bluetooth

static const char *BLE_NAME = "XIAO-BLE";  // must match BLE_DEVICE_NAME in the repo-root .env

static const uint8_t ADDR_INSIDE = BMP5XX_ALTERNATIVE_ADDRESS;  // 0x47, under the lint screen
static const uint8_t ADDR_OUTSIDE = BMP5XX_DEFAULT_ADDRESS;     // 0x46, room air
static const uint32_t I2C_CLOCK_HZ = 100000;                    // slow + robust for long wires

// Timing (milliseconds)
static const uint32_t SENSOR_READ_MS = 100;    // read both BMP585s at 10 Hz...
static const uint32_t SAMPLE_MS = 1000;        // ...and average them into 1 sample per second
static const uint32_t IMU_READ_MS = 20;        // accelerometer at 50 Hz
static const uint32_t HELLO_MS = 30000;        // H line every 30 s while connected
static const uint32_t BASELINE_MS = 45000;     // idle baseline every 45 s
static const uint32_t SENSOR_RETRY_MS = 5000;  // retry a missing sensor every 5 s

// Sensor error rules (docs/protocol.md 3.1)
static const uint8_t ERR_STREAK = 3;  // 3 bad readings in a row -> broken; 3 good -> OK again
static const float P_MIN_PA = 30000.0f, P_MAX_PA = 125000.0f;  // BMP585 range
static const float T_MIN_C = -40.0f, T_MAX_C = 85.0f;

// Vibration (cycle start/stop). TUNE THESE WITH THE REAL DRYER (firmware plan, checkpoint F4).
static const float VIB_THRESHOLD_G = 0.03f;  // vibration level (RMS, g) that counts as "running"
static const uint16_t START_CONFIRM_S = 10;  // seconds of vibration before a cycle starts
static const uint16_t START_ABORT_S = 3;     // quiet seconds that cancel a start (door slam)
static const uint16_t STOP_CONFIRM_S = 90;   // quiet seconds before a cycle ends (drum pauses)

// Storage
static const uint8_t NUM_SLOTS = 4;              // cycles the flash can hold before upload
static const uint8_t UPLOAD_LINES_PER_LOOP = 8;  // lines sent per loop() so sampling never stalls
static const uint32_t LIVE_WINDOW_MS = 3000;     // samples younger than this are sent as live ("L")

// LEDs. The XIAO's RGB LED is normally active-LOW; set to HIGH if the LEDs look inverted.
static const uint8_t LED_ON_LEVEL = LOW;

static const uint8_t PROTOCOL_VERSION = 1;
static const size_t MAX_LINE_LEN = 120;  // our longest line is ~80 characters (limit is 200)

// =====================================================================================
// DATA TYPES - all defined here, before any function, because the Arduino IDE inserts
// function prototypes right before the first function and they need these types.
// =====================================================================================

// One averaged reading of both sensors, in fixed point: pressure Pa*100, temperature degC*100.
struct Reading {
  uint32_t ms;
  int32_t pIn, pOut;
  int16_t tIn, tOut;
};

// Sensor error codes (docs/protocol.md 3.1)
enum SensorCode : uint8_t { SENSOR_OK = 0, SENSOR_MISSING = 1, SENSOR_BROKEN = 2 };

// One BMP585 plus its error bookkeeping and the running 1-second average.
struct PtSensor {
  const char *name;
  uint8_t addr;
  Adafruit_BMP5xx bmp;
  SensorCode code;
  uint8_t badStreak, goodStreak;
  uint32_t lastRetryMs;
  float sumP, sumT;  // sums over the current 1-second window (Pa, degC)
  uint16_t n;
  PtSensor(const char *nm, uint8_t a)
      : name(nm), addr(a), code(SENSOR_MISSING), badStreak(0), goodStreak(0), lastRetryMs(0), sumP(0), sumT(0), n(0) {}
};

// One 32-byte record in the flash log (section 5).
struct __attribute__((packed)) LogRec {
  uint8_t magic;  // REC_MAGIC when written (erased flash reads 0xFF)
  uint8_t type;   // 'C', 'S' or 'E'
  uint8_t crc;    // CRC-8 of the record with this byte set to 0
  uint8_t flags;  // C: FLAG_HAS_BASELINE
  uint32_t bootId;
  uint32_t cycleNo;
  uint32_t a;     // C: baseline ms; S: seq; E: number of samples
  uint32_t ms;    // board time of the record
  int32_t pIn, pOut;  // Pa * 100 (C: baseline values; S: sample)
  int16_t tIn, tOut;  // degC * 100
};
static_assert(sizeof(LogRec) == 32, "LogRec must be 32 bytes");

// One storage slot = one cycle (section 5).
struct Slot {
  bool used;          // holds a cycle (has a valid C record)
  bool erasing;       // erase in progress (one block per loop)
  int16_t eraseNext;  // next block index to erase (counts down to 0)
  uint32_t cycleNo, bootId;
  uint32_t count;     // records written = next write index
  bool hasE;
  int32_t ackedSeq;   // highest seq the computer confirmed (RAM only; -1 = none)
  bool done;          // computer confirmed the whole cycle
  // upload cursor, reset on every new connection
  bool cSent, eSent;
  uint32_t nextSeq;
};

// Cycle state machine (section 7)
enum CycleState : uint8_t { IDLE, STARTING, RUNNING, STOPPING };

// =====================================================================================
// 2. PROTOCOL LINE HELPERS (docs/protocol.md)
// =====================================================================================

// Writes a value stored as x*100 with exactly 2 decimals ("-3.05", "101325.40").
// (Avoids printf("%f"), which this core may not support.)
static char *fmt2(char *out, size_t n, int32_t v100) {
  uint32_t a = v100 < 0 ? (uint32_t)(-(int64_t)v100) : (uint32_t)v100;
  snprintf(out, n, "%s%lu.%02lu", v100 < 0 ? "-" : "", (unsigned long)(a / 100), (unsigned long)(a % 100));
  return out;
}

// ",p_in,t_in,p_out,t_out" for B / C / S lines
static void appendValues(char *line, size_t n, const Reading &r) {
  char a[16], b[16], c[16], d[16];
  size_t len = strlen(line);
  snprintf(line + len, n - len, ",%s,%s,%s,%s", fmt2(a, sizeof a, r.pIn), fmt2(b, sizeof b, r.tIn),
           fmt2(c, sizeof c, r.pOut), fmt2(d, sizeof d, r.tOut));
}

static void lineHello(char *line, size_t n, uint32_t bootId, uint32_t ms, const char *state, uint32_t backlog,
                      uint8_t errIn, uint8_t errOut) {
  snprintf(line, n, "H,%u,%lu,%lu,%s,%lu,%u,%u", PROTOCOL_VERSION, (unsigned long)bootId, (unsigned long)ms, state,
           (unsigned long)backlog, errIn, errOut);
}

static void lineBaseline(char *line, size_t n, uint32_t bootId, const Reading &r) {
  snprintf(line, n, "B,%lu,%lu", (unsigned long)bootId, (unsigned long)r.ms);
  appendValues(line, n, r);
}

static void lineCycleStart(char *line, size_t n, uint32_t bootId, uint32_t cycleNo, uint32_t ms, const Reading *base) {
  snprintf(line, n, "C,%lu,%lu,%lu", (unsigned long)bootId, (unsigned long)cycleNo, (unsigned long)ms);
  size_t len = strlen(line);
  if (base) {
    snprintf(line + len, n - len, ",%lu", (unsigned long)base->ms);
    appendValues(line, n, *base);
  } else {
    snprintf(line + len, n - len, ",,,,,");  // no baseline yet: 5 empty fields
  }
}

static void lineSample(char *line, size_t n, uint32_t bootId, uint32_t cycleNo, uint32_t seq, const Reading &r,
                       bool live) {
  snprintf(line, n, "S,%lu,%lu,%lu,%lu", (unsigned long)bootId, (unsigned long)cycleNo, (unsigned long)seq,
           (unsigned long)r.ms);
  appendValues(line, n, r);
  size_t len = strlen(line);
  snprintf(line + len, n - len, ",%c", live ? 'L' : 'F');
}

static void lineCycleEnd(char *line, size_t n, uint32_t bootId, uint32_t cycleNo, uint32_t ms, uint32_t nSamples) {
  snprintf(line, n, "E,%lu,%lu,%lu,%lu", (unsigned long)bootId, (unsigned long)cycleNo, (unsigned long)ms,
           (unsigned long)nSamples);
}

// =====================================================================================
// 3. SENSORS - two BMP585s, averaged to 1 Hz, with error codes 0 ok / 1 missing / 2 broken
// =====================================================================================

static PtSensor sensorIn("inside", ADDR_INSIDE);
static PtSensor sensorOut("outside", ADDR_OUTSIDE);
static bool sensorCodesChanged = true;  // send an H right away when an error code changes

static void debugComment(const char *msg);  // defined in section 6

static bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static bool sensorConfigure(PtSensor &s) {
  if (!s.bmp.begin(s.addr, &Wire)) return false;
  Wire.setClock(I2C_CLOCK_HZ);
  // Like BMP585_test.ino, tuned for 1 Hz output: more oversampling, 10 Hz data rate.
  s.bmp.setTemperatureOversampling(BMP5XX_OVERSAMPLING_4X);
  s.bmp.setPressureOversampling(BMP5XX_OVERSAMPLING_32X);
  s.bmp.setIIRFilterCoeff(BMP5XX_IIR_FILTER_COEFF_3);
  s.bmp.setOutputDataRate(BMP5XX_ODR_10_HZ);
  s.bmp.enablePressure(true);
  s.bmp.setPowerMode(BMP5XX_POWERMODE_NORMAL);
  return true;
}

static void sensorSetCode(PtSensor &s, SensorCode c) {
  if (s.code == c) return;
  s.code = c;
  s.badStreak = s.goodStreak = 0;
  sensorCodesChanged = true;
  char msg[48];
  snprintf(msg, sizeof msg, "%s sensor %s", s.name, c == SENSOR_OK ? "OK" : c == SENSOR_MISSING ? "MISSING" : "BROKEN");
  debugComment(msg);
}

static void sensorBegin(PtSensor &s) {
  sensorSetCode(s, sensorConfigure(s) ? SENSOR_OK : SENSOR_MISSING);
  s.lastRetryMs = millis();
}

// Called at 10 Hz: one reading into the 1-second average, and error bookkeeping.
static void sensorPoll(PtSensor &s, uint32_t now) {
  if (s.code == SENSOR_MISSING) {
    if (now - s.lastRetryMs < SENSOR_RETRY_MS) return;
    s.lastRetryMs = now;
    if (sensorConfigure(s)) sensorSetCode(s, SENSOR_OK);  // answers again -> OK
    return;
  }
  bool ok = s.bmp.performReading();
  float p = s.bmp.pressure * 100.0f;  // library gives hPa; protocol wants Pa
  float t = s.bmp.temperature;
  bool valid = ok && isfinite(p) && isfinite(t) && p >= P_MIN_PA && p <= P_MAX_PA && t >= T_MIN_C && t <= T_MAX_C;
  if (valid) {
    s.sumP += p;
    s.sumT += t;
    s.n++;
    s.badStreak = 0;
    if (s.code == SENSOR_BROKEN && ++s.goodStreak >= ERR_STREAK) sensorSetCode(s, SENSOR_OK);
  } else {
    s.goodStreak = 0;
    if (!i2cPresent(s.addr)) {
      sensorSetCode(s, SENSOR_MISSING);  // no answer at its address at all
      s.lastRetryMs = now;
    } else if (++s.badStreak >= ERR_STREAK) {
      sensorSetCode(s, SENSOR_BROKEN);  // answers, but readings fail / out of range
    }
  }
}

static bool sensorsOk() { return sensorIn.code == SENSOR_OK && sensorOut.code == SENSOR_OK; }

// Called once per second: averages the window into `out`. False if there is no valid sample.
static bool sensorsTakeSecond(Reading &out, uint32_t now) {
  bool have = sensorsOk() && sensorIn.n > 0 && sensorOut.n > 0;
  if (have) {
    out.ms = now;
    out.pIn = (int32_t)lroundf(sensorIn.sumP / sensorIn.n * 100.0f);
    out.pOut = (int32_t)lroundf(sensorOut.sumP / sensorOut.n * 100.0f);
    out.tIn = (int16_t)lroundf(sensorIn.sumT / sensorIn.n * 100.0f);
    out.tOut = (int16_t)lroundf(sensorOut.sumT / sensorOut.n * 100.0f);
  }
  sensorIn.sumP = sensorIn.sumT = sensorOut.sumP = sensorOut.sumT = 0;
  sensorIn.n = sensorOut.n = 0;
  return have;
}

// =====================================================================================
// 4. VIBRATION - built-in LSM6DS3 accelerometer -> 1-second RMS vibration level (g)
// =====================================================================================

static LSM6DS3 imu(I2C_MODE, 0x6A);  // the library switches to the internal Wire1 bus itself
static bool imuOk = false;
static float gravityAvg = 1.0f;      // slow average of |a| (removes gravity)
static float vibSumSq = 0;
static uint16_t vibN = 0;
static float vibLevel = 0;           // latest 1-second RMS, in g

static void vibBegin() {
  imu.settings.gyroEnabled = 0;       // only the accelerometer is needed
  imu.settings.accelRange = 4;        // +/-4 g: finer steps than the 16 g default
  imu.settings.accelSampleRate = 104; // Hz, above our 50 Hz reading rate
  imuOk = imu.begin() == 0;
  if (!imuOk) debugComment("IMU not found - cycles can't be detected");
}

static void vibPoll() {
  if (!imuOk) return;
  float ax = imu.readFloatAccelX(), ay = imu.readFloatAccelY(), az = imu.readFloatAccelZ();
  float mag = sqrtf(ax * ax + ay * ay + az * az);
  gravityAvg += (mag - gravityAvg) * 0.02f;  // ~1 s time constant at 50 Hz
  float d = mag - gravityAvg;
  vibSumSq += d * d;
  vibN++;
}

static float vibTakeSecond() {
  vibLevel = vibN ? sqrtf(vibSumSq / vibN) : 0.0f;
  vibSumSq = 0;
  vibN = 0;
  return vibLevel;
}

// =====================================================================================
// 5. STORAGE - cycles kept in flash until the computer confirms it stored them
// =====================================================================================
//
// The 2 MB flash is split into NUM_SLOTS equal slots; each slot holds ONE cycle as 32-byte
// records: [0] = C (cycle start + baseline), [1..n] = S (sample seq 0..n-1), [n+1] = E.
// A slot is erased (last block first) after the computer sends A,<cycle>,<seq>,1.
// At power-up each slot is scanned; a cycle cut off by a reset gets its E appended.
// If no flash chip is found, a small RAM buffer is used instead (lost on reset).
//
// (The core's ExternalFS is not used: it assumes a 4 MB chip; this board has 2 MB.)

static const uint8_t REC_MAGIC = 0xD5;
static const uint8_t FLAG_HAS_BASELINE = 0x01;
// (LogRec and Slot are defined in DATA TYPES at the top.)

static Adafruit_FlashTransport_QSPI flashTransport;
static Adafruit_SPIFlash flash(&flashTransport);
static bool storeOnFlash = false;
static uint8_t *ramStore = nullptr;
static const uint32_t RAM_STORE_SIZE = 64 * 1024;  // fallback: 4 slots of 16 KB (~8 min each)
static uint32_t storeSize = 0, slotBytes = 0, eraseBytes = 0, blocksPerSlot = 0, slotCapacity = 0;
static Slot slots[NUM_SLOTS];
static int8_t curSlot = -1;     // slot of the cycle being recorded
static uint32_t nextCycleNo = 1;
static bool slotFullWarned = false;

static uint8_t crc8(const uint8_t *data, size_t len) {
  uint8_t crc = 0;
  while (len--) {
    crc ^= *data++;
    for (uint8_t i = 0; i < 8; i++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
  }
  return crc;
}

static void recSeal(LogRec &r) {
  r.magic = REC_MAGIC;
  r.crc = 0;
  r.crc = crc8((const uint8_t *)&r, sizeof r);
}

static bool recValid(const LogRec &r) {
  if (r.magic != REC_MAGIC) return false;
  LogRec c = r;
  c.crc = 0;
  return crc8((const uint8_t *)&c, sizeof c) == r.crc;
}

static void storeRead(uint32_t addr, void *buf, uint32_t len) {
  if (storeOnFlash) flash.readBuffer(addr, (uint8_t *)buf, len);
  else memcpy(buf, ramStore + addr, len);
}

static void storeWrite(uint32_t addr, const void *buf, uint32_t len) {
  if (storeOnFlash) flash.writeBuffer(addr, (const uint8_t *)buf, len);
  else memcpy(ramStore + addr, buf, len);
}

static void storeEraseBlock(uint32_t blockIndex) {  // erase unit: 64 KB on flash, one slot in RAM
  if (storeOnFlash) flash.eraseBlock(blockIndex);
  else memset(ramStore + blockIndex * eraseBytes, 0xFF, eraseBytes);
}

static uint32_t recAddr(uint8_t slot, uint32_t idx) { return slot * slotBytes + idx * sizeof(LogRec); }

static bool readRec(uint8_t slot, uint32_t idx, LogRec &r) {
  storeRead(recAddr(slot, idx), &r, sizeof r);
  return recValid(r);
}

static uint8_t readMagic(uint8_t slot, uint32_t idx) {
  uint8_t m;
  storeRead(recAddr(slot, idx), &m, 1);
  return m;
}

static void appendRec(uint8_t slot, LogRec &r) {
  recSeal(r);
  storeWrite(recAddr(slot, slots[slot].count), &r, sizeof r);
  slots[slot].count++;
}

static uint32_t slotSamples(const Slot &s) {  // S records written
  if (!s.used || s.count == 0) return 0;
  return s.count - 1 - (s.hasE ? 1 : 0);
}

// ---- cycle number, kept in internal flash so it never repeats ----
static const char *CYCLE_FILE = "/cycle_no.txt";

static void cycleNoLoad() {
  LFS::File f(InternalFS);
  if (f.open(CYCLE_FILE, LFS::FILE_O_READ)) {
    char buf[16] = {0};
    f.read(buf, sizeof buf - 1);
    f.close();
    uint32_t v = strtoul(buf, nullptr, 10);
    if (v > nextCycleNo) nextCycleNo = v;
  }
}

static void cycleNoSave() {
  InternalFS.remove(CYCLE_FILE);
  LFS::File f(InternalFS);
  if (f.open(CYCLE_FILE, LFS::FILE_O_WRITE)) {
    char buf[16];
    snprintf(buf, sizeof buf, "%lu", (unsigned long)nextCycleNo);
    f.write((const uint8_t *)buf, strlen(buf));
    f.close();
  }
}

// ---- power-up scan ----
static void slotScan(uint8_t i) {
  Slot &s = slots[i];
  memset(&s, 0, sizeof s);
  s.ackedSeq = -1;
  LogRec r;
  if (!readRec(i, 0, r) || r.type != 'C') {
    // Empty, or junk: if anything is written there, erase it before reuse.
    if (readMagic(i, 0) != 0xFF) {
      s.erasing = true;
      s.eraseNext = blocksPerSlot - 1;
    }
    return;
  }
  s.used = true;
  s.cycleNo = r.cycleNo;
  s.bootId = r.bootId;
  // Records are written in order: binary-search the first unwritten one.
  uint32_t lo = 1, hi = slotCapacity;
  while (lo < hi) {
    uint32_t mid = (lo + hi) / 2;
    if (readMagic(i, mid) == 0xFF) hi = mid;
    else lo = mid + 1;
  }
  s.count = lo;
  LogRec last;
  bool lastOk = readRec(i, s.count - 1, last);
  s.hasE = lastOk && last.type == 'E';
  if (!s.hasE && s.count < slotCapacity) {
    // Cycle was cut off by a reset or power loss: close it so it can be uploaded.
    LogRec e = {};
    e.type = 'E';
    e.bootId = s.bootId;
    e.cycleNo = s.cycleNo;
    e.a = s.count - 1;               // S records (a torn last record is reported as missing)
    e.ms = lastOk ? last.ms : r.ms;
    appendRec(i, e);
    s.hasE = true;
  }
  if (s.cycleNo >= nextCycleNo) nextCycleNo = s.cycleNo + 1;
}

static void storageBegin() {
  storeOnFlash = flash.begin();
  if (storeOnFlash) {
    storeSize = flash.size();
    eraseBytes = 64 * 1024;
  }
  if (!storeOnFlash || storeSize < NUM_SLOTS * eraseBytes) {
    storeOnFlash = false;
    ramStore = (uint8_t *)malloc(RAM_STORE_SIZE);
    storeSize = ramStore ? RAM_STORE_SIZE : 0;
    if (ramStore) memset(ramStore, 0xFF, RAM_STORE_SIZE);
    eraseBytes = storeSize / NUM_SLOTS;
  }
  InternalFS.begin();
  cycleNoLoad();
  if (storeSize == 0) {  // no flash and no RAM for a buffer: cycles can't be recorded
    debugComment("storage: NONE available - cycles will not be recorded");
    return;
  }
  slotBytes = storeSize / NUM_SLOTS / eraseBytes * eraseBytes;
  blocksPerSlot = slotBytes / eraseBytes;
  slotCapacity = slotBytes / sizeof(LogRec);

  for (uint8_t i = 0; i < NUM_SLOTS; i++) slotScan(i);
  cycleNoSave();

  char msg[96];
  snprintf(msg, sizeof msg, "storage: %s %lu KB, %u slots x %lu samples, next cycle %lu",
           storeOnFlash ? "flash" : "RAM (no flash found!)", (unsigned long)(storeSize / 1024), NUM_SLOTS,
           (unsigned long)(slotCapacity - 2), (unsigned long)nextCycleNo);
  debugComment(msg);
}

// Erases the next block of slot i: last block first, block 0 (the C record) last, so a
// reset part-way through never leaves a slot that looks empty but isn't.
static void slotEraseOneBlock(uint8_t i) {
  Slot &s = slots[i];
  storeEraseBlock(i * blocksPerSlot + s.eraseNext);
  if (--s.eraseNext < 0) {
    memset(&s, 0, sizeof s);
    s.ackedSeq = -1;
  }
}

// Called every loop(): erases ONE block of the first slot waiting to be erased.
static void storageEraseStep() {
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    if (slots[i].erasing) {
      slotEraseOneBlock(i);
      return;
    }
  }
}

static void slotEraseNow(uint8_t i) {  // blocking; only when we must reuse a slot immediately
  if (!slots[i].erasing) {
    slots[i].erasing = true;
    slots[i].eraseNext = blocksPerSlot - 1;
  }
  while (slots[i].erasing) slotEraseOneBlock(i);
}

// Pick a slot for a new cycle: a free one, else overwrite the oldest (warns).
static int8_t slotAllocate() {
  int8_t pick = -1;
  for (uint8_t i = 0; i < NUM_SLOTS; i++)
    if (!slots[i].used) {
      pick = i;
      break;
    }
  if (pick < 0) {
    for (uint8_t i = 0; i < NUM_SLOTS; i++)
      if (pick < 0 || slots[i].cycleNo < slots[pick].cycleNo) pick = i;
    char msg[64];
    snprintf(msg, sizeof msg, "storage full: overwriting un-uploaded cycle %lu", (unsigned long)slots[pick].cycleNo);
    debugComment(msg);
    slots[pick].used = false;
    slots[pick].erasing = false;
  }
  // Make sure every block of the slot is erased before writing into it.
  for (uint32_t b = 0; b < blocksPerSlot; b++) {
    uint32_t word;
    storeRead(pick * slotBytes + b * eraseBytes, &word, 4);
    if (word != 0xFFFFFFFF || slots[pick].erasing) {
      slotEraseNow(pick);
      break;
    }
  }
  return pick;
}

// ---- writing a cycle ----
static void storageStartCycle(uint32_t cycleNo, uint32_t bootId, uint32_t ms, const Reading *base) {
  if (slotCapacity == 0) return;  // no storage at all
  int8_t i = slotAllocate();
  Slot &s = slots[i];
  memset(&s, 0, sizeof s);
  s.used = true;
  s.cycleNo = cycleNo;
  s.bootId = bootId;
  s.ackedSeq = -1;
  LogRec c = {};
  c.type = 'C';
  c.bootId = bootId;
  c.cycleNo = cycleNo;
  c.ms = ms;
  if (base) {
    c.flags = FLAG_HAS_BASELINE;
    c.a = base->ms;
    c.pIn = base->pIn;
    c.pOut = base->pOut;
    c.tIn = base->tIn;
    c.tOut = base->tOut;
  }
  appendRec(i, c);
  curSlot = i;
  slotFullWarned = false;
}

static void storageAddSample(const Reading &r) {
  if (curSlot < 0) return;
  Slot &s = slots[curSlot];
  if (s.count >= slotCapacity - 1) {  // keep room for the E record
    if (!slotFullWarned) debugComment("cycle too long for its slot: further samples dropped");
    slotFullWarned = true;
    return;
  }
  LogRec rec = {};
  rec.type = 'S';
  rec.bootId = s.bootId;
  rec.cycleNo = s.cycleNo;
  rec.a = slotSamples(s);  // seq
  rec.ms = r.ms;
  rec.pIn = r.pIn;
  rec.pOut = r.pOut;
  rec.tIn = r.tIn;
  rec.tOut = r.tOut;
  appendRec(curSlot, rec);
}

static void storageEndCycle(uint32_t ms) {
  if (curSlot < 0) return;
  Slot &s = slots[curSlot];
  LogRec e = {};
  e.type = 'E';
  e.bootId = s.bootId;
  e.cycleNo = s.cycleNo;
  e.a = slotSamples(s);
  e.ms = ms;
  appendRec(curSlot, e);
  s.hasE = true;
  curSlot = -1;
}

// Samples written but not yet confirmed by the computer (the H line's backlog_count).
static uint32_t storageBacklog() {
  uint32_t total = 0;
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    const Slot &s = slots[i];
    if (!s.used || s.done || s.erasing) continue;
    int32_t pending = (int32_t)slotSamples(s) - (s.ackedSeq + 1);
    if (pending > 0) total += pending;
  }
  return total;
}

// A,<cycle>,<seq>,<done> from the computer
static void storageAck(uint32_t cycleNo, uint32_t seq, bool done) {
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    Slot &s = slots[i];
    if (!s.used || s.erasing || s.cycleNo != cycleNo) continue;
    if ((int32_t)seq > s.ackedSeq) s.ackedSeq = seq;
    if (done && s.hasE && i != curSlot) {
      s.done = true;
      s.erasing = true;
      s.eraseNext = blocksPerSlot - 1;
    }
  }
}

// =====================================================================================
// 6. BLUETOOTH LINK - Nordic UART, one protocol line per write
// =====================================================================================

static BLEUart bleuart;
static uint32_t bootId = 0;
static bool linkReady = false;    // connected AND the computer subscribed to notifications
static bool needResync = false;   // a previous write failed part-way: start with '\n'
static bool helloDue = false;
static uint32_t lastHelloMs = 0;
static int64_t unixOffsetMs = 0;  // from T lines (real time = millis() + offset); for debugging
static char rxLine[64];
static uint8_t rxLen = 0;
static bool rxOverflow = false;

static void debugComment(const char *msg) {
#if DEBUG
  if (Serial) {
    Serial.print("# ");
    Serial.println(msg);
  }
#endif
#if DEBUG_BLE
  if (linkReady) {
    char line[MAX_LINE_LEN];
    snprintf(line, sizeof line, "# %s\n", msg);
    bleuart.write((const uint8_t *)line, strlen(line));
  }
#endif
}

// Sends one line (adds "\n"). False if Bluetooth couldn't take it now - try again later.
static bool linkSendLine(const char *line) {
  if (!linkReady) return false;
  char buf[MAX_LINE_LEN + 4];
  size_t n = 0;
  if (needResync) buf[n++] = '\n';  // ends any half-sent line so this one parses cleanly
  size_t len = strlen(line);
  if (len > MAX_LINE_LEN) len = MAX_LINE_LEN;
  memcpy(buf + n, line, len);
  n += len;
  buf[n++] = '\n';
  size_t sent = bleuart.write((const uint8_t *)buf, n);  // ONE write per line (protocol.md)
  needResync = (sent != n);
  return sent == n;
}

static uint32_t makeBootId() {
  uint32_t v = 0;
  for (int tries = 0; tries < 200 && v == 0; tries++) {
    uint8_t avail = 0;
    sd_rand_application_bytes_available_get(&avail);
    if (avail >= 4) sd_rand_application_vector_get((uint8_t *)&v, 4);
    else delay(2);
  }
  if (v == 0) v = (micros() * 2654435761UL) | 1;  // fallback, still non-zero
  return v;
}

static void linkBegin() {
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);  // 247-byte MTU: a whole line fits one packet
  Bluefruit.begin();
  Bluefruit.autoConnLed(false);                  // we drive the LEDs ourselves
  Bluefruit.setTxPower(4);
  Bluefruit.setName(BLE_NAME);
  bleuart.begin();
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);  // units of 0.625 ms (as in BLEtest.ino)
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);              // advertise forever
  bootId = makeBootId();
}

// Upload cursors start over on every new connection (protocol.md section 5).
static void linkOnSubscribed() {
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    Slot &s = slots[i];
    s.cSent = s.eSent = false;
    s.nextSeq = (uint32_t)(s.ackedSeq + 1);
  }
  needResync = false;
  helloDue = true;  // H is the first line of every connection
  rxLen = 0;
  rxOverflow = false;
  debugComment("computer subscribed");
}

static void linkProcessLine(char *line) {
  if (line[0] == 'T' && line[1] == ',') {
    uint64_t unixMs = strtoull(line + 2, nullptr, 10);
    unixOffsetMs = (int64_t)unixMs - (int64_t)millis();
  } else if (line[0] == 'A' && line[1] == ',') {
    char *p = line + 2;
    uint32_t cycle = strtoul(p, &p, 10);
    if (*p != ',') return;
    uint32_t seq = strtoul(p + 1, &p, 10);
    if (*p != ',') return;
    bool done = strtoul(p + 1, nullptr, 10) == 1;
    storageAck(cycle, seq, done);
  } else if (line[0] == 'M' && line[1] == ',') {  // test cycle: M,1[,<seconds>] or M,0
    char *p = line + 2;
    uint32_t on = strtoul(p, &p, 10);
    uint32_t seconds = 0;
    if (*p == ',') {
      seconds = strtoul(p + 1, nullptr, 10);
      if (seconds > 86400) seconds = 0;  // out of range: run until M,0
    }
    testCycleCommand(on == 1, seconds);
  }
}

static void linkPollRx() {
  while (bleuart.available()) {
    char c = (char)bleuart.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (!rxOverflow && rxLen) {
        rxLine[rxLen] = 0;
        linkProcessLine(rxLine);
      }
      rxLen = 0;
      rxOverflow = false;
    } else if (rxLen < sizeof rxLine - 1) {
      rxLine[rxLen++] = c;
    } else {
      rxOverflow = true;
    }
  }
}

// =====================================================================================
// 7. CYCLE STATE MACHINE - IDLE -> STARTING -> RUNNING <-> STOPPING -> IDLE
// =====================================================================================

static const char *STATE_NAME[] = {"IDLE", "STARTING", "RUNNING", "STOPPING"};
static CycleState state = IDLE;
static uint16_t vibSeconds = 0, quietSeconds = 0;
static uint32_t startMs = 0;              // when vibration first began
static Reading pending[START_CONFIRM_S + START_ABORT_S + 2];  // samples from STARTING
static uint8_t pendingN = 0;
static Reading baseline;                  // latest idle reading
static bool baselineValid = false;
static uint32_t lastBaselineMs = 0;
static bool firstBaselineDone = false;

static void setState(CycleState s) {
  if (s == state) return;
  char msg[40];
  snprintf(msg, sizeof msg, "state %s -> %s", STATE_NAME[state], STATE_NAME[s]);
  state = s;
  debugComment(msg);
}

// Test cycles (protocol.md section 4, "M" lines): started/ended from the dashboard, not by
// vibration. While one runs, the vibration level is ignored.
static bool testCycle = false;
static bool testHasEnd = false;
static uint32_t testEndMs = 0;

static void beginCycle(uint32_t startAt) {
  uint32_t cycleNo = nextCycleNo++;
  cycleNoSave();
  storageStartCycle(cycleNo, bootId, startAt, baselineValid ? &baseline : nullptr);
  helloDue = true;  // tell the computer straight away
}

static void endCycle(uint32_t now) {
  storageEndCycle(now);
  setState(IDLE);
  testCycle = false;
  lastBaselineMs = now;  // next baseline after things have settled
  helloDue = true;
}

// M,1[,seconds] -> start (or take over) a cycle now; M,0 -> end the current cycle now.
static void testCycleCommand(bool start, uint32_t seconds) {
  uint32_t now = millis();
  if (start) {
    if (state == IDLE) {
      beginCycle(now);
    } else if (state == STARTING) {  // vibration had just begun: keep those samples
      beginCycle(startMs);
      for (uint8_t k = 0; k < pendingN; k++) storageAddSample(pending[k]);
    }
    pendingN = 0;
    quietSeconds = 0;
    testCycle = true;
    testHasEnd = seconds > 0;
    testEndMs = now + seconds * 1000UL;
    setState(RUNNING);
    char msg[48];
    if (testHasEnd) snprintf(msg, sizeof msg, "test cycle started (%lu s)", (unsigned long)seconds);
    else snprintf(msg, sizeof msg, "test cycle started (until M,0)");
    debugComment(msg);
  } else {
    if (state == RUNNING || state == STOPPING) endCycle(now);
    else if (state == STARTING) setState(IDLE);
    testCycle = false;
    debugComment("test cycle ended");
  }
  helloDue = true;
}

// Called once per second with this second's vibration and (if valid) sensor reading.
static void cycleTick(uint32_t now, float vib, bool haveReading, const Reading &r) {
  bool shaking = vib >= VIB_THRESHOLD_G;
  if (testCycle) {  // test cycle: record, ignore vibration, end on M,0 or the timer
    if (haveReading) storageAddSample(r);
    if (testHasEnd && (int32_t)(now - testEndMs) >= 0) {
      debugComment("test cycle finished (timer)");
      endCycle(now);
    }
    return;
  }
  switch (state) {
    case IDLE:
      if (shaking) {
        setState(STARTING);
        startMs = now;
        vibSeconds = 1;
        quietSeconds = 0;
        pendingN = 0;
        if (haveReading) pending[pendingN++] = r;
      } else if (haveReading && (!firstBaselineDone || now - lastBaselineMs >= BASELINE_MS)) {
        baseline = r;
        baselineValid = true;
        lastBaselineMs = now;
        firstBaselineDone = true;
        char line[MAX_LINE_LEN];
        lineBaseline(line, sizeof line, bootId, baseline);
        linkSendLine(line);  // live only; skipped if no computer
      }
      break;

    case STARTING:
      if (haveReading && pendingN < sizeof pending / sizeof pending[0]) pending[pendingN++] = r;
      if (shaking) {
        vibSeconds++;
        quietSeconds = 0;
      } else if (++quietSeconds >= START_ABORT_S) {
        setState(IDLE);  // false start (door slam, bump)
        break;
      }
      if (vibSeconds >= START_CONFIRM_S) {
        beginCycle(startMs);
        for (uint8_t k = 0; k < pendingN; k++) storageAddSample(pending[k]);
        pendingN = 0;
        quietSeconds = 0;
        setState(RUNNING);
      }
      break;

    case RUNNING:
    case STOPPING:
      if (haveReading) storageAddSample(r);
      if (shaking) {
        quietSeconds = 0;
        setState(RUNNING);
      } else {
        setState(STOPPING);
        if (++quietSeconds >= STOP_CONFIRM_S) endCycle(now);
      }
      break;
  }
}

// Board state for the H line.
static const char *helloState() {
  for (uint8_t i = 0; i < NUM_SLOTS; i++) {
    const Slot &s = slots[i];
    if (i == curSlot || !s.used || s.done || s.erasing) continue;
    if (!s.cSent || s.nextSeq < slotSamples(s) || (s.hasE && !s.eSent)) return "uploading";
  }
  return (state == RUNNING || state == STOPPING) ? "running" : "idle";
}

static void sendHelloIfDue(uint32_t now) {
  if (!linkReady) return;
  if (!helloDue && !sensorCodesChanged && now - lastHelloMs < HELLO_MS) return;
  char line[MAX_LINE_LEN];
  lineHello(line, sizeof line, bootId, now, helloState(), storageBacklog(), sensorIn.code, sensorOut.code);
  if (linkSendLine(line)) {
    helloDue = false;
    sensorCodesChanged = false;
    lastHelloMs = now;
  }
}

// Sends stored cycles, oldest first: C, then samples not yet confirmed, then E.
// Live samples go through here too (written to storage first, then sent at once).
static void uploadStep(uint32_t now) {
  if (!linkReady) return;
  for (uint8_t sent = 0; sent < UPLOAD_LINES_PER_LOOP;) {
    int8_t pick = -1;
    for (uint8_t i = 0; i < NUM_SLOTS; i++) {
      const Slot &s = slots[i];
      if (!s.used || s.done || s.erasing) continue;
      bool work = !s.cSent || s.nextSeq < slotSamples(s) || (s.hasE && !s.eSent);
      if (work && (pick < 0 || s.cycleNo < slots[pick].cycleNo)) pick = i;
    }
    if (pick < 0) return;  // nothing to send
    Slot &s = slots[pick];
    char line[MAX_LINE_LEN];
    LogRec r;

    if (!s.cSent) {  // C first - also when resuming (protocol.md section 5)
      if (!readRec(pick, 0, r)) {
        s.done = true;  // unreadable slot: give up on it
        continue;
      }
      Reading base = {r.a, r.pIn, r.pOut, r.tIn, r.tOut};
      lineCycleStart(line, sizeof line, r.bootId, r.cycleNo, r.ms, (r.flags & FLAG_HAS_BASELINE) ? &base : nullptr);
      if (!linkSendLine(line)) return;
      s.cSent = true;
    } else if (s.nextSeq < slotSamples(s)) {
      if (readRec(pick, s.nextSeq + 1, r) && r.type == 'S') {
        Reading v = {r.ms, r.pIn, r.pOut, r.tIn, r.tOut};
        bool live = r.bootId == bootId && now - r.ms < LIVE_WINDOW_MS;
        lineSample(line, sizeof line, r.bootId, r.cycleNo, r.a, v, live);
        if (!linkSendLine(line)) return;
      }
      s.nextSeq++;  // a damaged record is skipped (the computer reports it as missing)
    } else {
      if (!readRec(pick, s.count - 1, r) || r.type != 'E') {
        s.eSent = true;
        continue;
      }
      lineCycleEnd(line, sizeof line, r.bootId, r.cycleNo, r.ms, r.a);
      if (!linkSendLine(line)) return;
      s.eSent = true;
    }
    sent++;
  }
}

// =====================================================================================
// 8. setup() / loop()
// =====================================================================================

static uint32_t lastSensorMs = 0, lastImuMs = 0, lastSecondMs = 0;

static void ledWrite(uint8_t pin, bool on) { digitalWrite(pin, on ? LED_ON_LEVEL : !LED_ON_LEVEL); }

static void updateLeds(uint32_t now) {
  ledWrite(LED_BLUE, linkReady);
  bool blink = (now / 250) % 2;
  ledWrite(LED_GREEN, state == RUNNING || state == STOPPING || (state == STARTING && blink));
  ledWrite(LED_RED, !sensorsOk() || !storeOnFlash);
}

static void debugStatus(uint32_t now, float vib, bool have, const Reading &r) {
#if DEBUG
  if (!Serial) return;
  char a[16], b[16], c[16], d[16], dp[16];
  unsigned long milliG = (unsigned long)lroundf(vib * 1000.0f);  // integer: avoids printf("%f")
  if (have) {
    Serial.printf("t=%lus %-8s vib=%lumg  in %s Pa %s C  out %s Pa %s C  dP %s Pa  err %u/%u  link=%d backlog=%lu\n",
                  (unsigned long)(now / 1000), (testCycle ? "TEST" : STATE_NAME[state]), milliG, fmt2(a, sizeof a, r.pIn),
                  fmt2(b, sizeof b, r.tIn), fmt2(c, sizeof c, r.pOut), fmt2(d, sizeof d, r.tOut),
                  fmt2(dp, sizeof dp, r.pIn - r.pOut), sensorIn.code, sensorOut.code, linkReady,
                  (unsigned long)storageBacklog());
  } else {
    Serial.printf("t=%lus %-8s vib=%lumg  (no valid reading)  err %u/%u  link=%d\n", (unsigned long)(now / 1000),
                  (testCycle ? "TEST" : STATE_NAME[state]), milliG, sensorIn.code, sensorOut.code, linkReady);
  }
#endif
}

void setup() {
  Serial.begin(115200);  // never wait for it: the board must run without USB
  pinMode(LED_RED, OUTPUT);
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_BLUE, OUTPUT);
  ledWrite(LED_RED, true);  // red during start-up

  Wire.begin();
  Wire.setClock(I2C_CLOCK_HZ);
  sensorBegin(sensorIn);
  sensorBegin(sensorOut);
  vibBegin();

  linkBegin();       // also creates the random boot_id
  storageBegin();    // flash scan + cycle number
  sensorCodesChanged = true;

  char msg[64];
  snprintf(msg, sizeof msg, "started, boot_id %lu, advertising as %s", (unsigned long)bootId, BLE_NAME);
  debugComment(msg);
  lastSensorMs = lastImuMs = lastSecondMs = millis();
}

void loop() {
  uint32_t now = millis();

  // Bluetooth: detect the computer subscribing / leaving, read its replies.
  bool ready = Bluefruit.connected() && bleuart.notifyEnabled();
  if (ready && !linkReady) {
    linkReady = true;
    linkOnSubscribed();
  } else if (!ready && linkReady) {
    linkReady = false;
    debugComment("computer disconnected");
  }
  if (linkReady) linkPollRx();

  // Sensors at 10 Hz, accelerometer at 50 Hz.
  if (now - lastSensorMs >= SENSOR_READ_MS) {
    lastSensorMs += SENSOR_READ_MS;
    sensorPoll(sensorIn, now);
    sensorPoll(sensorOut, now);
  }
  if (now - lastImuMs >= IMU_READ_MS) {
    lastImuMs += IMU_READ_MS;
    vibPoll();
  }

  // Once per second: average, update the cycle state, record.
  if (now - lastSecondMs >= SAMPLE_MS) {
    lastSecondMs += SAMPLE_MS;
    if (now - lastSecondMs > 5 * SAMPLE_MS) lastSecondMs = now;  // don't "catch up" after a long stall
    Reading r = {};
    bool have = sensorsTakeSecond(r, now);
    float vib = vibTakeSecond();
    cycleTick(now, vib, have, r);
    debugStatus(now, vib, have, r);
  }

  sendHelloIfDue(now);
  uploadStep(now);
  storageEraseStep();
  updateLeds(now);
}
