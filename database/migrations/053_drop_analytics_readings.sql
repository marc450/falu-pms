-- Migration 053: Drop analytics_readings and update get_machine_shift_summary
--
-- 1. Update get_machine_shift_summary to use saved_shift_logs (same approach as
--    get_fleet_trend migration 039). The KPI formulas are unchanged.
-- 2. Unschedule the downsample-analytics-hourly pg_cron job
-- 3. Drop the downsample_to_analytics() function
-- 4. Drop the analytics_readings table
-- ============================================================================

-- ── 1. Replace get_machine_shift_summary ────────────────────────────────────

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
LANGUAGE sql
STABLE
AS $$
WITH

-- ── PATH A: shift_readings (last 48h, cumulative counters) ───────────────────
sr_sessions AS (
  SELECT
    TO_CHAR(DATE_TRUNC('day', sr.recorded_at - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
    CASE WHEN EXTRACT(hour FROM sr.recorded_at) >= 7
              AND EXTRACT(hour FROM sr.recorded_at) < 19
         THEN 'A' ELSE 'B' END                                                    AS shift_label,
    sr.machine_id,
    m.machine_code,
    sr.shift_number,
    ROUND(MAX(sr.production_time)::numeric / 60.0, 3)                AS run_hours,
    MAX(sr.produced_swabs)                                            AS swabs_produced,
    MAX(sr.produced_boxes)                                            AS boxes_produced,
    ROUND(AVG(sr.efficiency)   FILTER (WHERE sr.efficiency   > 0)::numeric, 2) AS avg_efficiency,
    ROUND(AVG(sr.reject_rate)::numeric, 2)                           AS avg_scrap
  FROM shift_readings sr
  JOIN machines m ON m.id = sr.machine_id
  WHERE sr.recorded_at >= (p_range_start - INTERVAL '7 hours')
    AND sr.recorded_at <= p_range_end
  GROUP BY 1, 2, sr.machine_id, m.machine_code, sr.shift_number
),

sr_combined AS (
  SELECT
    work_day, shift_label, machine_id, machine_code,
    ROUND(SUM(run_hours), 2)         AS run_hours,
    SUM(swabs_produced)              AS swabs_produced,
    SUM(boxes_produced)              AS boxes_produced,
    ROUND(AVG(avg_efficiency), 1)    AS avg_efficiency,
    ROUND(AVG(avg_scrap), 2)         AS avg_scrap
  FROM sr_sessions
  GROUP BY work_day, shift_label, machine_id, machine_code
),

-- ── PATH B: saved_shift_logs (historical, clean PLC per-shift totals) ────────
ssl_combined AS (
  SELECT
    TO_CHAR(DATE_TRUNC('day', sl.saved_at - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
    CASE WHEN EXTRACT(hour FROM sl.saved_at) >= 7
              AND EXTRACT(hour FROM sl.saved_at) < 19
         THEN 'A' ELSE 'B' END                                                  AS shift_label,
    sl.machine_id,
    sl.machine_code,
    ROUND(SUM(sl.production_time)::numeric / 60.0, 2)               AS run_hours,
    SUM(sl.produced_swabs)::bigint                                   AS swabs_produced,
    SUM(sl.produced_boxes)::bigint                                   AS boxes_produced,
    ROUND(AVG(sl.efficiency) FILTER (WHERE sl.efficiency > 0)::numeric, 1) AS avg_efficiency,
    ROUND(AVG(sl.reject_rate)::numeric, 2)                           AS avg_scrap
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
  work_day,
  shift_label,
  machine_id,
  machine_code,
  run_hours,
  swabs_produced,
  boxes_produced,
  CASE WHEN run_hours > 0
    THEN ROUND((swabs_produced::numeric / 7200.0) / run_hours * 12.0, 1)
    ELSE NULL
  END AS bu_normalized,
  avg_efficiency,
  avg_scrap
FROM all_sessions
WHERE work_day >= TO_CHAR(DATE_TRUNC('day', p_range_start - INTERVAL '7 hours'), 'YYYY-MM-DD')
  AND work_day <= TO_CHAR(DATE_TRUNC('day', p_range_end), 'YYYY-MM-DD')
ORDER BY work_day DESC, shift_label, machine_code
$$;

GRANT EXECUTE ON FUNCTION get_machine_shift_summary(timestamptz, timestamptz)
  TO anon, authenticated;

-- ── 2. Unschedule the downsample pg_cron job ────────────────────────────────
SELECT cron.unschedule('downsample-analytics-hourly');

-- ── 3. Drop the downsample function ─────────────────────────────────────────
DROP FUNCTION IF EXISTS downsample_to_analytics();

-- ── 4. Drop the analytics_readings table ────────────────────────────────────
DROP TABLE IF EXISTS analytics_readings;
