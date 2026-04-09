-- ============================================================
-- Migration 063: get_machine_shift_summary returns shift_crew
-- ============================================================
-- Previously the RPC derived a synthetic "shift_label" (A/B)
-- from the hour of day, then the frontend had to map it back
-- to a crew name via calendar assignments.
--
-- Now the bridge writes shift_crew directly into shift_readings
-- and saved_shift_logs, so the RPC simply passes it through.
-- The return column is renamed from shift_label to shift_crew.
-- ============================================================

DROP FUNCTION IF EXISTS get_machine_shift_summary(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION get_machine_shift_summary(
  p_range_start timestamptz,
  p_range_end   timestamptz
)
RETURNS TABLE (
  work_day       text,
  shift_crew     text,
  machine_id     uuid,
  machine_code   text,
  run_hours      numeric,
  swabs_produced bigint,
  boxes_produced bigint,
  bu_normalized  numeric,
  avg_efficiency numeric,
  avg_scrap      numeric
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  tz text;
BEGIN
  SELECT value #>> '{}' INTO tz FROM app_settings WHERE key = 'factory_timezone';
  IF tz IS NULL THEN tz := 'Europe/Zurich'; END IF;

  RETURN QUERY
  WITH

  sr_sessions AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sr.recorded_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      sr.shift_crew,
      sr.machine_id,
      m.machine_code,
      ROUND(MAX(sr.production_time)::numeric / 60.0, 3) AS run_hours,
      MAX(sr.produced_swabs) AS swabs_produced,
      MAX(sr.produced_boxes) AS boxes_produced,
      ROUND(AVG(sr.efficiency) FILTER (WHERE sr.efficiency > 0)::numeric, 2) AS avg_efficiency,
      ROUND(AVG(sr.reject_rate)::numeric, 2) AS avg_scrap
    FROM shift_readings sr
    JOIN machines m ON m.id = sr.machine_id
    WHERE sr.recorded_at >= (p_range_start - INTERVAL '7 hours')
      AND sr.recorded_at <= p_range_end
    GROUP BY 1, sr.shift_crew, sr.machine_id, m.machine_code
  ),

  sr_combined AS (
    SELECT
      s.work_day, s.shift_crew, s.machine_id, s.machine_code,
      ROUND(SUM(s.run_hours), 2) AS run_hours,
      SUM(s.swabs_produced) AS swabs_produced,
      SUM(s.boxes_produced) AS boxes_produced,
      ROUND(AVG(s.avg_efficiency), 1) AS avg_efficiency,
      ROUND(AVG(s.avg_scrap), 2) AS avg_scrap
    FROM sr_sessions s
    GROUP BY s.work_day, s.shift_crew, s.machine_id, s.machine_code
  ),

  ssl_combined AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      COALESCE(sl.shift_crew, 'Unassigned') AS shift_crew,
      sl.machine_id,
      sl.machine_code,
      ROUND(SUM(sl.production_time)::numeric / 60.0, 2) AS run_hours,
      SUM(sl.produced_swabs)::bigint AS swabs_produced,
      SUM(sl.produced_boxes)::bigint AS boxes_produced,
      ROUND(AVG(sl.efficiency) FILTER (WHERE sl.efficiency > 0)::numeric, 1) AS avg_efficiency,
      ROUND(AVG(sl.reject_rate)::numeric, 2) AS avg_scrap
    FROM saved_shift_logs sl
    WHERE sl.saved_at >= (p_range_start - INTERVAL '7 hours')
      AND sl.saved_at <= p_range_end
    GROUP BY 1, sl.shift_crew, sl.machine_id, sl.machine_code
  ),

  all_sessions AS (
    SELECT * FROM sr_combined
    UNION ALL
    SELECT a.* FROM ssl_combined a
    WHERE NOT EXISTS (
      SELECT 1 FROM sr_combined s
      WHERE s.work_day    = a.work_day
        AND s.shift_crew  = a.shift_crew
        AND s.machine_id  = a.machine_id
    )
  )

  SELECT
    a.work_day,
    a.shift_crew,
    a.machine_id,
    a.machine_code,
    a.run_hours,
    a.swabs_produced,
    a.boxes_produced,
    CASE WHEN a.run_hours > 0
      THEN ROUND((a.swabs_produced::numeric / 7200.0) / a.run_hours * 12.0, 1)
      ELSE NULL
    END AS bu_normalized,
    a.avg_efficiency,
    a.avg_scrap
  FROM all_sessions a
  WHERE a.work_day >= TO_CHAR(DATE_TRUNC('day', (p_range_start AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD')
    AND a.work_day <= TO_CHAR(DATE_TRUNC('day', (p_range_end AT TIME ZONE tz)), 'YYYY-MM-DD')
  ORDER BY a.work_day DESC, a.shift_crew, a.machine_code;
END;
$$;

GRANT EXECUTE ON FUNCTION get_machine_shift_summary(timestamptz, timestamptz)
  TO anon, authenticated;
