-- ============================================================
-- Migration 041b: Seed hourly_analytics from existing shift_readings
-- ============================================================
-- Run ONCE manually in the Supabase SQL editor after 041 has been applied.
-- Backfills the past 48 complete hours so the "Last 24 hours" chart is
-- populated immediately without waiting for the first pg_cron run.
--
-- aggregate_all_cells_for_hour() is idempotent (cell_aggregation_log
-- prevents double-writes), so this script is safe to run multiple times.
-- ============================================================

DO $$
DECLARE
  v_hour timestamptz;
BEGIN
  FOR v_hour IN
    SELECT generate_series(
      date_trunc('hour', now()) - interval '48 hours',
      date_trunc('hour', now()) - interval '1 hour',
      interval '1 hour'
    )
  LOOP
    PERFORM aggregate_all_cells_for_hour(v_hour);
  END LOOP;
END $$;

-- Verify: expect roughly 18 machines x 48 hours = ~864 rows (may vary
-- depending on how many shift_readings exist and how many shifts were active)
SELECT
  COUNT(*)          AS total_rows,
  MIN(plc_hour)     AS earliest_hour,
  MAX(plc_hour)     AS latest_hour,
  COUNT(DISTINCT machine_code) AS machines_covered
FROM hourly_analytics;
