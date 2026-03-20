-- ============================================================
-- Migration 044: fleet trend RPC from daily_machine_summary
-- ============================================================
-- Returns one row per calendar day with fleet-level aggregates.
-- Aggregation happens server-side so the result set is small
-- (max ~365 rows/year) and never hits PostgREST row limits.
-- Excludes the current day (incomplete data).
-- ============================================================

CREATE OR REPLACE FUNCTION get_fleet_trend_daily(
  p_range_start date,
  p_range_end   date
)
RETURNS TABLE (
  summary_date   date,
  total_swabs    bigint,
  total_boxes    bigint,
  machine_count  bigint,
  shift_count    bigint,
  reading_count  bigint,
  avg_uptime     double precision,
  avg_scrap      double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    d.summary_date,
    SUM(d.swabs_produced)::bigint                        AS total_swabs,
    SUM(d.boxes_produced)::bigint                        AS total_boxes,
    COUNT(DISTINCT d.machine_id)::bigint                 AS machine_count,
    COUNT(DISTINCT d.shift_label)::bigint                AS shift_count,
    SUM(d.reading_count)::bigint                         AS reading_count,
    ROUND(
      (SUM(d.avg_efficiency * d.reading_count)
        FILTER (WHERE d.avg_efficiency > 0)
       / NULLIF(SUM(d.reading_count)
        FILTER (WHERE d.avg_efficiency > 0), 0)
      )::numeric, 1
    )::double precision                                  AS avg_uptime,
    ROUND(
      (SUM(d.avg_scrap_rate * d.reading_count)
       / NULLIF(SUM(d.reading_count), 0)
      )::numeric, 1
    )::double precision                                  AS avg_scrap
  FROM daily_machine_summary d
  WHERE d.summary_date >= p_range_start
    AND d.summary_date <  p_range_end       -- excludes today when called with CURRENT_DATE
  GROUP BY d.summary_date
  ORDER BY d.summary_date;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend_daily(date, date)
  TO anon, authenticated;
