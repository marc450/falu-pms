-- ============================================================
-- Migration 067: Fix two latent bugs in the M066 RPCs
-- ============================================================
-- These bugs existed in migrations 060 and 063 but were not hit
-- because the functions were not re-planned. M066 dropped and
-- recreated them, which re-planned them against newer PG, and
-- the strict checks fired.
--
-- Bug 1: get_machine_shift_summary
--   RETURNS TABLE declares shift_crew and machine_code as text.
--   The underlying columns are VARCHAR(50). Explicitly cast to
--   text in the final SELECT.
--
-- Bug 2: get_fleet_trend
--   RETURNS TABLE columns become accessible as PL/pgSQL
--   variables inside the function body. `LEFT JOIN prod_agg p
--   USING (bucket)` is ambiguous between the variable and the
--   column. Fix by adding `#variable_conflict use_column` at
--   the top of the function body. Safe, behavior-identical.
--
-- No column or logic changes. Pure bug fixes.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- Fix 1: get_machine_shift_summary — cast VARCHAR to text
-- ────────────────────────────────────────────────────────────

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
      sr.shift_crew::text                                                      AS shift_crew,
      sr.machine_id,
      m.machine_code::text                                                     AS machine_code,
      ROUND(MAX(sr.production_time_seconds)::numeric / 60.0, 3)                AS run_hours,
      MAX(sr.produced_swabs)                                                   AS swabs_produced,
      MAX(sr.produced_boxes)                                                   AS boxes_produced,
      ROUND(AVG(sr.efficiency) FILTER (WHERE sr.efficiency > 0)::numeric, 2)   AS avg_efficiency,
      ROUND(AVG(sr.scrap_rate)::numeric, 2)                                    AS avg_scrap
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
      SUM(s.swabs_produced)      AS swabs_produced,
      SUM(s.boxes_produced)      AS boxes_produced,
      ROUND(AVG(s.avg_efficiency), 1) AS avg_efficiency,
      ROUND(AVG(s.avg_scrap), 2)      AS avg_scrap
    FROM sr_sessions s
    GROUP BY s.work_day, s.shift_crew, s.machine_id, s.machine_code
  ),

  ssl_combined AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      COALESCE(sl.shift_crew, 'Unassigned')::text                         AS shift_crew,
      sl.machine_id,
      sl.machine_code::text                                               AS machine_code,
      ROUND(SUM(sl.production_time_seconds)::numeric / 60.0, 2)           AS run_hours,
      SUM(sl.produced_swabs)::bigint                                      AS swabs_produced,
      SUM(sl.produced_boxes)::bigint                                      AS boxes_produced,
      ROUND(AVG(sl.efficiency) FILTER (WHERE sl.efficiency > 0)::numeric, 1) AS avg_efficiency,
      ROUND(AVG(sl.scrap_rate)::numeric, 2)                               AS avg_scrap
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
    a.shift_crew::text                                      AS shift_crew,
    a.machine_id,
    a.machine_code::text                                    AS machine_code,
    a.run_hours,
    a.swabs_produced,
    a.boxes_produced,
    CASE WHEN a.run_hours > 0
      THEN ROUND((a.swabs_produced::numeric / 7200.0) / a.run_hours * 12.0, 1)
      ELSE NULL
    END                                                     AS bu_normalized,
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


-- ────────────────────────────────────────────────────────────
-- Fix 2: get_fleet_trend — resolve variable/column ambiguity
-- ────────────────────────────────────────────────────────────
-- #variable_conflict use_column tells PL/pgSQL that any name
-- that could refer to either an OUT parameter / RETURNS TABLE
-- column or a SQL column in the query body should resolve to
-- the SQL column. This fixes the USING (bucket) ambiguity
-- without changing any query logic.

