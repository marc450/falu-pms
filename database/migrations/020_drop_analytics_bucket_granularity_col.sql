-- Migration 020: Drop analytics_readings.bucket_granularity column
-- ============================================================================
-- get_fleet_trend uses a function parameter also named bucket_granularity.
-- analytics_readings has a column of the same name (all NULL, never written
-- by downsample_to_analytics).  In PostgreSQL SQL-language functions, column
-- names take precedence over parameter names when both are in scope, so every
-- CTE that queries analytics_readings evaluates:
--
--   WHERE NULL = 'day'   → false
--   WHERE NULL = 'hour'  → false
--
-- causing all analytics_readings rows to be silently excluded regardless of
-- the requested date range.  The column serves no purpose — drop it so the
-- parameter name is resolved correctly and historical data appears in charts.
-- ============================================================================

ALTER TABLE analytics_readings DROP COLUMN IF EXISTS bucket_granularity;
