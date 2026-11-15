# Dryer Sensor: Firmware Plan (`arduino_code/main.ino`)

This plan builds the board firmware step by step, following the flow outlined in
`arduino_code/main.ino`. It must match **[docs/protocol.md](protocol.md)** exactly.
The backend and dashboard already implement that protocol and are finished
(see [build_plan.md](build_plan.md)).

Steps marked **🛑 CHECKPOINT** are pauses. Check that everything works before moving on.
Before each checkpoint I **compile the sketch with arduino-cli**, which ships inside your
Arduino IDE, so you only upload code that builds.

> **Status:** the wiring was already verified with the test sketches, so `main.ino` was built
> **in one go**, covering steps H1–H5. It compiles cleanly (18% of flash, 6% of RAM, no warnings).
> The checkpoints below are now a **verification order** to work through with the uploaded sketch.
> If one fails, fix it before moving to the next.
>
> **Sensor addresses (as wired): inside = 0x47** (`BMP5XX_ALTERNATIVE_ADDRESS`, the sensor
> `BMP585_test.ino` used), **outside = 0x46** (`BMP5XX_DEFAULT_ADDRESS`).

---

## 0. The flow from `main.ino`, and what changed

The outline in `main.ino`:
> advertise BLE → connect → sense dryer vibration via IMU → record temperature and pressure
> (send an initial reading from before the dryer starts) → send over BLE → end when there is
> no vibration → read "filter cleaned" → reset, or keep monitoring and remind the user to clean lint

How each part maps onto the firmware:

| Outline step | In the firmware | Notes |
|---|---|---|
| Advertise BLE, connect | Advertise as `XIAO-BLE` forever; the computer connects | The computer, not a phone, is the receiver |
| Sense vibration via IMU | Vibration level from the built-in LSM6DS3 accelerometer, with start/stop debounce | Section 2.4 |
| Initial reading before the dryer starts | An idle **baseline** taken every 45 s and kept; it goes into the cycle's `C` line | Sent live as `B` while connected |
| Record temperature and pressure | Both BMP585s, averaged into one sample per second | Section 2.3 |
| Send over BLE | `S` lines live while connected; **always saved to flash too** | The dryer may start before the computer connects |
| End when no vibration | `E` line after a quiet period | Long enough not to split a cycle at drum pauses |
| Read "filter cleaned" → reset / remind | **Not in firmware.** The dashboard's Filter cleaned button and the lint verdict do this | Decided during the backend/frontend plan |

### State machine

```
            vibration ≥ threshold                 vibration for START_CONFIRM_S
   ┌──────┐ ─────────────────────▶ ┌──────────┐ ───────────────────────────────▶ ┌─────────┐
   │ IDLE │                         │ STARTING │                                   │ RUNNING │ ── one S per second
   └──────┘ ◀───────────────────── └──────────┘                                   └─────────┘
      ▲  ▲      quiet again                                       quiet ≥ threshold │      ▲
      │  │   (false start, e.g. a door slam)                                        ▼      │ vibration again
      │  │                                                                   ┌──────────┐  │ (drum pause, keep going)
      │  └──────────────── quiet for STOP_CONFIRM_S: send E ───────────────── │ STOPPING │──┘
      │                                                                       └──────────┘
   baseline every 45 s while IDLE (kept for the next C line; sent as B if connected)
```

**At the START_CONFIRM_S moment**, the board sends `C` with the latest baseline, using the cycle's
start time from when vibration first began (the STARTING moment).

**Samples during STARTING are kept.** They're buffered in RAM and become the first `S` lines, so
the blower spin-up isn't lost while the board waits to confirm the start.

**Samples during STOPPING are sent too.** If vibration returns, the cycle simply continues.

---

## 1. Hardware facts (checked on this machine)

| Item | Value | Source |
|---|---|---|
| Board package | **Seeed nRF52 Boards 1.1.13**, board **"Seeed XIAO nRF52840 Sense"** (`Seeeduino:nrf52:xiaonRF52840Sense`) | Arduino15 packages |
| ⚠ Not this one | "XIAO nRF52840 Sense **(No Updates)**" = mbed core, which has **no `bluefruit.h`** | |
| BMP585 bus | `Wire`, SDA = D4, SCL = D5 | variant.h |
| BMP585 addresses | `BMP5XX_DEFAULT_ADDRESS` = **0x46**, `BMP5XX_ALTERNATIVE_ADDRESS` = **0x47**. `BMP585_test.ino` uses 0x47 | Adafruit_BMP5xx 1.0.3 |
| IMU | LSM6DS3TR-C on its **own** bus `Wire1` (pins 17/16), power pin 15, INT1 pin 18. The library switches to `Wire1` itself | Seeed_Arduino_LSM6DS3 2.0.7 |
| External flash | **P25Q16H, 2 MB**, QSPI | variant.h (`EXTERNAL_FLASH_DEVICES`) |
| Internal flash file system | `InternalFS` (LittleFS, small) | core library InternalFileSytem |
| Program / RAM | 811 KB / 237 KB; `BLEtest.ino` uses 14% / 5% | test compile |

