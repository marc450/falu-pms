-- Add plc_shift column to error_events so the bridge can store
-- the actual PLC shift number reported by the machine.
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS plc_shift INTEGER;
