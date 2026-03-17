-- Migration 013: Add error_time to shift_readings and saved_shift_logs
--
-- Root cause: error_time was only tracked in machines.error_time_calc
-- (a live accumulator reset at every shift change) and was never persisted
-- into the per-reading or per-shift log rows.  This meant all historical
-- error-time data was lost at every shift boundary.
--
-- Fix: add error_time BIGINT (minutes) to both tables so the bridge can
-- write the current accumulated error-time value alongside every reading
-- and at every shift-end save-flag event.

ALTER TABLE shift_readings
  ADD COLUMN IF NOT EXISTS error_time BIGINT DEFAULT 0;

ALTER TABLE saved_shift_logs
  ADD COLUMN IF NOT EXISTS error_time BIGINT DEFAULT 0;

-- Back-fill existing rows to 0 (they never had this data).
UPDATE shift_readings   SET error_time = 0 WHERE error_time IS NULL;
UPDATE saved_shift_logs SET error_time = 0 WHERE error_time IS NULL;
