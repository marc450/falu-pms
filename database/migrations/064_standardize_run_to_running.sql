-- ============================================================
-- 064_standardize_run_to_running.sql
-- ============================================================
-- Purpose
--   Finish the standardisation started in commit b9494a7. The initial schema
--   (migration 001) permitted only 'run' in the machines.status CHECK
--   constraint, so any bridge/simulator writing the newer 'running' value
--   would silently fail the constraint. The frontend utils.ts only renders
--   'running' (anything else falls through to 'Offline'), which is why rows
--   with status='run' appear as 'Offline' in the dashboard.
--
-- Actions
--   1. Drop the existing CHECK constraint on machines.status.
--   2. Migrate every status='run' row to status='running'.
--   3. Drop the +11665 ghost row (auto-registered from a malformed MQTT
--      topic before getMachineId validated the code).
--   4. Re-add the CHECK constraint, now allowing 'running' instead of 'run'.
--
-- Safe to run multiple times: uses IF EXISTS / NOT EXISTS guards where
-- possible. The update step is idempotent.
-- ============================================================

BEGIN;

-- 1. Drop the existing CHECK constraint (auto-named by Postgres)
ALTER TABLE machines DROP CONSTRAINT IF EXISTS machines_status_check;

-- 2. Normalise any remaining 'run' values to 'running'
UPDATE machines
   SET status = 'running'
 WHERE status = 'run';

-- 3. Delete the ghost row created by the MQTT wildcard '+'
--    Three FK tables do not cascade (hourly_analytics, daily_machine_summary,
--    downtime_alerts), so we clear their rows first. shift_readings,
--    error_events and error_shift_summary have ON DELETE CASCADE and will
--    clear automatically.
DELETE FROM hourly_analytics       WHERE machine_id IN (SELECT id FROM machines WHERE machine_code = '+11665');
DELETE FROM daily_machine_summary  WHERE machine_id IN (SELECT id FROM machines WHERE machine_code = '+11665');
DELETE FROM downtime_alerts        WHERE machine_id IN (SELECT id FROM machines WHERE machine_code = '+11665');
DELETE FROM machines WHERE machine_code = '+11665';

-- 4. Re-add the CHECK constraint with the canonical status set
ALTER TABLE machines
  ADD CONSTRAINT machines_status_check
  CHECK (status IN ('running', 'idle', 'error', 'offline'));

COMMIT;
