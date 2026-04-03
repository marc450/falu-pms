-- 059: Replace PLC shift with shift_crew across all tables
-- The PLC shift number (1/2/3) cycles and has no fixed meaning for analytics.
-- What matters is which crew was working. The bridge resolves the crew from
-- the shift config + monthly schedule and stores it directly.
--
-- Run this COMPLETE script in one go. It:
--   1. Adds shift_crew columns
--   2. Backpopulates error_shift_summary using shift_assignments + shift config
--   3. Backpopulates error_events using their timestamps
--   4. Drops the old plc_shift columns
--   5. Updates the unique constraint
--   6. Replaces the RPC function

-- ============================================================
-- STEP 1: Add shift_crew column to all relevant tables
-- ============================================================
ALTER TABLE error_events ADD COLUMN IF NOT EXISTS shift_crew VARCHAR(50);
ALTER TABLE error_shift_summary ADD COLUMN IF NOT EXISTS shift_crew VARCHAR(50);
ALTER TABLE shift_readings ADD COLUMN IF NOT EXISTS shift_crew VARCHAR(50);
ALTER TABLE saved_shift_logs ADD COLUMN IF NOT EXISTS shift_crew VARCHAR(50);

-- ============================================================
-- STEP 2: Backpopulate error_shift_summary with crew names
-- Uses shift config from app_settings + shift_assignments schedule.
-- For each (shift_date, plc_shift), determines which time slot the PLC shift
-- falls into based on shift duration + start hour, then looks up the crew.
-- ============================================================
DO $$
DECLARE
  v_first_start INT;
  v_duration INT;
  v_slot_count INT;
  r RECORD;
  v_slot_idx INT;
  v_crew TEXT;
  v_teams JSONB;
BEGIN
  -- Read shift config
  SELECT
    COALESCE((value->>'firstShiftStartHour')::INT, 7),
    COALESCE((value->>'shiftDurationHours')::INT, 12)
  INTO v_first_start, v_duration
  FROM app_settings
  WHERE key = 'shift_config';

  v_slot_count := 24 / v_duration;

  -- Backpopulate error_shift_summary
  FOR r IN
    SELECT DISTINCT shift_date, plc_shift
    FROM error_shift_summary
    WHERE shift_crew IS NULL AND plc_shift IS NOT NULL
  LOOP
    -- PLC shifts cycle 1/2/3, each v_duration hours starting at v_first_start
    -- Determine approximate hour for this PLC shift occurrence
    -- Since PLC shifts cycle, we use the midpoint of each shift duration block
    -- For a cycling sequence, shift N on a given date maps to slot (N-1) mod slot_count
    v_slot_idx := (r.plc_shift - 1) % v_slot_count;

    -- Look up crew from shift_assignments
    SELECT slot_teams INTO v_teams
    FROM shift_assignments
    WHERE shift_date = r.shift_date;

    IF v_teams IS NOT NULL AND jsonb_array_length(v_teams) > v_slot_idx THEN
      v_crew := v_teams->>v_slot_idx;
    ELSE
      v_crew := 'Unassigned';
    END IF;

    UPDATE error_shift_summary
    SET shift_crew = v_crew
    WHERE shift_date = r.shift_date AND plc_shift = r.plc_shift AND shift_crew IS NULL;
  END LOOP;

  -- Backpopulate error_events using started_at timestamp
  FOR r IN
    SELECT id, started_at
    FROM error_events
    WHERE shift_crew IS NULL AND started_at IS NOT NULL
  LOOP
    DECLARE
      v_hour NUMERIC;
      v_hours_since NUMERIC;
      v_work_date DATE;
    BEGIN
      v_hour := EXTRACT(HOUR FROM r.started_at) + EXTRACT(MINUTE FROM r.started_at) / 60.0;
      v_hours_since := MOD(v_hour - v_first_start + 24, 24);
      v_slot_idx := FLOOR(v_hours_since / v_duration)::INT;

      -- Work date: if before first shift start, use previous day
      IF v_hour < v_first_start THEN
        v_work_date := (r.started_at AT TIME ZONE 'UTC')::DATE - 1;
      ELSE
        v_work_date := (r.started_at AT TIME ZONE 'UTC')::DATE;
      END IF;

      SELECT slot_teams INTO v_teams
      FROM shift_assignments
      WHERE shift_date = v_work_date;

      IF v_teams IS NOT NULL AND jsonb_array_length(v_teams) > v_slot_idx THEN
        v_crew := v_teams->>v_slot_idx;
      ELSE
        v_crew := 'Unassigned';
      END IF;

      UPDATE error_events SET shift_crew = v_crew WHERE id = r.id;
    END;
  END LOOP;

  -- Set any remaining NULL shift_crew to 'Unassigned'
  UPDATE error_shift_summary SET shift_crew = 'Unassigned' WHERE shift_crew IS NULL;
  UPDATE error_events SET shift_crew = 'Unassigned' WHERE shift_crew IS NULL;
