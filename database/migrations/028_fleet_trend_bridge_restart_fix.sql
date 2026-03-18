-- Migration 028: get_fleet_trend — fix bridge-restart cumulative spike
--
-- Root cause: shift_readings stores CUMULATIVE produced_swabs per MQTT tick
-- (5 s interval).  The hourly LAG path computes incremental production as:
--
--   inc = current_hour_max - COALESCE(previous_hour_max, 0)
--
-- When the bridge starts mid-shift (restart / reconnect / Railway cold start),
-- the very first row in shift_readings has, say, 7 800 000 cumulative swabs
-- (all production since 07:00).  There is no previous row, so LAG = NULL,
-- COALESCE returns 0, and the entire shift output appears as a single 1-hour
-- spike in the chart.
--
-- Fix: replace COALESCE(LAG, 0) with COALESCE(LAG, max_swabs/max_boxes).
-- When LAG is NULL the increment becomes
--   current - current = 0
-- which is honest: "we don't know what was produced before the bridge came
-- online."  Hours before the restart are already covered correctly via the
-- analytics_readings path (which stores true incremental deltas).

CREATE OR REPLACE FUNCTION get_fleet_trend(
  range_start        timestamptz,
  range_end          timestamptz,
  bucket_granularity text          -- 'hour' or 'day'
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

-- ══════════════════════════════════════════════════════════════════════════════
-- HOURLY PATH  (shift_readings → LAG-based incremental)
-- ══════════════════════════════════════════════════════════════════════════════

-- Step H1: max cumulative per (clock-hour, machine, shift).
-- Fetch 12 h earlier than requested so every first in-range reading has a
-- LAG anchor from the same shift.
sr_hour_raw AS (
  SELECT
    date_trunc('hour', recorded_at)     AS hour_bucket,
    machine_id,
    shift_number,
    avg(nullif(efficiency, 0))          AS avg_eff,
    avg(reject_rate)                    AS avg_scrap_r,
    count(*)                            AS rdg_count,
    max(produced_boxes)                 AS max_boxes,
    max(produced_swabs)                 AS max_swabs
  FROM shift_readings
  WHERE bucket_granularity = 'hour'
    AND recorded_at >= range_start - interval '12 hours'   -- widened for LAG
    AND recorded_at <= range_end
  GROUP BY 1, 2, 3
),

-- Step H2: incremental = current cumulative − previous (per machine + shift).
-- GREATEST(0,…) guards against artefacts from out-of-order or reset rows.
--
-- KEY FIX (migration 028):
--   Old: COALESCE(LAG(...), 0)        ← bridge restart shows full cumulative
--   New: COALESCE(LAG(...), max_col)  ← bridge restart contributes 0
--
-- When the bridge comes online mid-shift the first row has no prior reading.
-- Using max_col as the fallback makes the increment = 0 for that first row
-- instead of exposing the full since-shift-start cumulative as one hour spike.
sr_hour_inc AS (
  SELECT
    to_char(hour_bucket, 'YYYY-MM-DD"T"HH24') AS bucket,
    hour_bucket,
    machine_id,
    avg_eff,
    avg_scrap_r,
    rdg_count,
    GREATEST(0,
      max_boxes - COALESCE(
        LAG(max_boxes) OVER (
          PARTITION BY machine_id, shift_number
          ORDER BY hour_bucket
        ), max_boxes)   -- ← was: 0
    ) AS inc_boxes,
    GREATEST(0,
      max_swabs - COALESCE(
        LAG(max_swabs) OVER (
          PARTITION BY machine_id, shift_number
          ORDER BY hour_bucket
        ), max_swabs)   -- ← was: 0
    ) AS inc_swabs
  FROM sr_hour_raw
),

-- Step H3: park-level aggregation — exclude anchor rows before range_start.
sr_hour_agg AS (
  SELECT
    bucket,
    round(avg(avg_eff)::numeric,     1) AS avg_uptime,
    round(avg(avg_scrap_r)::numeric, 1) AS avg_scrap,
    sum(inc_boxes)::bigint              AS total_boxes,
    sum(inc_swabs)::bigint              AS total_swabs,
    count(distinct machine_id)          AS machine_count,
    sum(rdg_count)                      AS reading_count,
    1::bigint                           AS shift_count
  FROM sr_hour_inc
  -- Drop the extra anchor hours that were fetched only to back-fill LAG.
  WHERE hour_bucket >= date_trunc('hour', range_start)
  GROUP BY bucket
),


-- ══════════════════════════════════════════════════════════════════════════════
-- DAILY PATH  (shift_readings → MAX deduplication + 7-hour work-day offset)
-- ══════════════════════════════════════════════════════════════════════════════

sr_day_src AS (
  SELECT
    to_char(date_trunc('day', recorded_at - interval '7 hours'), 'YYYY-MM-DD') AS bucket,
    machine_id,
    shift_number,
    efficiency,
    reject_rate,
    produced_boxes,
    produced_swabs
  FROM shift_readings
  WHERE bucket_granularity = 'day'
    AND recorded_at >= range_start - interval '7 hours'
    AND recorded_at <= range_end
),

sr_day_max_prod AS (
  SELECT bucket, machine_id, shift_number,
    max(produced_boxes) AS max_boxes,
    max(produced_swabs) AS max_swabs
  FROM sr_day_src
  GROUP BY bucket, machine_id, shift_number
),

sr_day_prod_totals AS (
  SELECT bucket,
    sum(max_boxes) AS total_boxes,
    sum(max_swabs) AS total_swabs
  FROM sr_day_max_prod
  GROUP BY bucket
),

sr_day_agg AS (
  SELECT
    bucket,
    round(avg(nullif(efficiency, 0))::numeric, 1) AS avg_uptime,
    round(avg(reject_rate)::numeric,           1) AS avg_scrap,
    count(*)                                       AS reading_count,
    count(distinct machine_id)                     AS machine_count,
    count(distinct shift_number)                   AS shift_count
  FROM sr_day_src
  GROUP BY bucket
),


-- ══════════════════════════════════════════════════════════════════════════════
-- Combined sr result
-- ══════════════════════════════════════════════════════════════════════════════

sr_agg AS (
  SELECT * FROM sr_hour_agg WHERE bucket_granularity = 'hour'
  UNION ALL
  SELECT
    d.bucket,
    d.avg_uptime,
    d.avg_scrap,
    coalesce(p.total_boxes, 0)::bigint,
    coalesce(p.total_swabs, 0)::bigint,
    d.machine_count,
    d.reading_count,
    d.shift_count
  FROM sr_day_agg d
  LEFT JOIN sr_day_prod_totals p USING (bucket)
  WHERE bucket_granularity = 'day'
),


-- ══════════════════════════════════════════════════════════════════════════════
-- analytics_readings PATH  (already incremental — SUM for both granularities)
-- ══════════════════════════════════════════════════════════════════════════════

ar_src AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN to_char(date_trunc('hour', bucket_start),                      'YYYY-MM-DD"T"HH24')
      ELSE             to_char(date_trunc('day',  bucket_start - interval '7 hours'), 'YYYY-MM-DD')
    END AS bucket,
    machine_id,
    avg_efficiency,
    avg_scrap_rate,
    boxes_produced,
    swabs_produced,
    CASE WHEN extract(hour FROM bucket_start) >= 7
              AND extract(hour FROM bucket_start) < 19
         THEN 'A' ELSE 'B'
    END AS shift_label
  FROM analytics_readings
  WHERE bucket_start >= CASE bucket_granularity
                          WHEN 'hour' THEN range_start
                          ELSE range_start - interval '7 hours'
                        END
    AND bucket_start <= range_end
),

