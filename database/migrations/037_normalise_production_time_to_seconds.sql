-- Migration 037: normalise saved_shift_logs.production_time to seconds
--
-- Rows written before the simulator × 60 fix stored production_time in minutes.
-- Any value ≤ 720 must be minutes (720 min = 12 h = maximum possible shift uptime).
-- Multiply those rows by 60 so every row is consistently in seconds, matching
-- the real PLC spec and the current simulator output.
--
-- After this migration get_machine_shift_summary can use production_time / 3600
-- for all rows without any unit ambiguity.

UPDATE saved_shift_logs
SET production_time = production_time * 60
WHERE production_time > 0
  AND production_time <= 720;
