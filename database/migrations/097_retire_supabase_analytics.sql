-- ============================================================
-- 097 — Retire the Supabase analytics plumbing (ClickHouse cutover)
-- ============================================================
-- ClickHouse is now the sole store for raw readings, downtime history,
-- crew/shift reconstruction and the trend ladder. The bridge no longer
-- writes shift_readings / saved_shift_logs / error_shift_summary to
-- Supabase, and the data-quality monitor has been retired. This migration
-- removes the orphaned Supabase plumbing that those writes used to feed.
--
-- KEPT in Supabase (do NOT drop): machines, notification_log, error_events
-- (error_events still drives the tablet's Realtime error alerts; the bridge
-- still writes it and prunes it to 48h), plus all config tables.
--
-- Sections 1 & 2 are safe to run now: nothing in the app reads these objects
-- anymore (frontend analytics read the bridge's ClickHouse endpoints).
-- Section 3 is optional and DESTRUCTIVE of the frozen Supabase history copies
-- — run it only once you are comfortable that ClickHouse holds everything.
-- ============================================================


-- ── Section 1: unschedule the orphaned pg_cron jobs ─────────────────────────
-- aggregate-bucket-5m / cleanup-bucket-5m populated bucket_analytics_5m from
-- the (now unwritten) Supabase shift_readings; data-quality-check scanned it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aggregate-bucket-5m') THEN
    PERFORM cron.unschedule('aggregate-bucket-5m');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-bucket-5m') THEN
    PERFORM cron.unschedule('cleanup-bucket-5m');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'data-quality-check') THEN
    PERFORM cron.unschedule('data-quality-check');
  END IF;
END $$;


-- ── Section 2: drop the orphaned functions, tables and retired RPCs ─────────
-- Functions first (they depend on the tables), then the tables, then the
-- analytics RPCs the frontend used before the ClickHouse cutover.
DROP FUNCTION IF EXISTS aggregate_recent_buckets(interval);
DROP FUNCTION IF EXISTS aggregate_all_cells_for_bucket(timestamptz);
DROP FUNCTION IF EXISTS aggregate_cell_bucket(uuid, timestamptz);
DROP FUNCTION IF EXISTS check_data_quality(interval, numeric, numeric);

-- Bucket rollup table + the data-quality alert table (CASCADE clears any
-- leftover dependent objects from earlier migrations).
DROP TABLE IF EXISTS bucket_analytics_5m CASCADE;
DROP TABLE IF EXISTS data_quality_alerts CASCADE;

-- Retired Supabase analytics RPCs — superseded by the bridge's ClickHouse
-- endpoints (/api/analytics/fleet-trend, /crew-shifts, /downtime-summary,
-- /machine-errors, /machine-shifts). No remaining caller.
DROP FUNCTION IF EXISTS get_fleet_trend_minute(timestamptz, timestamptz, uuid[]);
DROP FUNCTION IF EXISTS get_error_shift_summary(date, date);
DROP FUNCTION IF EXISTS get_machine_shift_summary(timestamptz, timestamptz);


-- ── Section 3 (OPTIONAL, DESTRUCTIVE): drop the frozen history tables ───────
-- These tables receive no more writes. ClickHouse holds the full history, so
-- they are only a frozen Supabase copy. Uncomment and run when you are ready
-- to reclaim the space. (error_events is intentionally NOT here — it stays.)
--
-- DROP TABLE IF EXISTS shift_readings     CASCADE;
-- DROP TABLE IF EXISTS saved_shift_logs   CASCADE;
-- DROP TABLE IF EXISTS error_shift_summary CASCADE;
