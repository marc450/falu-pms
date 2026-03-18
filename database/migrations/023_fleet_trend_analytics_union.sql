-- Migration 023: get_fleet_trend — union shift_readings + analytics_readings
--
-- Previously, get_fleet_trend only read from shift_readings.
-- downsample_to_analytics deletes rows older than 48 h from shift_readings
-- and moves them into analytics_readings.  This meant all historical data
-- vanished from the Production Trend chart within 48 h of being recorded.
--
-- Fix: mirror the two-source UNION pattern used by get_machine_shift_summary
-- (migration 017).  Recent data (still in shift_readings) is preferred;
-- older data is read from analytics_readings where it persists indefinitely.
--
-- analytics_readings stores incremental deltas (not cumulative counters), so
-- swabs_produced and boxes_produced are summed directly instead of using the
-- MAX-per-(machine,shift) deduplication that shift_readings requires.

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

-- ── PATH A: shift_readings (recent, cumulative counters) ─────────────────────
sr_src AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN to_char(date_trunc('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
      ELSE             to_char(date_trunc('day',  recorded_at), 'YYYY-MM-DD')
    END            AS bucket,
    machine_id,
    shift_number,
    efficiency,
    reject_rate,
    produced_boxes,
    produced_swabs
  FROM shift_readings
  WHERE recorded_at >= range_start
    AND recorded_at <= range_end
),

-- MAX per (machine, shift, bucket) deduplicates cumulative counters
sr_max_prod AS (
  SELECT bucket, machine_id, shift_number,
    max(produced_boxes) AS max_boxes,
    max(produced_swabs) AS max_swabs
  FROM sr_src
  GROUP BY bucket, machine_id, shift_number
),

sr_prod_totals AS (
  SELECT bucket,
    sum(max_boxes) AS total_boxes,
    sum(max_swabs) AS total_swabs
  FROM sr_max_prod
  GROUP BY bucket
),

sr_agg AS (
  SELECT
    bucket,
    round(avg(nullif(efficiency, 0))::numeric, 1) AS avg_uptime,
    round(avg(reject_rate)::numeric,           1) AS avg_scrap,
    count(*)                                       AS reading_count,
    count(distinct machine_id)                     AS machine_count,
    count(distinct shift_number)                   AS shift_count
  FROM sr_src
  GROUP BY bucket
),

-- ── PATH B: analytics_readings (historical, incremental deltas) ──────────────
ar_src AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN to_char(date_trunc('hour', bucket_start), 'YYYY-MM-DD"T"HH24')
      ELSE             to_char(date_trunc('day',  bucket_start), 'YYYY-MM-DD')
    END AS bucket,
    machine_id,
    avg_efficiency,
    avg_scrap_rate,
    boxes_produced,
    swabs_produced,
    -- Derive shift label so we can count distinct shifts per bucket
    CASE WHEN extract(hour FROM bucket_start) >= 7
              AND extract(hour FROM bucket_start) < 19
         THEN 'A' ELSE 'B'
    END AS shift_label
  FROM analytics_readings
  WHERE bucket_start >= range_start
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

-- ── UNION: sr takes precedence for any bucket it covers ──────────────────────
combined AS (
  SELECT
    s.bucket,
    coalesce(s.avg_uptime, 0)          AS avg_uptime,
    coalesce(s.avg_scrap,  0)          AS avg_scrap,
    coalesce(p.total_boxes, 0)::bigint AS total_boxes,
    coalesce(p.total_swabs, 0)::bigint AS total_swabs,
    s.machine_count,
    s.reading_count,
    s.shift_count
  FROM sr_agg s
  LEFT JOIN sr_prod_totals p USING (bucket)

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

SELECT * FROM combined ORDER BY bucket;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;
