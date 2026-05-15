-- Migration 076: machine_type
-- Adds an optional machine_type column used to group peers for benchmarking
-- in the Machine Monitor's Production Trend section.
--
-- Allowed values: 'CB1', 'CT-3000', or NULL (unset).
-- Index helps the "find peers with the same type" lookup stay constant-time
-- even as more machines are added.

ALTER TABLE machines
  ADD COLUMN IF NOT EXISTS machine_type TEXT;

ALTER TABLE machines
  DROP CONSTRAINT IF EXISTS machines_machine_type_check;

ALTER TABLE machines
  ADD CONSTRAINT machines_machine_type_check
  CHECK (machine_type IS NULL OR machine_type IN ('CB1', 'CT-3000'));

CREATE INDEX IF NOT EXISTS machines_machine_type_idx
  ON machines (machine_type)
  WHERE machine_type IS NOT NULL;
