-- ============================================================
-- 098 — Retire daily_fleet_summary and daily_machine_summary
-- ============================================================
-- These tables were populated by the aggregate-daily-summary pg_cron job,
-- which pulled from saved_shift_logs. The frontend now reads the same data
-- directly from ClickHouse via /api/analytics/fleet-trend?granularity=1d,
-- which uses v_fleet_trend_1d (reset-aware delta math over raw shift_readings).
--
-- With no remaining readers or writers, both tables and the cron job are safe
-- to drop. saved_shift_logs (the cron's source) is also unblocked for removal
-- by migration 097 Section 3.
-- ============================================================

-- ── Unschedule the daily aggregation cron ───────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aggregate-daily-summary') THEN
    PERFORM cron.unschedule('aggregate-daily-summary');
  END IF;
END $$;

-- ── Drop the aggregation function ───────────────────────────────────────────
DROP FUNCTION IF EXISTS aggregate_daily_summary(date);

-- ── Drop the tables ─────────────────────────────────────────────────────────
DROP TABLE IF EXISTS daily_fleet_summary CASCADE;
DROP TABLE IF EXISTS daily_machine_summary CASCADE;
