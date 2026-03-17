-- Migration 016: Fix work-day bucketing to match 07:00 shift start
-- ============================================================================
--
-- Problem in migrations 012–015:
--   All work-day bucketing used `- interval '6 hours'`, calibrated for a
--   factory whose shifts start at 06:00.
--   USC runs 12-hour shifts starting at 07:00 / 19:00.
--   With the old offset, readings timestamped 06:00–07:00 (the last hour of
--   the night shift) were rolled to the WRONG work-day bucket.
--
-- Fix:
--   Replace every `- interval '6 hours'` with `- interval '7 hours'` in
--   get_fleet_trend.  The work-day boundary now falls at 07:00, so:
--     00:00–06:59  → previous work-day  (tail of the night shift)
--     07:00–23:59  → current work-day   (day shift + start of night shift)
--
-- test_data.sql is updated in the same commit:
--   shift 1 now starts at 07:00, shift 2 at 19:00.
--
-- downsample_to_analytics is NOT changed: it computes UTC 5-min buckets
-- and does not perform work-day bucketing.  The bucketing happens in
-- get_fleet_trend when it reads from analytics_readings.
-- ============================================================================

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
LANGUAGE sql
STABLE
AS $$
WITH

-- ════════════════════════════════════════════════════════════════════════════
-- PATH A: shift_readings  (last 48 h — cumulative, needs delta/LAG)
-- Extended 7 h back for work-day bucketing of overnight readings (07:00 start).
-- ════════════════════════════════════════════════════════════════════════════
raw AS (
  SELECT
    recorded_at,
    machine_id,
    shift_number,
    efficiency::double precision  AS efficiency,
    reject_rate::double precision AS reject_rate,
    produced_boxes,
    produced_swabs,
    (recorded_at >= range_start)  AS in_range
  FROM shift_readings
  WHERE recorded_at >= (range_start - interval '7 hours')
    AND recorded_at <= range_end
),

anchors AS (
  SELECT DISTINCT ON (machine_id, shift_number)
    recorded_at, machine_id, shift_number,
    0::double precision AS efficiency,
    0::double precision AS reject_rate,
    produced_boxes, produced_swabs,
    FALSE AS in_range
  FROM shift_readings
  WHERE recorded_at < (range_start - interval '7 hours')
  ORDER BY machine_id, shift_number, recorded_at DESC
),

combined AS (
  SELECT * FROM raw
  UNION ALL
  SELECT * FROM anchors
),

deltas AS (
  SELECT
    recorded_at, machine_id, shift_number, efficiency, reject_rate, in_range,
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
    PARTITION BY machine_id, shift_number
    ORDER BY recorded_at
    ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
  )
),

-- Daily (shift_readings path)
sr_daily_max AS (
  SELECT
    TO_CHAR(DATE_TRUNC('day', recorded_at - interval '7 hours'), 'YYYY-MM-DD') AS bucket,
    machine_id, shift_number,
    MAX(produced_boxes)::bigint AS tot_boxes,
    MAX(produced_swabs)::bigint AS tot_swabs
  FROM raw
  WHERE bucket_granularity = 'day'
  GROUP BY 1, machine_id, shift_number
),
sr_daily AS (
  SELECT bucket, SUM(tot_boxes) AS total_boxes, SUM(tot_swabs) AS total_swabs
  FROM sr_daily_max GROUP BY bucket
),

-- Hourly (shift_readings path)
sr_hourly AS (
  SELECT
    TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24') AS bucket,
    SUM(delta_boxes) AS total_boxes,
    SUM(delta_swabs) AS total_swabs
  FROM deltas
  WHERE bucket_granularity = 'hour' AND in_range = TRUE
  GROUP BY 1
),

-- ════════════════════════════════════════════════════════════════════════════
-- PATH B: analytics_readings  (older than 48 h — already incremental, just SUM)
-- ════════════════════════════════════════════════════════════════════════════

-- Daily (analytics path)
ar_daily AS (
  SELECT
    TO_CHAR(DATE_TRUNC('day', bucket_start - interval '7 hours'), 'YYYY-MM-DD') AS bucket,
    SUM(swabs_produced)::bigint AS total_swabs,
    SUM(boxes_produced)::bigint AS total_boxes
  FROM analytics_readings
  WHERE bucket_granularity = 'day'
    AND bucket_start >= (range_start - interval '7 hours')
    AND bucket_start <= range_end
  GROUP BY 1
),

-- Hourly (analytics path)
ar_hourly AS (
  SELECT
    TO_CHAR(DATE_TRUNC('hour', bucket_start), 'YYYY-MM-DD"T"HH24') AS bucket,
    SUM(swabs_produced)::bigint AS total_swabs,
    SUM(boxes_produced)::bigint AS total_boxes
  FROM analytics_readings
  WHERE bucket_granularity = 'hour'
    AND bucket_start >= range_start
    AND bucket_start <= range_end
  GROUP BY 1
),

-- ── Combine both paths ─────────────────────────────────────────────────────
prod AS (
  SELECT bucket, total_boxes, total_swabs FROM sr_daily
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM sr_hourly
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM ar_daily
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM ar_hourly
),

-- Sum in case a bucket appears in both tables (transition window edge case)
prod_agg AS (
  SELECT bucket,
    SUM(total_boxes)::bigint AS total_boxes,
    SUM(total_swabs)::bigint AS total_swabs
  FROM prod
  GROUP BY bucket
),

-- ── Efficiency / scrap ─────────────────────────────────────────────────────
sr_agg AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
      ELSE             TO_CHAR(DATE_TRUNC('day',  recorded_at - interval '7 hours'), 'YYYY-MM-DD')
    END                                                AS bucket,
    ROUND(AVG(NULLIF(efficiency, 0))::numeric, 1)      AS avg_uptime,
    ROUND(AVG(reject_rate)::numeric,           1)      AS avg_scrap,
    COUNT(*)                                           AS reading_count,
    COUNT(DISTINCT machine_id)                         AS machine_count,
    COUNT(DISTINCT shift_number)                       AS shift_count
  FROM raw
  WHERE bucket_granularity = 'hour' AND in_range = TRUE
     OR bucket_granularity = 'day'
  GROUP BY 1
),

ar_agg AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', bucket_start), 'YYYY-MM-DD"T"HH24')
      ELSE             TO_CHAR(DATE_TRUNC('day', bucket_start - interval '7 hours'), 'YYYY-MM-DD')
    END                                                AS bucket,
    ROUND(
      (SUM(minutes_running) / NULLIF(
         SUM(minutes_running + minutes_idle + minutes_error + minutes_offline), 0)
       * 100)::numeric, 1)                             AS avg_uptime,
    ROUND(AVG(avg_scrap_rate)::numeric, 1)             AS avg_scrap,
    COUNT(*)::bigint                                   AS reading_count,
    COUNT(DISTINCT machine_id)                         AS machine_count,
    2::bigint                                          AS shift_count
  FROM analytics_readings
  WHERE bucket_granularity = 'hour'
    AND bucket_start >= range_start AND bucket_start <= range_end
   OR bucket_granularity = 'day'
    AND bucket_start >= (range_start - interval '7 hours') AND bucket_start <= range_end
  GROUP BY 1
),

-- Prefer sr_agg (more precise); fall back to ar_agg for older buckets
agg AS (
  SELECT * FROM sr_agg
  UNION ALL
  SELECT a.* FROM ar_agg a
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
LEFT JOIN prod_agg p USING (bucket)
ORDER BY a.bucket
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;
