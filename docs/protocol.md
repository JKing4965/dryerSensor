# Bluetooth Message Format (protocol v1)

This document is the **contract between the firmware (`arduino_code/main.ino`) and the
Python receiver (`backend/src/dryer_backend/protocol.py`)**. Both sides must follow it
exactly. To change it, edit this file first, bump the version number, and update both
sides in the same pull request.

---

## 1. Transport

| Item | Value |
|---|---|
| Bluetooth service | Nordic UART Service (NUS), as set up by `BLEUart` in the Bluefruit library |
| Board → computer | notifications on NUS TX `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |
| Computer → board | writes to NUS RX `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| Advertised name | `XIAO-BLE` (must match `BLE_DEVICE_NAME` in `.env`) |
| Encoding | plain ASCII text |
| Framing | **one message per line, ending in `\n`** (a `\r` before it is ignored) |
| Max line length | 200 characters (longer lines are discarded) |

Bluetooth delivers data in small packets (20 bytes by default). One line may arrive in
several packets, or one packet may hold several lines. The receiver joins the bytes and
only parses complete lines. The firmware does not need to care where packets split.

## 2. General rules

- Fields are separated by commas `,` with **no spaces**. The first field is the message type.
- **Pressure** is in **pascals (Pa)**, with up to 2 decimals. The Adafruit BMP5xx library
  reports hPa, so **multiply by 100**.
- **Temperature** is in **°C**, with up to 2 decimals.
- `p_in` / `t_in` come from the sensor **under the lint screen**; `p_out` / `t_out` from the
  sensor in **room air**.
- `ms` is the board's `millis()` value, an unsigned 32-bit counter that wraps after about 49.7 days.
  The receiver handles the wrap.
- `boot_id` is a **random non-zero unsigned 32-bit number** picked at every power-up
  (use the nRF52 hardware random number generator). It tells the receiver which `ms`
  clock a message belongs to.
- `cycle_no` is an unsigned 32-bit counter, **stored in flash**, that increases by 1 for
  every dryer cycle and is never reused, even after a restart.
- `seq` is the sample number within a cycle: 0, 1, 2, …
- Lines starting with `#` are **debug comments**. The receiver logs and ignores them.
- Accepted value ranges (anything outside is rejected as a bad line):
  - pressure: 30 000–125 000 Pa, the BMP585's range
  - temperature: −40 to 85 °C
  - `boot_id`, `ms`, `cycle_no`, `seq`: 0 to 4 294 967 295

## 3. Board → computer

| Type | Format | When |
|---|---|---|
| **H** hello | `H,<version>,<boot_id>,<ms>,<state>,<backlog_count>,<err_in>,<err_out>` | **First line after every connection**, then every 30 s while connected, and **immediately whenever a sensor error code changes** |
| **B** baseline | `B,<boot_id>,<ms>,<p_in>,<t_in>,<p_out>,<t_out>` | While idle and connected, every 30–60 s. Live only, never saved to flash |
| **C** cycle start | `C,<boot_id>,<cycle_no>,<ms>,<base_ms>,<base_p_in>,<base_t_in>,<base_p_out>,<base_t_out>` | When vibration starts a cycle |
| **S** sample | `S,<boot_id>,<cycle_no>,<seq>,<ms>,<p_in>,<t_in>,<p_out>,<t_out>,<src>` | Every sample during a cycle |
| **E** cycle end | `E,<boot_id>,<cycle_no>,<ms>,<n_samples>` | When vibration has stopped and the cycle is over |
| **#** comment | `# any text` | Any time, for debugging |

Field notes:
- **H** `version` is `1` for this document. `state` is `idle`, `running` or `uploading`.
  `backlog_count` is the number of samples still saved in flash and not yet acknowledged.
  `err_in` / `err_out` are the **sensor error codes** (section 3.1) for the sensor under the
  lint screen and the room-air sensor.
- **C** carries the **pre-cycle baseline**: the latest idle reading taken before the
  vibration started, with its own `base_ms`. That reading is saved to flash together with the
  cycle, so it survives even if no computer was connected. If the board has no baseline yet
  (for example it just powered up), it leaves the five baseline fields empty:
  `C,<boot_id>,<cycle_no>,<ms>,,,,,`. The short form `C,<boot_id>,<cycle_no>,<ms>` is also accepted.
- **S** `src` is `L` for a live sample sent as it was measured, or `F` for one uploaded from flash.
- **E** `n_samples` is how many S lines the cycle has in total. The receiver uses it to
  check that nothing is missing.

### 3.1 Sensor error codes

| Code | Name | Meaning | How the firmware decides |
|---|---|---|---|
| `0` | ok | Sensor found and giving valid readings | — |
| `1` | missing | **Cannot find the sensor** on the I2C bus | `bmp.begin()` fails, or the sensor stops answering at its address (0x46 or 0x47) |
| `2` | broken | **Sensor answers but its readings are bad** | `performReading()` fails, or the value is outside the accepted range in section 2 (30 000–125 000 Pa, −40 to 85 °C), **3 times in a row** |