### Libraries (all already installed)
| Library | Used for | Seen in |
|---|---|---|
| `bluefruit.h` (core) | BLE advertising, Nordic UART (`BLEUart`) | BLEtest.ino |
| `Adafruit_TinyUSB.h` (core) | USB serial on this core | BLEtest.ino, charging_test.ino |
| `Wire.h` | I2C | I2C_test.ino, BMP585_test.ino |
| `Adafruit_BMP5xx.h` 1.0.3 (+ Adafruit_Sensor, BusIO) | BMP585: `begin(addr, &Wire)`, `performReading()`, `.pressure` (**hPa**), `.temperature` (°C), `dataReady()` | BMP585_test.ino |
| `LSM6DS3.h` (Seeed 2.0.7) | Accelerometer: `LSM6DS3 imu(I2C_MODE, 0x6A)`, `readFloatAccelX/Y/Z()` | accel_LED_test.ino |
| `Adafruit_SPIFlash.h` 5.1.1 | Raw read/write/erase of the 2 MB QSPI flash | new |
| `InternalFileSystem.h` (core) | One small file holding the persistent `cycle_no` | new |

**Not used:** the core's `ExternalFS`. It is hard-wired for a **4 MB P25Q32H** chip
(`flash.begin(&P25Q32H, 1)`, 4 MB total). On this board's 2 MB chip it would wrap around
and corrupt data once it filled past 2 MB. The plan writes a small log of its own on top of
`Adafruit_SPIFlash` instead (section 2.5).

---

## 2. Key design decisions

### 2.1 One file
`main.ino` stays **one file**, matching the team's "copy the sketch into the Arduino IDE"
workflow. It's split into clearly commented sections (section 3). If it grows too long, it
can move to a sketch folder with tabs (`arduino_code/main/main.ino` + `.h` files) without
changing the logic.

### 2.2 Never block
- **No `delay()`** in the main loop and **no `while (!Serial)`**: the board must run on battery with no USB.
- Everything runs from `loop()` on `millis()` timers:
  - read sensors every 100 ms
  - read the IMU every 20 ms
  - produce a sample every 1 s
  - send a hello every 30 s
  - take a baseline every 45 s
- Bluetooth sends never wait. If the send queue is full, the rest is sent on the next `loop()`.

### 2.3 Pressure and temperature
- Two `Adafruit_BMP5xx` objects:
  - **inside** (under the lint screen): **`0x47`** (`BMP5XX_ALTERNATIVE_ADDRESS`, the one `BMP585_test.ino` used)
  - **outside** (room air): **`0x46`** (`BMP5XX_DEFAULT_ADDRESS`)

  The assignment is two constants (`ADDR_INSIDE`, `ADDR_OUTSIDE`) in the sketch's settings block.
- **Sensor settings:** start from `BMP585_test.ino`, but tuned for 1 Hz output:
  - pressure oversampling 32×, temperature 4×
  - IIR filter coefficient 3
  - output rate 10 Hz, normal mode
  - The board reads each sensor when `dataReady()` and **averages about 10 readings into each 1-second sample**.
- **Units:** `pressure × 100` (hPa → **Pa**). Sent with 2 decimals (protocol.md section 2).
- **Error codes** (protocol.md section 3.1):
  - `1` missing: `begin()` fails, or the sensor stops answering. The board retries `begin()` every 5 s.
  - `2` broken: `performReading()` fails, or a value is out of range, **3 times in a row**.
  - Back to `0` after 3 good readings in a row.
  - Any change sends an `H` line right away. No `B` or `S` lines while either code isn't `0`.

