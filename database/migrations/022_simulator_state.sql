-- Migration 022: simulator_state persistence table
-- Allows the MQTT bridge simulator to save and restore full shift state
-- across Railway redeploys, preventing BU output from reverting to zero.
-- The bridge simulator already contains saveState/loadState logic that
-- upserts to this table every ~60 seconds; this migration creates the table.

CREATE TABLE IF NOT EXISTS simulator_state (
  machine_name        VARCHAR(50) PRIMARY KEY,
  active_shift        INTEGER,
  shift_started_at    BIGINT,
  status              VARCHAR(20),
  error_end_min       NUMERIC,
  speed_tier_idx      INTEGER,
  base_speed          INTEGER,
  tier_locked_until   NUMERIC,
  cleaning_start_min  NUMERIC,
  shift_1_data        JSONB,
  shift_2_data        JSONB,
  shift_3_data        JSONB,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE simulator_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_write_simulator_state"
  ON simulator_state FOR ALL TO service_role USING (true);

CREATE POLICY "auth_read_simulator_state"
  ON simulator_state FOR SELECT TO authenticated USING (true);
