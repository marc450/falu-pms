-- ============================================================
-- Migration 089h: drop dead hourly_analytics infrastructure
-- ============================================================
-- aggregate_cell_hour (last rewritten in 085) has been silently
-- erroring on every cron tick since 085 shipped — the rewrite
-- referenced shift_readings columns (production_time, idle_time,
-- error_time, reject_rate, shift_number) that 066 had already
-- renamed (production_time_seconds, idle_time_seconds,
-- error_time_seconds, scrap_rate, shift_crew). The 48h retention
-- DELETE has quietly mopped up the empty table since.
--
-- Nothing in the frontend or bridge reads from hourly_analytics
-- (grep across frontend/src and mqtt-bridge/src returns zero
-- hits). bucket_analytics_5m covers the same need (24h intraday
-- buckets) correctly, with the trap-1 + trap-2 fixes from 084
-- and 089e, and SUM over 12 buckets gives hour aggregates if
-- ever needed.
--
-- Repairing the dead function would require fixing column refs,
-- re-deciding the anchor partitioning (shift_crew would bring
-- back the 081 staleness bug — see
-- project_counter_reset_handling.md), adding the MIN-based reset
-- branch, and backfilling. ~100 lines of SQL on code nothing is
-- exercising. Cleaner to delete it and rebuild from
-- bucket_analytics_5m the day a consumer actually needs it.
--
-- This drop unwinds 041, 041b, 047, 085 in reverse:
--   1. unschedule the two crons
--   2. drop the two aggregator functions
--   3. drop hourly_analytics (cascade removes the 073 check
--      constraints automatically)
--   4. drop cell_aggregation_log (only the aggregator used it
--      for idempotency)
-- phantom_standstill_check + phantom_standstill_hourly_pattern
-- from 085 read bucket_analytics_5m, NOT hourly_analytics, so
-- they survive untouched.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aggregate-hourly-analytics') THEN
    PERFORM cron.unschedule('aggregate-hourly-analytics');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-hourly-analytics') THEN
    PERFORM cron.unschedule('cleanup-hourly-analytics');
  END IF;
END $$;

DROP FUNCTION IF EXISTS aggregate_all_cells_for_hour(timestamptz);
DROP FUNCTION IF EXISTS aggregate_cell_hour(uuid, timestamptz);

DROP TABLE IF EXISTS hourly_analytics;
DROP TABLE IF EXISTS cell_aggregation_log;
