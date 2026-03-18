-- 021_machine_active_error_codes.sql
-- Add JSONB column to persist active PLC error codes per machine.
-- The bridge stores the current list of active error codes here on every
-- cloud/Error message and clears it when the machine reports Running status.
ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS active_error_codes JSONB DEFAULT '[]';