ar_agg AS (
  SELECT
    bucket,
    round(avg(nullif(avg_efficiency, 0))::numeric, 1) AS avg_uptime,
    round(avg(avg_scrap_rate)::numeric,            1) AS avg_scrap,
    count(*)                                           AS reading_count,
    count(distinct machine_id)                         AS machine_count,
    count(distinct shift_label)                        AS shift_count,
    sum(boxes_produced)                                AS total_boxes,
    sum(swabs_produced)                                AS total_swabs
  FROM ar_src
  GROUP BY bucket
),


-- ══════════════════════════════════════════════════════════════════════════════
-- Final UNION: sr wins over ar for any bucket present in both
-- ══════════════════════════════════════════════════════════════════════════════

combined AS (
  SELECT * FROM sr_agg

  UNION ALL

  SELECT
    a.bucket,
    coalesce(a.avg_uptime, 0)          AS avg_uptime,
    coalesce(a.avg_scrap,  0)          AS avg_scrap,
    coalesce(a.total_boxes, 0)::bigint AS total_boxes,
    coalesce(a.total_swabs, 0)::bigint AS total_swabs,
    a.machine_count,
    a.reading_count,
    a.shift_count
  FROM ar_agg a
  WHERE NOT EXISTS (
    SELECT 1 FROM sr_agg s WHERE s.bucket = a.bucket
  )
)

SELECT * FROM combined
WHERE (bucket_granularity = 'hour')
   OR (bucket >= to_char(date_trunc('day', range_start - interval '7 hours'), 'YYYY-MM-DD'))
ORDER BY bucket;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;