Rules:
- The firmware checks both sensors at power-up and on every reading.
  - A sensor that answers again after being `missing` goes back to `0`.
  - A `broken` sensor goes back to `0` after 3 good readings in a row.
- Whenever either code changes, the board sends an **H line right away**, so the dashboard
  learns about it within seconds instead of waiting up to 30 s.
- **While either sensor's code is not `0`, the board sends no B or S lines.** One sensor
  alone can't produce ΔP, and bad numbers must never reach the database. C and E lines are
  still sent, so the cycle is recorded and shows up as missing samples.
  `n_samples` in the E line counts only the S lines actually sent.

## 4. Computer → board

| Type | Format | When |
|---|---|---|
| **T** time | `T,<unix_ms>` | Right after each H line. Real time in milliseconds since 1970 (UTC). Optional for the board to use |
| **A** acknowledge | `A,<cycle_no>,<seq>,<done>` | After the receiver has stored data. `done` = `1` once the E line is stored too |

- `A,<cycle_no>,<seq>,0` means "everything up to and including `seq` of this cycle is stored".
- `A,<cycle_no>,<seq>,1` means "the whole cycle is stored". **Only then may the board erase that
  cycle from flash.**

## 5. Flash backlog rules (firmware)

1. Each cycle is saved to flash as it happens: the C line data, every S sample, then the E
   line data. This is done **whether or not a computer is connected**.
2. On connecting, the board sends **H first**, then uploads any saved cycles **oldest first**,
   in order: C, then S lines (`src=F`), then E.
3. While a backlog exists, new samples are also queued behind it, so the receiver always
   gets each cycle in order. Once the backlog is empty, samples are sent live (`src=L`).
4. A cycle is erased from flash only after `A,<cycle_no>,<seq>,1`.
5. If the connection drops mid-upload, the board resends that cycle on the next connection.
   It may skip samples at or below the last acknowledged `seq`, but **must resend the C line
   first**. The receiver ignores samples it already has, so resending is always safe.

## 6. How the receiver turns `ms` into real time

- Each H line gives an exact link: "board time `ms` = computer time now" for that `boot_id`.
  Every message with the same `boot_id`, live or from flash, is converted with the latest
  link for that boot.
- If a message arrives for a `boot_id` with no H line yet, its time is **estimated** from when
  it arrived and stored with `time_estimated = true`. This happens when the board restarted
  between recording and uploading. Those samples' times are approximate.
- Differences between `ms` values are computed modulo 2³², so the `millis()` wrap is handled.

## 7. Example session

Board was idle, the dryer ran a 4-sample cycle while the computer was **not** connected,
then the computer connected and the next cycle ran live.

```
H,1,305419896,3600000,uploading,4,0,0
C,305419896,7,1800000,1770000,101300.25,23.10,101325.50,22.80
S,305419896,7,0,1801000,101180.40,30.55,101325.40,22.81,F
S,305419896,7,1,1802000,101178.10,31.02,101325.60,22.81,F
S,305419896,7,2,1803000,101176.90,31.48,101325.30,22.82,F
S,305419896,7,3,1804000,101177.30,31.90,101325.50,22.82,F
E,305419896,7,1805000,4
# backlog uploaded
B,305419896,3630000,101300.10,23.40,101325.20,22.90
C,305419896,8,3660000,3630000,101300.10,23.40,101325.20,22.90
S,305419896,8,0,3661000,101181.00,30.10,101325.10,22.90,L
S,305419896,8,1,3662000,101179.20,30.60,101325.00,22.91,L
E,305419896,8,3663000,2
```

What the computer sends back, roughly:
```
T,1794672000000
A,7,3,0
A,7,3,1
A,8,1,0
A,8,1,1
```

To try this by hand before `main.ino` exists: upload `arduino_code/BLEtest.ino`, start the
receiver, and paste these lines into the Arduino Serial Monitor (line ending "Newline").
`BLEtest.ino` forwards them over Bluetooth unchanged.

## 8. Firmware checklist

- [ ] Advertise as `XIAO-BLE` with the NUS service
- [ ] Pick a random non-zero `boot_id` at power-up; keep `cycle_no` in flash
- [ ] Send `H` immediately on connect, every 30 s, and whenever a sensor error code changes
- [ ] Detect sensor errors: `1` = not found on I2C, `2` = bad readings 3× in a row; send no B/S lines while either is not `0`
- [ ] Send `B` every 30–60 s while idle and connected; keep the latest one for the next `C`
- [ ] Convert hPa → Pa (× 100); `p_in`/`t_in` = sensor under the lint screen
- [ ] Save every cycle (C, S…, E) to flash; upload oldest first after `H`; erase only after `A,…,1`
- [ ] End every line with `\n`; no spaces; stay under 200 characters
- [ ] Don't block on `while (!Serial)`, because the board must run without USB