### 2.4 Vibration detection (IMU)
- Read the accelerometer at about 50 Hz and compute the magnitude `|a|`.
- Remove gravity with a slow running average, then take the **RMS over 1 s**: the "vibration level", in g.
- **Thresholds are constants to tune with a real dryer at checkpoint 4.** Starting values:
  - `VIB_THRESHOLD_G` = 0.03 g
  - `START_CONFIRM_S` = 10 s
  - `STOP_CONFIRM_S` = 90 s (longer than drum pauses; the anti-wrinkle tumbles after a cycle are short)
- A debug mode prints the vibration level every second over USB serial, and optionally as `#` comment lines over BLE, so thresholds can be read straight off the receiver log.
- **Later, optional:** the IMU's wake-on-motion interrupt (INT1, pin 18) to sleep while idle. Not needed while powered by USB.

### 2.5 Flash log (2 MB QSPI, `Adafruit_SPIFlash`)
- **Append-only circular log of fixed 32-byte records.** 2 MB holds 65,536 records, about 18 hours of samples at 1 Hz.

| Bytes | Field | Notes |
|---|---|---|
| 1 | magic `0xD5` | marks a written record (erased flash reads `0xFF`) |
| 1 | type | `C`, `S`, `E` or `A` (acknowledgement) |
| 1 | crc8 | over the other 31 bytes; a bad CRC = torn write, ignored |
| 1 | reserved | |
| 4 | boot_id | |
| 4 | cycle_no | |
| 4 | seq / base_ms / n_samples / acked_seq | depends on type |
| 4 | ms | board time |
| 4 + 4 | p_in, p_out | Pa × 100, int32 |
| 2 + 2 | t_in, t_out | °C × 100, int16 |

- **What gets written:**
  - Every cycle writes `C` (with its baseline), each `S`, then `E`.
  - An `A` record is appended when the receiver sends `A,<cycle>,<seq>,<done>`, so acknowledgements survive a restart.
- **At power-up:** scan the log (a few hundred ms) to find where to write next, which cycles aren't fully acknowledged, and the highest `cycle_no`.
- **Freeing space:** a 4 KB sector (128 records) is erased only when every cycle in it is acknowledged with `done = 1`. If the log is ever full of unacknowledged data, the **oldest** is overwritten and a `#` warning is sent.
- **Upload after `H`:** oldest first, `C` → `S` lines with `seq > acked` (marked `F`) → `E`. A dropped link resumes from the last acknowledged `seq` and always resends `C` first (protocol.md section 5).
- **`cycle_no`** is also stored in a tiny file in `InternalFS`. It's written at each cycle start, so it keeps counting up even when the log has been fully erased.

