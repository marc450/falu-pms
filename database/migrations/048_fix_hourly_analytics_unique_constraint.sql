-- Migration 048: add missing unique constraint on hourly_analytics
-- The ON CONFLICT (machine_id, plc_hour, shift_number) clause in
-- aggregate_cell_hour() requires this constraint to exist.
-- Without it the cron job fails with:
--   ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification

ALTER TABLE hourly_analytics
  ADD CONSTRAINT hourly_analytics_machine_hour_shift_key
  UNIQUE (machine_id, plc_hour, shift_number);
