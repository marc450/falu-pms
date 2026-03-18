-- Migration 035: backfill analytics_readings.minutes_running from swabs_produced
--
-- analytics_readings has 38,754 rows with swabs_produced populated but
-- minutes_running = NULL (the old downsample function pre-dated that column).
--
-- Formula:
--   minutes_running = swabs_produced / speed_ppm
--   where speed_ppm (pcs per minute when running) is:
--     CB machines  → 2800 pcs/min
--     CT machines  → 2300 pcs/min
--
-- LEAST(5.0, ...) caps at the 5-minute bucket duration so utilisation
-- never exceeds 100% in a single bucket.
-- Rows where swabs_produced = 0 keep minutes_running = 0 (machine was
-- stopped for the entire bucket).

UPDATE analytics_readings ar
SET minutes_running = ROUND(
  LEAST(
    5.0,
    ar.swabs_produced::numeric / CASE
      WHEN m.machine_code ILIKE 'CB%' THEN 2800.0
      WHEN m.machine_code ILIKE 'CT%' THEN 2300.0
      ELSE 2800.0   -- safe default
    END
  ),
  2
)
FROM machines m
WHERE m.id = ar.machine_id
  AND ar.minutes_running IS NULL;
