-- Migration 039: replace analytics_readings with saved_shift_logs in get_fleet_trend
--
-- analytics_readings has fundamental, unrecoverable data quality issues:
--   • swabs_produced inflated by LAG default=0 bug in old downsample function
--   • avg_efficiency wrongly set to 100% by migration 038
--   • minutes_idle / minutes_error = NULL (status value mismatch)
--   • avg_speed / avg_scrap_rate = NULL (never computed in old schema)
--   • minutes_offline absurdly large (bridge restart gaps dumped into single buckets)
--
-- saved_shift_logs contains clean, authoritative per-shift totals:
--   • produced_swabs / produced_boxes — PLC end-of-shift counters
--   • efficiency — PLC efficiency % (0-100)
--   • reject_rate — PLC reject/scrap rate %
--   • production_time — seconds of productive uptime (normalised by migration 037)
--
-- Architecture after this migration:
--   shift_readings  → hourly view and the most recent 48 h of daily view
--   saved_shift_logs → all historical daily view (> what shift_readings covers)
--   analytics_readings → no longer queried by any RPC (can be archived/dropped later)

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

config AS (
  SELECT
    COALESCE(MAX((value->>'firstShiftStartHour')::int),  7) AS first_hour,
    COALESCE(MAX((value->>'shiftDurationHours')::int),  12) AS dur_hours
  FROM app_settings
  WHERE key = 'shift_config'
),

-- ════════════════════════════════════════════════════════════════════════════
-- PATH A: shift_readings  (last 48 h — cumulative, needs delta/LAG)
-- Extended (first_hour) hours back for work-day bucketing of overnight readings.
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

-- Daily totals (shift_readings path — per machine per shift, then sum)
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

-- Hourly totals (shift_readings path)
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
-- PATH B: saved_shift_logs  (historical — clean per-shift totals)
-- Only used for daily granularity; hourly historical is not meaningful here.
-- Deduplication: rows in sr_daily (last ~48 h) take precedence.
-- ════════════════════════════════════════════════════════════════════════════
ssl_daily AS (
  SELECT
    TO_CHAR(
      DATE_TRUNC('day', sl.saved_at - (c.first_hour || ' hours')::interval),
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

-- ── Combine both paths ─────────────────────────────────────────────────────
prod AS (
  SELECT bucket, total_boxes, total_swabs FROM sr_daily
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM sr_hourly
  UNION ALL
  -- saved_shift_logs only for days not already covered by shift_readings
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

-- ── Efficiency / scrap (shift_readings path) ───────────────────────────────
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

-- ── Efficiency / scrap (saved_shift_logs path) ────────────────────────────
ssl_agg AS (
  SELECT
    TO_CHAR(
      DATE_TRUNC('day', sl.saved_at - (c.first_hour || ' hours')::interval),
      'YYYY-MM-DD'
    ) AS bucket,
    -- efficiency is the PLC-reported uptime % for the shift (0-100)
    ROUND(AVG(NULLIF(sl.efficiency, 0))::numeric, 1)   AS avg_uptime,
    ROUND(AVG(sl.reject_rate)::numeric, 1)             AS avg_scrap,
    COUNT(*)::bigint                                   AS reading_count,
    COUNT(DISTINCT sl.machine_id)::bigint              AS machine_count,
    -- count distinct shift labels (A/B/C/D) within this work-day bucket
    COUNT(DISTINCT
      SUBSTR('ABCD',
        1 + LEAST(3, GREATEST(0,
          FLOOR(
            (((EXTRACT(HOUR FROM sl.saved_at)::int - c.first_hour + 24) % 24))::double precision
            / c.dur_hours::double precision
          )::int
        )),
        1
      )
    )::bigint AS shift_count
  FROM saved_shift_logs sl
  CROSS JOIN config c
  WHERE bucket_granularity = 'day'
    AND sl.saved_at >= (range_start - (c.first_hour || ' hours')::interval)
    AND sl.saved_at <= range_end
  GROUP BY 1
),

-- Prefer sr_agg (live, more precise); fall back to ssl_agg for older days
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
LEFT JOIN prod_agg p USING (bucket)
ORDER BY a.bucket
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;
