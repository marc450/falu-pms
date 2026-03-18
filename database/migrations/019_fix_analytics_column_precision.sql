-- Migration 019: Fix analytics_readings column precision
-- ============================================================================
-- The avg_speed, avg_efficiency, avg_scrap_rate columns were created as
-- NUMERIC(4,2) which caps values at 99.99.  Machine speeds are 2000-2850
-- pcs/min so the downsample INSERT immediately overflows with error 22003.
--
-- Also widen minutes_* columns from NUMERIC(4,2) to unconstrained NUMERIC
-- so buckets with longer gaps (e.g. overnight offline) never overflow either.
-- ============================================================================

ALTER TABLE analytics_readings
  ALTER COLUMN avg_speed      TYPE NUMERIC,
  ALTER COLUMN avg_efficiency TYPE NUMERIC,
  ALTER COLUMN avg_scrap_rate TYPE NUMERIC,
  ALTER COLUMN minutes_running  TYPE NUMERIC,
  ALTER COLUMN minutes_idle     TYPE NUMERIC,
  ALTER COLUMN minutes_error    TYPE NUMERIC,
  ALTER COLUMN minutes_offline  TYPE NUMERIC;
