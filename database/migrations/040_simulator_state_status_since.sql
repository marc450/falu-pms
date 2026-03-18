-- Migration 040: add error_start_time / idle_start_time to simulator_state
--
-- The simulator now publishes ErrorSince / IdleSince timestamps in every
-- cloud/Shift MQTT message so the bridge can always correct statusSince even
-- after missing a status transition (e.g. during a bridge reconnect).
-- These columns allow those timestamps to survive a simulator restart.

ALTER TABLE simulator_state
  ADD COLUMN IF NOT EXISTS error_start_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idle_start_time  TIMESTAMPTZ;
