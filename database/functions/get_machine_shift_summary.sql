-- Current version: migration 054
-- get_machine_shift_summary
-- Returns one row per (work_day, shift_label, machine) with:
--   run_hours      = actual hours the machine was running during that shift
--   swabs_produced = total swabs produced
--   boxes_produced = total boxes produced
--   bu_normalized  = (swabs_produced/7200) / run_hours * 12  (NULL if run_hours=0)
--   avg_efficiency = average efficiency % while running
--   avg_scrap      = average reject rate %
--
-- Reads from shift_readings (last 48h, cumulative) UNION saved_shift_logs (historical).
-- Work-day boundary: 07:00 in factory timezone (from app_settings.factory_timezone).
-- Shift A = 07:00-18:59, Shift B = 19:00-06:59.

CREATE OR REPLACE FUNCTION get_machine_shift_summary(
  p_range_start timestamptz,
  p_range_end   timestamptz
)
RETURNS TABLE (
  work_day       text,
  shift_label    text,
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

  -- ── PATH A: shift_readings (last 48h, cumulative counters) ───────────────────
  sr_sessions AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sr.recorded_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      CASE WHEN EXTRACT(hour FROM sr.recorded_at AT TIME ZONE tz) >= 7
                AND EXTRACT(hour FROM sr.recorded_at AT TIME ZONE tz) < 19
           THEN 'A' ELSE 'B' END AS shift_label,
      sr.machine_id,
      m.machine_code,
      sr.shift_crew,
      ROUND(MAX(sr.production_time)::numeric / 60.0, 3) AS run_hours,
      MAX(sr.produced_swabs) AS swabs_produced,
      MAX(sr.produced_boxes) AS boxes_produced,
      ROUND(AVG(sr.efficiency) FILTER (WHERE sr.efficiency > 0)::numeric, 2) AS avg_efficiency,
      ROUND(AVG(sr.reject_rate)::numeric, 2) AS avg_scrap
    FROM shift_readings sr
    JOIN machines m ON m.id = sr.machine_id
    WHERE sr.recorded_at >= (p_range_start - INTERVAL '7 hours')
      AND sr.recorded_at <= p_range_end
    GROUP BY 1, 2, sr.machine_id, m.machine_code, sr.shift_crew
  ),

  sr_combined AS (
    SELECT
      s.work_day, s.shift_label, s.machine_id, s.machine_code,
      ROUND(SUM(s.run_hours), 2) AS run_hours,
      SUM(s.swabs_produced) AS swabs_produced,
      SUM(s.boxes_produced) AS boxes_produced,
      ROUND(AVG(s.avg_efficiency), 1) AS avg_efficiency,
      ROUND(AVG(s.avg_scrap), 2) AS avg_scrap
    FROM sr_sessions s
    GROUP BY s.work_day, s.shift_label, s.machine_id, s.machine_code
  ),

  -- ── PATH B: saved_shift_logs (historical, clean PLC per-shift totals) ────────
  ssl_combined AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      CASE WHEN EXTRACT(hour FROM sl.saved_at AT TIME ZONE tz) >= 7
                AND EXTRACT(hour FROM sl.saved_at AT TIME ZONE tz) < 19
           THEN 'A' ELSE 'B' END AS shift_label,
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
    GROUP BY 1, 2, sl.machine_id, sl.machine_code
  ),

  -- ── UNION: prefer sr_combined (live) for recent data ─────────────────────────
  all_sessions AS (
    SELECT * FROM sr_combined
    UNION ALL
    SELECT a.* FROM ssl_combined a
    WHERE NOT EXISTS (
      SELECT 1 FROM sr_combined s
      WHERE s.work_day    = a.work_day
        AND s.shift_label = a.shift_label
        AND s.machine_id  = a.machine_id
    )
  )

  SELECT
    a.work_day,
    a.shift_label,
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
  ORDER BY a.work_day DESC, a.shift_label, a.machine_code;
END;
$$;

GRANT EXECUTE ON FUNCTION get_machine_shift_summary(timestamptz, timestamptz)
  TO anon, authenticated;
