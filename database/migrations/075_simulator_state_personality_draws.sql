-- Migration 075: extend simulator_state for the new "interesting data" mechanics
--
-- The simulator now draws three random values per shift per machine:
--   shift_p              — performance multiplier on speed_target (0.70 - 1.10)
--   shift_baseline_scrap — per-shift baseline scrap rate (0.005 - 0.025)
--   bad_batch            — optional JSON {startMin, endMin, adder} for a scrap-spike event
--
-- We also track when the most recent error ended, to implement the
-- cascading-error window (errors are more likely for ~15 min after a resolution).
--
-- The pre-existing speed-tier columns (speed_tier_idx, base_speed, tier_locked_until)
-- are no longer written and are dropped here to keep the schema honest.

ALTER TABLE simulator_state
  ADD COLUMN IF NOT EXISTS shift_p              NUMERIC,
  ADD COLUMN IF NOT EXISTS shift_baseline_scrap NUMERIC,
  ADD COLUMN IF NOT EXISTS bad_batch            JSONB,
  ADD COLUMN IF NOT EXISTS last_error_end_min   NUMERIC;

ALTER TABLE simulator_state
  DROP COLUMN IF EXISTS speed_tier_idx,
  DROP COLUMN IF EXISTS base_speed,
  DROP COLUMN IF EXISTS tier_locked_until;