### 2.6 Bluetooth link
- **Setup:** `Bluefruit.configPrphBandwidth(BANDWIDTH_MAX)` before `begin()`, for a 247-byte MTU and faster uploads. Name `XIAO-BLE`, `BLEUart` (NUS), advertise forever. These are the `BLEtest.ino` settings plus the bandwidth line.
- **When "connected" starts** (protocol.md section 3): when `bleuart.notifyEnabled()` turns true. Then send `H` (state `uploading` if there's a backlog), followed by the backlog.
- **Sending:** every line goes out with **one `bleuart.write(buf, len)` call**, never byte by byte; we hit that bug in checkpoint 5.
- **Receiving:** incoming bytes are joined into lines and parsed:
  - `T,<unix_ms>`: stores the offset between board time and real time. Logged now, kept for later.
  - `A,<cycle>,<seq>,<done>`: updates the acknowledgement state and flash.
- **`boot_id`:** a random non-zero 32-bit number from the nRF52 hardware random number generator (`sd_rand_application_vector_get`, after `Bluefruit.begin()`).

### 2.7 Debugging
- A `DEBUG` constant turns on USB serial logging (115200): sensor values, vibration level, state changes, flash statistics.
- With `DEBUG_BLE` also on, short `#` comment lines go over Bluetooth. The receiver logs them as `board says: …`.

---

## 3. `main.ino` layout (one file, sections in this order)

1. **Header comment:** what the sketch does, what it talks to, board and library setup, how to upload. This follows the team's file-header rule.
2. **Settings:** pins, I2C addresses, timings, thresholds, `DEBUG` flags. Everything to tune in one block.
3. **Protocol helpers:** formatting `H`, `B`, `C`, `S`, `E` lines and parsing `T` / `A`.
4. **Sensors:** BMP585 setup, reading, averaging, error codes.
5. **Vibration:** IMU reading, vibration level, debounce.
6. **Flash log:** records, CRC, power-up scan, append, acknowledgements, sector freeing, upload cursor.
7. **Bluetooth link:** advertising, subscription detection, non-blocking send queue, receiving.
8. **Cycle state machine:** IDLE / STARTING / RUNNING / STOPPING, baselines, `C` / `S` / `E`.
9. **`setup()` and `loop()`:** short, just calls into the sections above.

---

## PART C: FIRMWARE STEPS

Each step **adds to** `main.ino`, and each checkpoint uses the real receiver and dashboard
(`--source ble`) where it can. Before every checkpoint I compile with
`arduino-cli compile --fqbn Seeeduino:nrf52:xiaonRF52840Sense`.

### H0. Board and wiring check (no new code)
- Arduino IDE: board **Seeed XIAO nRF52840 Sense** (not "No Updates").
- Both BMP585s on D4/D5: inside sensor at **0x47**, outside at **0x46**, sharing 3V3 and GND.
- Upload `I2C_test.ino`. It should list **0x46 and 0x47**. ✅ Already confirmed with the test sketches.
- Upload `accel_LED_test.ino` and shake the board. It should print accelerometer lines (proves the IMU works).
- New tiny test, `arduino_code/flash_test.ino`: prints the QSPI flash chip ID and size, writes, reads back, and erases one sector.

> **🛑 CHECKPOINT F1: hardware**
> - I2C scan shows both `0x46` and `0x47`.
> - The IMU prints values when shaken.
> - Flash test reports **2 MB (2097152 bytes)** and the write/read check passes.

### H1. Sensors only (USB serial)
- `main.ino` sections 1, 2, 4 and 9.
- Both BMP585s read at 10 Hz and averaged to 1 Hz. Prints `p_in t_in p_out t_out ΔP` in Pa and °C, plus the error codes.

> **🛑 CHECKPOINT F2: sensors**
> - Both sensors read about 101 kPa and room temperature. At rest, ΔP is small and steady; that's the offset the backend removes.
> - Blow gently across one sensor, or warm it with a finger: its values change.
> - Unplug the inside sensor's SDA: its code goes to **1** within about 1 s, and back to **0** after plugging it in again.
> - It runs with USB unplugged on battery (watch the LED). No `while(!Serial)` hang.

### H2. Bluetooth link and protocol (no cycles yet)
- Section 3 (protocol helpers) and section 7 (Bluetooth link).
- `H` when the computer subscribes and every 30 s; `B` every 45 s while idle. Receives and logs `T` and `A`.

> **🛑 CHECKPOINT F3: board → receiver → dashboard**
> - `uv run python -m dryer_backend.ingest --source ble` logs `link up`, the hello and `both sensors OK`, and **no** `skipped bad line`.
> - Dashboard Live shows **"Connected · dryer idle"**. `SELECT count(*) FROM readings WHERE kind='baseline'` grows every 45 s.
> - Unplug a sensor: the **red sensor banner** appears on the dashboard within seconds and `B` lines stop. Plug it back: the banner clears.
> - Reset the board: the receiver reconnects by itself and logs a new `boot_id`.

### H3. Vibration detection
- Section 5 and the state machine's IDLE / STARTING / RUNNING / STOPPING transitions, logged but with **no cycle data sent yet**.
- Debug printing of the vibration level.

> **🛑 CHECKPOINT F4: tune thresholds with the dryer**
> - Board taped to the dryer and **dryer off**: note the vibration level (noise floor).
> - **Dryer running:** note the level, then set `VIB_THRESHOLD_G` between the two.
> - Start the dryer: **RUNNING after about 10 s**. Open the door or stop it: **IDLE after about 90 s**.
> - Slam the door or bump the dryer: it may go to STARTING but **never** to RUNNING.
> - Write the chosen threshold values into the settings block (and this plan).

### H4. Cycles, sent live (RAM only)
- Section 8 completed: `C` (with baseline) → `S` every second → `E`, sent live while connected.
- While disconnected, cycles are kept **in RAM only** for this step (lost on reset). Flash comes in H5.

> **🛑 CHECKPOINT F5: a real cycle on the dashboard**
> - Run a short dryer cycle (10–15 min) with the receiver and dashboard running.
> - Live shows **"Dryer running · cycle #N"** with ΔP dropping under the screen and the inside temperature rising.
> - After the stop delay the cycle is **complete** on the Cycles page, with `n_samples` equal to the board's count and lint numbers present.
> - The receiver logs **no** bad lines, duplicates or missing samples.

### H5. Flash log (survives disconnects and restarts)
- Section 6: the 32-byte record log, power-up scan, acknowledgement records, sector freeing, upload cursor, `cycle_no` in `InternalFS`.

> **🛑 CHECKPOINT F6: offline recording**
> - **Receiver off**, run a short cycle, then start the receiver. The board says `H,…,uploading,N`, the cycle uploads (dashed line on its page), and its times are **before** the connection.
> - Stop the receiver mid-upload, then restart it: the upload resumes and the Cycles page shows **no duplicates**.
> - Run a cycle offline, **reset the board**, then connect: the cycle still uploads, marked "(approx.)" because the times are estimated.
> - After uploading, the debug log shows the cycle's flash space freed. `cycle_no` keeps counting up across resets.

### H6. Real use and tuning
- Mount everything: inside sensor under the lint screen, outside sensor in room air. The board and battery stay **outside** the hot airflow.
- Run real loads: **two with a freshly cleaned screen**, then several without cleaning.
- Check the Lint page: calibrating → clean → check soon as lint builds. Adjust `lint_settings` thresholds if needed. No reflash needed for that.
- Final clean-up: `DEBUG` off by default, header comment and settings documented, `docs/protocol.md` checklist ticked.

> **🛑 CHECKPOINT F7: full system**
> - A full-length real cycle is recorded end to end, with correct lint numbers.
> - Lint verdicts make sense against how dirty the screen really was.
> - Commit; the firmware is done.

---

## 3b. Notes for whoever edits `main.ino` (lessons from compiling it)

- **Define every custom type (struct/enum) in the "DATA TYPES" section, before any function.**
  The Arduino IDE inserts function prototypes right before the first function in the file,
  so a function taking a type defined further down fails with "'X' was not declared in this scope".
- **Don't name constants `LINE_MAX`** or other standard C macro names (`<limits.h>` defines it).
- **Internal file system:** write `LFS::File` and `LFS::FILE_O_READ`. Plain `File` clashes with
  SdFat's `File`, which `Adafruit_SPIFlash` pulls in.
- The IDE prints "Multiple libraries were found for Adafruit_SPIFlash.h". That's expected: the
  core bundles an older copy, and your installed 5.1.1 is the one used.
- Compile from the command line (the same compiler the IDE uses):
  `"%LOCALAPPDATA%\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn Seeeduino:nrf52:xiaonRF52840Sense <sketch folder>`

## 4. Risks and open questions

| Topic | Risk | Plan |
|---|---|---|
| Inside sensor wire length | Long I2C wires into the dryer cause errors (error code 2) | Keep the wire short, use I2C at 100 kHz (`Wire.setClock(100000)`), use twisted wire; watch error codes at F5 |
| Heat | The BMP585 is rated to 85 °C; LiPo cells are unsafe when hot | Only the inside sensor goes in the airflow; board and battery outside |
| Lint and moisture on the inside sensor | The port clogs, so readings drift | Mesh or membrane cover; compare baselines over weeks |
| Neighboring washer vibrating the dryer | False cycles | `START_CONFIRM_S` plus the receiver ignores cycles without steady running; tune at F4 |
| Flash wear | Repeated erases of the same sectors | The circular log spreads writes over all 512 sectors |
| BLE send queue | Lost lines if sends aren't checked | One `write` per line, check how many bytes were accepted, retry next loop |
| Battery life | No sleep mode yet | Run on USB power for now; IMU wake-on-motion is a later option |
| Sensor-to-address assignment | Inside/outside swapped by wiring | One constant; check at F2 (warm the inside sensor and see which value moves) |

## 5. Protocol checklist mapping (`docs/protocol.md` section 8)

| Checklist item | Step |
|---|---|
| Advertise as `XIAO-BLE` with NUS | H2 |
| Random `boot_id`; `cycle_no` kept in flash | H2, H5 |
| `H` on subscribe, every 30 s, and on sensor error changes | H2 |
| `B` every 30–60 s while idle; latest kept for the next `C` | H2 |
| hPa → Pa; `p_in` = sensor under the lint screen | H1 |
| Save every cycle to flash; upload oldest first after `H`; erase only after `A,…,1` | H5 |
| Lines end in `\n`, no spaces, under 200 characters | H2 |
| Detect sensor errors; no `B`/`S` lines while a code isn't `0` | H1, H2 |
| One `bleuart.write(buf, len)` per line | H2 |
| No `while (!Serial)` | H1 |
