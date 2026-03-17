-- ============================================================================
-- FUNCTION: downsample_to_analytics
-- Current version: migration 015 (interval-agnostic time tracking)
-- Purpose : Keep shift_readings lean by compressing readings older than 48 h
--           into 5-minute summary buckets in analytics_readings, then
--           deleting the raw rows.
-- Schedule: hourly via pg_cron (registered in migration 014).
-- ============================================================================
--
-- Time tracking is interval-agnostic:
--   Each reading owns the real elapsed seconds since the previous reading
--   (measured via LAG on recorded_at), capped at 60 s.  Gaps larger than
--   60 s indicate a bridge restart or offline period; the excess is
--   attributed to minutes_offline.  This is correct at 2 s, 5 s, 10 s, or
--   any other recording interval without any code change.
--
-- Production delta is also interval-agnostic:
--   LAG on produced_swabs / produced_boxes within (machine, shift) gives
--   the incremental production for each reading regardless of frequency.
-- ============================================================================

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
  WITH timed AS (
    SELECT
      sr.machine_id,
      m.machine_code,
      sr.recorded_at,
      sr.status,
      sr.speed,
      sr.efficiency,
      sr.reject_rate,
      sr.shift_number,

      -- 5-min bucket
      date_trunc('hour', sr.recorded_at)
        + (FLOOR(EXTRACT(EPOCH FROM
              (sr.recorded_at - date_trunc('hour', sr.recorded_at))
           ) / 300) * INTERVAL '5 minutes')  AS bucket_start,

      -- Actual gap to previous reading (seconds); 0 for the first reading
      COALESCE(
        EXTRACT(EPOCH FROM (
          sr.recorded_at
          - LAG(sr.recorded_at) OVER (
              PARTITION BY sr.machine_id ORDER BY sr.recorded_at)
        )),
        0.0
      ) AS raw_gap_secs,

      -- Incremental swabs (reset-safe)
      GREATEST(0, CASE
        WHEN sr.produced_swabs >= LAG(sr.produced_swabs, 1, 0::bigint)
             OVER (PARTITION BY sr.machine_id, sr.shift_number
                   ORDER BY sr.recorded_at)
        THEN sr.produced_swabs
             - LAG(sr.produced_swabs, 1, 0::bigint)
               OVER (PARTITION BY sr.machine_id, sr.shift_number
                     ORDER BY sr.recorded_at)
        ELSE sr.produced_swabs
      END) AS delta_swabs,

      -- Incremental boxes (reset-safe)
      GREATEST(0, CASE
        WHEN sr.produced_boxes >= LAG(sr.produced_boxes, 1, 0::bigint)
             OVER (PARTITION BY sr.machine_id, sr.shift_number
                   ORDER BY sr.recorded_at)
        THEN sr.produced_boxes
             - LAG(sr.produced_boxes, 1, 0::bigint)
               OVER (PARTITION BY sr.machine_id, sr.shift_number
                     ORDER BY sr.recorded_at)
        ELSE sr.produced_boxes
      END) AS delta_boxes

    FROM shift_readings sr
    JOIN machines m ON m.id = sr.machine_id
    WHERE sr.recorded_at < NOW() - INTERVAL '48 hours'
  ),

  capped AS (
    SELECT *,
      LEAST(raw_gap_secs, 60.0)            AS gap_secs,
      GREATEST(raw_gap_secs - 60.0, 0.0)  AS extra_offline
    FROM timed
  )

  SELECT
    machine_id, machine_code, bucket_start,
    ROUND(SUM(gap_secs) FILTER (WHERE status IN ('run','running')) / 60.0, 2),
    ROUND(SUM(gap_secs) FILTER (WHERE status = 'idle')             / 60.0, 2),
    ROUND(SUM(gap_secs) FILTER (WHERE status = 'error')            / 60.0, 2),
    ROUND((
        COALESCE(SUM(gap_secs) FILTER (WHERE status = 'offline' OR status IS NULL), 0)
      + COALESCE(SUM(extra_offline), 0)
    ) / 60.0, 2),
    ROUND(AVG(speed)       FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(efficiency)  FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(reject_rate) FILTER (WHERE status IN ('run','running')), 2),
    COALESCE(SUM(delta_swabs), 0),
    COALESCE(SUM(delta_boxes), 0)
  FROM capped
  GROUP BY machine_id, machine_code, bucket_start
  ON CONFLICT (machine_id, bucket_start) DO NOTHING;

  DELETE FROM shift_readings
  WHERE recorded_at < NOW() - INTERVAL '48 hours';

END;
$$;

GRANT EXECUTE ON FUNCTION downsample_to_analytics() TO anon, authenticated;
