-- Migration 004: soft-delete support for machines
-- Instead of hard-deleting a machine (which would cascade-delete shift_readings
-- and saved_shift_logs), we set hidden = true.  The machine re-appears
-- automatically when the MQTT bridge receives data from it again.

ALTER TABLE machines ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
