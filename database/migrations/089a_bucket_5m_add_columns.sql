-- ============================================================
-- Migration 089a: add idle + error columns to bucket_analytics_5m
-- ============================================================
-- Part 1 of 4 — schema only. Safe to run on its own; the table
-- keeps working with the existing aggregator (the new columns
-- just stay at default 0 until 089b lands). Run 089b/c/d after
-- this for the aggregator update, backfill, and RPC change.
-- ============================================================

ALTER TABLE bucket_analytics_5m
  ADD COLUMN IF NOT EXISTS idle_time_seconds  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_time_seconds bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS _end_idle_time_s   bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS _end_error_time_s  bigint NOT NULL DEFAULT 0;
