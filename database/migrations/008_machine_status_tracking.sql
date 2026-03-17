-- Migration 008: Add status-tracking columns to machines table
-- These columns let the MQTT bridge persist status-transition timestamps
-- and accumulated idle/error time across restarts and redeployments.

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS status_since      TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS idle_time_calc    DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_time_calc   DOUBLE PRECISION DEFAULT 0;

-- Initialise status_since for existing rows so the bridge does not
-- calculate a negative duration on first startup.
UPDATE machines
SET status_since = NOW()
WHERE status_since IS NULL;
