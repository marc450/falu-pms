-- Migration 048: add missing unique constraint on hourly_analytics
-- The aggregate_cell_hour() function uses ON CONFLICT (machine_id, plc_hour, shift_number)
-- but this constraint was never explicitly created, causing the cron job to fail
-- with "there is no unique or exclusion constraint matching the ON CONFLICT specification".

ALTER TABLE hourly_analytics
  ADD CONSTRAINT hourly_analytics_machine_hour_shift_key
  UNIQUE (machine_id, plc_hour, shift_number);