END $$;

-- ============================================================
-- STEP 3: Merge rows that now share the same (machine_id, shift_date, shift_crew, error_code)
-- After mapping PLC shifts to crews, multiple PLC shifts may map to the same crew.
-- We need to aggregate them before adding the unique constraint.
-- ============================================================
WITH merged AS (
  SELECT
    machine_id, machine_code, shift_date, shift_crew, error_code,
    SUM(occurrence_count)::INT AS occurrence_count,
    SUM(total_duration_secs)::INT AS total_duration_secs,
    MIN(id) AS keep_id
  FROM error_shift_summary
  GROUP BY machine_id, machine_code, shift_date, shift_crew, error_code
  HAVING COUNT(*) > 1
)
DELETE FROM error_shift_summary e
USING merged m
WHERE e.machine_id = m.machine_id
  AND e.shift_date = m.shift_date
  AND e.shift_crew = m.shift_crew
  AND e.error_code = m.error_code
  AND e.id != m.keep_id;

-- Update the kept rows with aggregated values
WITH merged AS (
  SELECT
    machine_id, shift_date, shift_crew, error_code,
    SUM(occurrence_count)::INT AS occurrence_count,
    SUM(total_duration_secs)::INT AS total_duration_secs,
    MIN(id) AS keep_id
  FROM error_shift_summary
  GROUP BY machine_id, machine_code, shift_date, shift_crew, error_code
)
UPDATE error_shift_summary e
SET occurrence_count = m.occurrence_count,
    total_duration_secs = m.total_duration_secs
FROM merged m
WHERE e.id = m.keep_id;

-- ============================================================
-- STEP 4: Drop PLC shift columns from error tables
-- ============================================================
ALTER TABLE error_events DROP COLUMN IF EXISTS plc_shift;
ALTER TABLE error_shift_summary DROP COLUMN IF EXISTS plc_shift;

-- ============================================================
-- STEP 5: Update unique constraint
-- ============================================================
ALTER TABLE error_shift_summary DROP CONSTRAINT IF EXISTS error_shift_summary_machine_id_shift_date_plc_shift_error__key;
ALTER TABLE error_shift_summary DROP CONSTRAINT IF EXISTS error_shift_summary_unique;
ALTER TABLE error_shift_summary ADD CONSTRAINT error_shift_summary_unique
  UNIQUE (machine_id, shift_date, shift_crew, error_code);

-- ============================================================
-- STEP 6: Updated RPC function (shift_crew instead of plc_shift)
-- ============================================================
CREATE OR REPLACE FUNCTION get_error_shift_summary(start_date DATE, end_date DATE)
RETURNS TABLE (
  machine_id       UUID,
  machine_code     VARCHAR(50),
  shift_date       DATE,
  shift_crew       VARCHAR(50),
  error_code       VARCHAR(10),
  occurrence_count INTEGER,
  total_duration_secs INTEGER
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.machine_id, s.machine_code, s.shift_date, s.shift_crew,
    s.error_code, s.occurrence_count, s.total_duration_secs
  FROM error_shift_summary s
  WHERE s.shift_date >= start_date AND s.shift_date <= end_date

  UNION ALL

  SELECT
    e.machine_id,
    e.machine_code,
    e.started_at::DATE AS shift_date,
    COALESCE(e.shift_crew, 'Unassigned')::VARCHAR(50) AS shift_crew,
    e.error_code,
    COUNT(*)::INTEGER AS occurrence_count,
    COALESCE(SUM(e.duration_secs), 0)::INTEGER AS total_duration_secs
  FROM error_events e
  WHERE e.started_at::DATE >= start_date
    AND e.started_at::DATE <= end_date
    AND NOT EXISTS (
      SELECT 1 FROM error_shift_summary s2
      WHERE s2.machine_id = e.machine_id
        AND s2.shift_date = e.started_at::DATE
        AND s2.error_code = e.error_code
    )
  GROUP BY e.machine_id, e.machine_code, e.started_at::DATE, e.shift_crew, e.error_code;
END;
$$;
