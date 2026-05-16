-- Migration 079: get_fleet_trend_minute — sub-hour bucketed trend from shift_readings
--
-- The 24h chart previously read the pre-aggregated hourly_analytics table, which
-- forced a 1-hour x-axis grid. With shift_readings retained for 48 h at ~5 s
-- cadence we can bucket finer (15 min by default) and draw a genuinely
-- continuous timeline.
--
-- Bucket key format: "YYYY-MM-DDTHH:MM" (UTC), to mirror the 13-char
-- "YYYY-MM-DDTHH" used by the hourly path. The frontend parses it the same
-- way (parseISO(key + ":00Z") for minute, parseISO(key + ":00:00Z") for hour).
--
-- Single SQL function serves three callers via the optional machine_ids filter:
--   NULL                → fleet-wide (all machines)
--   ARRAY[<uuid>]       → single machine
--   ARRAY[<uuid>, …]    → peer set
--
-- Delta logic mirrors get_fleet_trend HOURLY path (migration 025):
--   per (machine, shift_crew, bucket) take MAX of each cumulative counter,
--   then LAG within (machine, shift_crew) ORDER BY bucket gives the
--   incremental production / production_time / discarded for that bucket.
--   GREATEST(0, …) guards against PLC restarts or out-of-order delivery.

CREATE OR REPLACE FUNCTION get_fleet_trend_minute(
  range_start    timestamptz,
  range_end      timestamptz,
  bucket_minutes int,
  machine_ids    uuid[] DEFAULT NULL
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

-- Step 1: max cumulative per (bucket, machine, shift) ─────────────────────────
sr_bucket_raw AS (
  SELECT
    date_bin(
      make_interval(mins => bucket_minutes),
      recorded_at,
      TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
    )                                   AS bucket_ts,
    machine_id,
    shift_crew,
    count(*)                            AS rdg_count,
    max(produced_boxes)                 AS max_boxes,
    max(produced_swabs)                 AS max_swabs,
    max(production_time)                AS max_prod_t,    -- seconds (cumulative)
    max(discarded_swabs)                AS max_discarded
  FROM shift_readings
  WHERE recorded_at >= range_start
    AND recorded_at <= range_end
    AND (machine_ids IS NULL OR machine_id = ANY(machine_ids))
  GROUP BY 1, 2, 3
),

-- Step 2: incremental delta per (bucket, machine, shift) ──────────────────────
sr_bucket_inc AS (
  SELECT
    bucket_ts,
    machine_id,
    rdg_count,
    GREATEST(0,
      max_boxes - COALESCE(
        LAG(max_boxes) OVER (
          PARTITION BY machine_id, shift_crew
          ORDER BY bucket_ts
        ), 0)
    ) AS inc_boxes,
    GREATEST(0,
      max_swabs - COALESCE(
        LAG(max_swabs) OVER (
          PARTITION BY machine_id, shift_crew
          ORDER BY bucket_ts
        ), 0)
    ) AS inc_swabs,
    GREATEST(0,
      max_prod_t - COALESCE(
        LAG(max_prod_t) OVER (
          PARTITION BY machine_id, shift_crew
          ORDER BY bucket_ts
        ), 0)
    ) AS inc_prod_secs,
    GREATEST(0,
      max_discarded - COALESCE(
        LAG(max_discarded) OVER (
          PARTITION BY machine_id, shift_crew
          ORDER BY bucket_ts
        ), 0)
    ) AS inc_discarded,
    shift_crew
  FROM sr_bucket_raw
),

-- Step 3: park-level (or filtered-set) aggregation per bucket ─────────────────
-- avg_uptime  = sum(inc_prod_secs) / (machine_count * bucket_seconds) * 100
-- avg_scrap   = sum(inc_discarded) / sum(inc_swabs) * 100   (volume-weighted)
sr_bucket_agg AS (
  SELECT
    to_char(bucket_ts, 'YYYY-MM-DD"T"HH24:MI')          AS bucket,
    sum(inc_boxes)::bigint                              AS total_boxes,
    sum(inc_swabs)::bigint                              AS total_swabs,
    sum(inc_discarded)::bigint                          AS total_discarded,
    sum(inc_prod_secs)::bigint                          AS total_prod_secs,
    count(DISTINCT machine_id)                          AS machine_count,
    sum(rdg_count)                                      AS reading_count,
    count(DISTINCT shift_crew)                        AS shift_count
  FROM sr_bucket_inc
  GROUP BY bucket_ts
)

SELECT
  bucket,
  CASE
    WHEN machine_count > 0 THEN
      round((total_prod_secs::numeric / (machine_count * bucket_minutes * 60)) * 100, 1)
    ELSE 0
  END                                                   AS avg_uptime,
  CASE
    WHEN total_swabs > 0 THEN
      round((total_discarded::numeric / total_swabs) * 100, 1)
    ELSE 0
  END                                                   AS avg_scrap,
  total_boxes,
  total_swabs,
  machine_count,
  reading_count,
  shift_count
FROM sr_bucket_agg
ORDER BY bucket;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend_minute(timestamptz, timestamptz, int, uuid[])
  TO anon, authenticated;
