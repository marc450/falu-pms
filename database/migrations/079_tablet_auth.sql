-- ============================================================
-- Migration 079: Tablet kiosk auth (per-machine token + PIN)
-- ============================================================
-- Minimal columns to authenticate a machine-mounted tablet that
-- shows the operator guidance kiosk. Each machine gets a UUID
-- token (used in the URL) and a 4-digit PIN (entered once and
-- cached in localStorage on the tablet).
--
-- This is the prototype scope. No stop_reasons table, no log
-- table, no Settings UI — those land later when the kiosk goes
-- past one machine.
-- ============================================================

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS tablet_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS tablet_pin   TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_machines_tablet_token
  ON machines (tablet_token)
  WHERE tablet_token IS NOT NULL;

-- anon already has SELECT on machines (used by the dashboard); the
-- tablet uses the same anon key so no new policy is needed.

-- One-shot provisioning for the prototype machine (11562 / CB-37).
-- Returns the token to put in the URL plus the default PIN.
UPDATE machines
SET tablet_token = COALESCE(tablet_token, gen_random_uuid()),
    tablet_pin   = COALESCE(tablet_pin, '1234')
WHERE machine_code = '11562';
