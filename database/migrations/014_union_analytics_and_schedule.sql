-- Migration 014: Union analytics_readings into get_fleet_trend +
--               Fix downsample_to_analytics (LAG-based deltas) +
--               Schedule hourly via pg_cron
-- ============================================================================
--
-- PREREQUISITES:
--   Enable the pg_cron extension in Supabase first:
--   Dashboard → Database → Extensions → search "pg_cron" → Enable
--
-- WHY analytics_readings was empty:
--   downsample_to_analytics() existed but was never scheduled.
--   It also had a MAX-MIN production calculation that gives 0 whenever
--   there is only one reading per 5-min bucket (sparse test data or first
--   reading of a shift).  This migration fixes both issues.
--
-- AFTER this migration:
--   • shift_readings holds only the last 48 h of raw readings
--   • analytics_readings holds everything older, compressed to 5-min buckets
--   • get_fleet_trend reads from BOTH tables transparently
-- ============================================================================


-- ── 1. Updated downsample_to_analytics (LAG-based deltas) ─────────────────

CREATE OR REPLACE FUNCTION downsample_to_analytics()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN

  INSERT INTO analytics_readings (
    machine_id, machine_code, bucket_start,
    minutes_running, minutes_idle, minutes_error, minutes_offline,
    avg_speed, avg_efficiency, avg_scrap_rate,
    swabs_produced, boxes_produced
  )
  WITH deltas AS (
    SELECT
      sr.machine_id,
      m.machine_code,
      sr.recorded_at,
      sr.status,
      sr.speed,
      sr.efficiency,
      sr.reject_rate,
      date_trunc('hour', sr.recorded_at)
        + (FLOOR(EXTRACT(EPOCH FROM
            (sr.recorded_at - date_trunc('hour', sr.recorded_at))
           ) / 300) * INTERVAL '5 minutes')  AS bucket_start,
      GREATEST(0, CASE
        WHEN sr.produced_swabs >= LAG(sr.produced_swabs, 1, 0::bigint)
             OVER (PARTITION BY sr.machine_id, sr.shift_number ORDER BY sr.recorded_at)
        THEN sr.produced_swabs - LAG(sr.produced_swabs, 1, 0::bigint)
             OVER (PARTITION BY sr.machine_id, sr.shift_number ORDER BY sr.recorded_at)
        ELSE sr.produced_swabs
      END) AS delta_swabs,
      GREATEST(0, CASE
        WHEN sr.produced_boxes >= LAG(sr.produced_boxes, 1, 0::bigint)
             OVER (PARTITION BY sr.machine_id, sr.shift_number ORDER BY sr.recorded_at)
        THEN sr.produced_boxes - LAG(sr.produced_boxes, 1, 0::bigint)
             OVER (PARTITION BY sr.machine_id, sr.shift_number ORDER BY sr.recorded_at)
        ELSE sr.produced_boxes
      END) AS delta_boxes
    FROM shift_readings sr
    JOIN machines m ON m.id = sr.machine_id
    WHERE sr.recorded_at < NOW() - INTERVAL '48 hours'
  )
  SELECT
    machine_id, machine_code, bucket_start,
    ROUND(COUNT(*) FILTER (WHERE status IN ('run','running'))::NUMERIC * 5.0/60.0, 2),
    ROUND(COUNT(*) FILTER (WHERE status = 'idle')::NUMERIC               * 5.0/60.0, 2),
    ROUND(COUNT(*) FILTER (WHERE status = 'error')::NUMERIC              * 5.0/60.0, 2),
    ROUND(COUNT(*) FILTER (WHERE status = 'offline' OR status IS NULL)::NUMERIC * 5.0/60.0, 2),
    ROUND(AVG(speed)       FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(efficiency)  FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(reject_rate) FILTER (WHERE status IN ('run','running')), 2),
    COALESCE(SUM(delta_swabs), 0),
    COALESCE(SUM(delta_boxes), 0)
  FROM deltas
  GROUP BY machine_id, machine_code, bucket_start
  ON CONFLICT (machine_id, bucket_start) DO NOTHING;

  DELETE FROM shift_readings
  WHERE recorded_at < NOW() - INTERVAL '48 hours';

END;
$$;

GRANT EXECUTE ON FUNCTION downsample_to_analytics() TO anon, authenticated;


-- ── 2. Updated get_fleet_trend: reads from BOTH shift_readings (recent)
--       and analytics_readings (older than 48 h) ───────────────────────────

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
-- Extended 6 h back for work-day bucketing of overnight shift 2 readings.
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
  WHERE recorded_at >= (range_start - interval '6 hours')
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
  WHERE recorded_at < (range_start - interval '6 hours')
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
    TO_CHAR(DATE_TRUNC('day', recorded_at - interval '6 hours'), 'YYYY-MM-DD') AS bucket,
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
    TO_CHAR(DATE_TRUNC('day', bucket_start - interval '6 hours'), 'YYYY-MM-DD') AS bucket,
    SUM(swabs_produced)::bigint AS total_swabs,
    SUM(boxes_produced)::bigint AS total_boxes
  FROM analytics_readings
  WHERE bucket_granularity = 'day'
    AND bucket_start >= (range_start - interval '6 hours')
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
  -- shift_readings (recent)
  SELECT bucket, total_boxes, total_swabs FROM sr_daily
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM sr_hourly
  UNION ALL
  -- analytics_readings (older)
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

-- ── Efficiency / scrap — from shift_readings (in-range) ───────────────────
-- For data already in analytics_readings we use minutes_running to derive
-- uptime, and avg_scrap_rate directly.
sr_agg AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
      ELSE             TO_CHAR(DATE_TRUNC('day',  recorded_at - interval '6 hours'), 'YYYY-MM-DD')
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
      ELSE             TO_CHAR(DATE_TRUNC('day', bucket_start - interval '6 hours'), 'YYYY-MM-DD')
    END                                                AS bucket,
    -- uptime = fraction of time the machines were running
    ROUND(
      (SUM(minutes_running) / NULLIF(
         SUM(minutes_running + minutes_idle + minutes_error + minutes_offline), 0)
       * 100)::numeric, 1)                             AS avg_uptime,
    ROUND(AVG(avg_scrap_rate)::numeric, 1)             AS avg_scrap,
    COUNT(*)::bigint                                   AS reading_count,
    COUNT(DISTINCT machine_id)                         AS machine_count,
    2::bigint                                          AS shift_count   -- approximate
  FROM analytics_readings
  WHERE bucket_granularity = 'hour'
    AND bucket_start >= range_start AND bucket_start <= range_end
   OR bucket_granularity = 'day'
    AND bucket_start >= (range_start - interval '6 hours') AND bucket_start <= range_end
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


-- ── 3. Schedule downsample_to_analytics hourly via pg_cron ─────────────────
--
-- PREREQUISITE: enable pg_cron in Dashboard → Database → Extensions first.
--
-- Run this block AFTER enabling pg_cron:

SELECT cron.schedule(
  'downsample-analytics-hourly',   -- job name (unique)
  '5 * * * *',                     -- every hour at :05
  'SELECT downsample_to_analytics()'
);

-- To verify the schedule was created:
-- SELECT * FROM cron.job;
--
-- To remove it later:
-- SELECT cron.unschedule('downsample-analytics-hourly');