CREATE OR REPLACE FUNCTION get_fleet_trend(
  range_start        timestamptz,
  range_end          timestamptz,
  bucket_granularity text
)
RETURNS TABLE (
  bucket        text,
  avg_uptime    numeric,
  avg_scrap     numeric,
  total_boxes   bigint,
  total_swabs   bigint,
  machine_count bigint,
  reading_count bigint,
  shift_count   bigint
)
LANGUAGE plpgsql
STABLE
AS $$
#variable_conflict use_column
DECLARE
  tz text;
BEGIN
  SELECT value #>> '{}' INTO tz FROM app_settings WHERE key = 'factory_timezone';
  IF tz IS NULL THEN tz := 'Europe/Zurich'; END IF;

  RETURN QUERY
  WITH

  config AS (
    SELECT
      COALESCE(MAX((value->>'firstShiftStartHour')::int),  7) AS first_hour,
      COALESCE(MAX((value->>'shiftDurationHours')::int),  12) AS dur_hours
    FROM app_settings
    WHERE key = 'shift_config'
  ),

  raw AS (
    SELECT
      recorded_at,
      machine_id,
      shift_crew,
      efficiency::double precision  AS efficiency,
      scrap_rate::double precision  AS scrap_rate,
      produced_boxes,
      produced_swabs,
      (recorded_at >= range_start)  AS in_range
    FROM shift_readings
    WHERE recorded_at >= (range_start - interval '7 hours')
      AND recorded_at <= range_end
  ),

  anchors AS (
    SELECT DISTINCT ON (machine_id, shift_crew)
      recorded_at, machine_id, shift_crew,
      0::double precision AS efficiency,
      0::double precision AS scrap_rate,
      produced_boxes, produced_swabs,
      FALSE AS in_range
    FROM shift_readings
    WHERE recorded_at < (range_start - interval '7 hours')
    ORDER BY machine_id, shift_crew, recorded_at DESC
  ),

  combined AS (
    SELECT * FROM raw
    UNION ALL
    SELECT * FROM anchors
  ),

  deltas AS (
    SELECT
      recorded_at, machine_id, shift_crew, efficiency, scrap_rate, in_range,
      GREATEST(0,
        CASE
          WHEN produced_swabs >= LAG(produced_swabs, 1, 0::bigint) OVER w
          THEN produced_swabs - LAG(produced_swabs, 1, 0::bigint) OVER w
          ELSE produced_swabs
        END
      ) AS delta_swabs,
      GREATEST(0,
        CASE
          WHEN produced_boxes >= LAG(produced_boxes, 1, 0::bigint) OVER w
          THEN produced_boxes - LAG(produced_boxes, 1, 0::bigint) OVER w
          ELSE produced_boxes
        END
      ) AS delta_boxes
    FROM combined
    WINDOW w AS (
      PARTITION BY machine_id, shift_crew
      ORDER BY recorded_at
      ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
    )
  ),

  sr_daily_max AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (recorded_at AT TIME ZONE tz) - interval '7 hours'), 'YYYY-MM-DD') AS bucket,
      machine_id, shift_crew,
      MAX(produced_boxes)::bigint AS tot_boxes,
      MAX(produced_swabs)::bigint AS tot_swabs
    FROM raw
    WHERE bucket_granularity = 'day'
    GROUP BY 1, machine_id, shift_crew
  ),
  sr_daily AS (
    SELECT bucket, SUM(tot_boxes) AS total_boxes, SUM(tot_swabs) AS total_swabs
    FROM sr_daily_max GROUP BY bucket
  ),

  sr_hourly AS (
    SELECT
      TO_CHAR(DATE_TRUNC('hour', recorded_at AT TIME ZONE tz), 'YYYY-MM-DD"T"HH24') AS bucket,
      SUM(delta_boxes) AS total_boxes,
      SUM(delta_swabs) AS total_swabs
    FROM deltas
    WHERE bucket_granularity = 'hour' AND in_range = TRUE
    GROUP BY 1
  ),

  ssl_daily AS (
    SELECT
      TO_CHAR(
        DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - (c.first_hour || ' hours')::interval),
        'YYYY-MM-DD'
      ) AS bucket,
      SUM(sl.produced_boxes)::bigint  AS total_boxes,
      SUM(sl.produced_swabs)::bigint  AS total_swabs
    FROM saved_shift_logs sl
    CROSS JOIN config c
    WHERE bucket_granularity = 'day'
      AND sl.saved_at >= (range_start - (c.first_hour || ' hours')::interval)
      AND sl.saved_at <= range_end
    GROUP BY 1
  ),

  prod AS (
    SELECT bucket, total_boxes, total_swabs FROM sr_daily
    UNION ALL
    SELECT bucket, total_boxes, total_swabs FROM sr_hourly
    UNION ALL
    SELECT d.bucket, d.total_boxes, d.total_swabs
    FROM ssl_daily d
    WHERE NOT EXISTS (SELECT 1 FROM sr_daily s WHERE s.bucket = d.bucket)
  ),

  prod_agg AS (
    SELECT bucket,
      SUM(total_boxes)::bigint AS total_boxes,
      SUM(total_swabs)::bigint AS total_swabs
    FROM prod
    GROUP BY bucket
  ),

  sr_agg AS (
    SELECT
      CASE bucket_granularity
        WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', recorded_at AT TIME ZONE tz), 'YYYY-MM-DD"T"HH24')
        ELSE             TO_CHAR(DATE_TRUNC('day',  (recorded_at AT TIME ZONE tz) - interval '7 hours'), 'YYYY-MM-DD')
      END                                                AS bucket,
      ROUND(AVG(NULLIF(efficiency, 0))::numeric, 1)      AS avg_uptime,
      ROUND(AVG(scrap_rate)::numeric,            1)      AS avg_scrap,
      COUNT(*)                                           AS reading_count,
      COUNT(DISTINCT machine_id)                         AS machine_count,
      COUNT(DISTINCT shift_crew)                         AS shift_count
    FROM raw
    WHERE bucket_granularity = 'hour' AND in_range = TRUE
       OR bucket_granularity = 'day'
    GROUP BY 1
  ),

  ssl_agg AS (
    SELECT
      TO_CHAR(
        DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - (c.first_hour || ' hours')::interval),
        'YYYY-MM-DD'
      ) AS bucket,
      ROUND(AVG(NULLIF(sl.efficiency, 0))::numeric, 1)   AS avg_uptime,
      ROUND(AVG(sl.scrap_rate)::numeric, 1)              AS avg_scrap,
      COUNT(*)::bigint                                   AS reading_count,
      COUNT(DISTINCT sl.machine_id)::bigint              AS machine_count,
      COUNT(DISTINCT sl.shift_crew)::bigint              AS shift_count
    FROM saved_shift_logs sl
    CROSS JOIN config c
    WHERE bucket_granularity = 'day'
      AND sl.saved_at >= (range_start - (c.first_hour || ' hours')::interval)
      AND sl.saved_at <= range_end
    GROUP BY 1
  ),

  agg AS (
    SELECT * FROM sr_agg
    UNION ALL
    SELECT a.* FROM ssl_agg a
    WHERE NOT EXISTS (SELECT 1 FROM sr_agg s WHERE s.bucket = a.bucket)
  )

  SELECT
    a.bucket,
    COALESCE(a.avg_uptime, 0)           AS avg_uptime,
    COALESCE(a.avg_scrap,  0)           AS avg_scrap,
    COALESCE(p.total_boxes, 0)::bigint  AS total_boxes,
    COALESCE(p.total_swabs, 0)::bigint  AS total_swabs,
    a.machine_count,
    a.reading_count,
    a.shift_count
  FROM agg a
  LEFT JOIN prod_agg p ON p.bucket = a.bucket
  ORDER BY a.bucket;
END;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;

COMMIT;
