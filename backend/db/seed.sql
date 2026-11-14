-- seed.sql - starting rows the system needs before any data arrives.
--
-- What it does:
--   Adds the one sensor board, its empty status row, and the default lint
--   thresholds. Runs right after schema.sql (Docker runs backend/db/*.sql in
--   alphabetical order, only when the database is first created).
--
-- Talks to:
--   - device_id 'dryer-1' must match DEVICE_ID in the repo-root .env, because the
--     Python receiver tags every reading with that ID.
--   - ble_name 'XIAO-BLE' must match Bluefruit.setName(...) in the firmware.
--
-- To add another board later, insert one more row into devices and device_status.

INSERT INTO devices (device_id, name, ble_name)
VALUES ('dryer-1', 'Dryer', 'XIAO-BLE');

INSERT INTO device_status (device_id, connected)
VALUES ('dryer-1', false);

INSERT INTO lint_settings (id) VALUES (1);   -- all thresholds use their defaults
