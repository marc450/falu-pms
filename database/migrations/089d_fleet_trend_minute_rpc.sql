-- ============================================================
-- Migration 089d: extend get_fleet_trend_minute return shape
-- ============================================================
-- Part 4 of 4 — adds three new columns (total_production_seconds,
-- total_idle_seconds, total_error_seconds) at the end of the
-- RPC's return shape. The original eight columns are unchanged
-- so the existing chart line keeps working without code churn;
-- the Machine Monitor Avg Uptime tile reads the three new ones
-- to compute corrected uptime over the user's selected window.
--
-- Requires 089a + 089b + 089c (the columns must exist and be
-- populated for the SUMs to return non-zero values).
--
-- The frontend code that consumes the new columns shipped with
-- the same commit as this migration set.
-- ============================================================

DROP FUNCTION IF EXISTS get_fleet_trend_minute(timestamptz, timestamptz, uuid[]);

CREATE OR REPLACE FUNCTION get_fleet_trend_minute(
  range_start  timestamptz,
  range_end    timestamptz,
  machine_ids  uuid[] DEFAULT NULL
)
RETURNS TABLE (
  bucket                   text,
  avg_uptime               numeric,
  avg_scrap                numeric,
  total_boxes              bigint,
  total_swabs              bigint,
  machine_count            bigint,
  reading_count            bigint,
  shift_count              bigint,
  total_production_seconds bigint,
  total_idle_seconds       bigint,
  total_error_seconds      bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    to_char(bucket_ts, 'YYYY-MM-DD"T"HH24:MI')             AS bucket,
    CASE
      WHEN COUNT(DISTINCT machine_id) > 0 THEN
        round(
          (SUM(production_time_seconds)::numeric
            / (COUNT(DISTINCT machine_id) * 5 * 60)) * 100,
          1
        )
      ELSE 0
    END                                                    AS avg_uptime,
    CASE
      WHEN SUM(swabs_produced) > 0 THEN
        round((SUM(discarded_swabs)::numeric / SUM(swabs_produced)) * 100, 1)
      ELSE 0
    END                                                    AS avg_scrap,
    SUM(boxes_produced)::bigint                            AS total_boxes,
    SUM(swabs_produced)::bigint                            AS total_swabs,
    COUNT(DISTINCT machine_id)                             AS machine_count,
    SUM(reading_count)::bigint                             AS reading_count,
    COUNT(DISTINCT shift_crew)                             AS shift_count,
    SUM(production_time_seconds)::bigint                   AS total_production_seconds,
    SUM(idle_time_seconds)::bigint                         AS total_idle_seconds,
    SUM(error_time_seconds)::bigint                        AS total_error_seconds
  FROM bucket_analytics_5m
  WHERE bucket_ts >= range_start
    AND bucket_ts <  range_end
    AND (machine_ids IS NULL OR machine_id = ANY(machine_ids))
  GROUP BY bucket_ts
  ORDER BY bucket_ts;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend_minute(timestamptz, timestamptz, uuid[])
  TO anon, authenticated;
