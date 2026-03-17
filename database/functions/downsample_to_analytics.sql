-- ============================================================================
-- FUNCTION: downsample_to_analytics
-- Purpose : Keep shift_readings lean by compressing readings older than 48 h
--           into 5-minute summary buckets in analytics_readings, then deleting
--           the raw rows.
-- Schedule: run hourly via pg_cron (see migration 014 for setup).
-- ============================================================================
--
-- analytics_readings schema (inferred):
--   machine_id       UUID
--   machine_code     TEXT
--   bucket_start     TIMESTAMPTZ          -- start of the 5-min bucket
--   minutes_running  NUMERIC
--   minutes_idle     NUMERIC
--   minutes_error    NUMERIC
--   minutes_offline  NUMERIC
--   avg_speed        NUMERIC
--   avg_efficiency   NUMERIC
--   avg_scrap_rate   NUMERIC
--   swabs_produced   NUMERIC / BIGINT
--   boxes_produced   NUMERIC / BIGINT
--   UNIQUE (machine_id, bucket_start)
--
-- IMPORTANT — production delta calculation:
--   shift_readings stores CUMULATIVE produced_swabs/produced_boxes per shift.
--   The original function used MAX - MIN per 5-min bucket, which gives 0
--   whenever there is only one reading in a bucket (sparse test data,
--   or the first reading of a shift).  The updated version below uses
--   LAG() to compute the per-reading delta BEFORE bucketing, then SUMs
--   the deltas inside each bucket.  This is correct for both:
--     • Dense data  (bridge: one reading every 5 s → many per bucket)
--     • Sparse data (test data: one reading every 2 h → one per bucket)
-- ============================================================================

CREATE OR REPLACE FUNCTION downsample_to_analytics()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN

  -- ── Step 1: compute per-reading deltas, then aggregate into 5-min buckets ─
  INSERT INTO analytics_readings (
    machine_id,
    machine_code,
    bucket_start,
    minutes_running,
    minutes_idle,
    minutes_error,
    minutes_offline,
    avg_speed,
    avg_efficiency,
    avg_scrap_rate,
    swabs_produced,
    boxes_produced
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
      -- 5-min bucket this reading belongs to
      date_trunc('hour', sr.recorded_at)
        + (FLOOR(EXTRACT(EPOCH FROM
            (sr.recorded_at - date_trunc('hour', sr.recorded_at))
           ) / 300) * INTERVAL '5 minutes')  AS bucket_start,
      -- Incremental swabs: LAG within (machine, shift) ordered by time.
      -- If cumulative decreased, a new shift started → use value directly.
      GREATEST(0,
        CASE
          WHEN sr.produced_swabs
               >= LAG(sr.produced_swabs, 1, 0::bigint)
                  OVER (PARTITION BY sr.machine_id, sr.shift_number
                        ORDER BY sr.recorded_at)
          THEN sr.produced_swabs
               - LAG(sr.produced_swabs, 1, 0::bigint)
                 OVER (PARTITION BY sr.machine_id, sr.shift_number
                       ORDER BY sr.recorded_at)
          ELSE sr.produced_swabs
        END
      ) AS delta_swabs,
      GREATEST(0,
        CASE
          WHEN sr.produced_boxes
               >= LAG(sr.produced_boxes, 1, 0::bigint)
                  OVER (PARTITION BY sr.machine_id, sr.shift_number
                        ORDER BY sr.recorded_at)
          THEN sr.produced_boxes
               - LAG(sr.produced_boxes, 1, 0::bigint)
                 OVER (PARTITION BY sr.machine_id, sr.shift_number
                       ORDER BY sr.recorded_at)
          ELSE sr.produced_boxes
        END
      ) AS delta_boxes
    FROM shift_readings sr
    JOIN machines m ON m.id = sr.machine_id
    WHERE sr.recorded_at < NOW() - INTERVAL '48 hours'
  )
  SELECT
    machine_id,
    machine_code,
    bucket_start,
    -- minutes_running: count readings where machine was running × 5 s / 60
    ROUND(COUNT(*) FILTER (WHERE status IN ('run','running'))::NUMERIC
          * 5.0 / 60.0, 2),
    ROUND(COUNT(*) FILTER (WHERE status = 'idle')::NUMERIC
          * 5.0 / 60.0, 2),
    ROUND(COUNT(*) FILTER (WHERE status = 'error')::NUMERIC
          * 5.0 / 60.0, 2),
    ROUND(COUNT(*) FILTER (WHERE status = 'offline' OR status IS NULL)::NUMERIC
          * 5.0 / 60.0, 2),
    ROUND(AVG(speed)      FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(efficiency) FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(reject_rate)FILTER (WHERE status IN ('run','running')), 2),
    COALESCE(SUM(delta_swabs), 0),
    COALESCE(SUM(delta_boxes), 0)
  FROM deltas
  GROUP BY machine_id, machine_code, bucket_start
  ON CONFLICT (machine_id, bucket_start) DO NOTHING;

  -- ── Step 2: delete raw readings that have been summarised ─────────────────
  DELETE FROM shift_readings
  WHERE recorded_at < NOW() - INTERVAL '48 hours';

END;
$$;

GRANT EXECUTE ON FUNCTION downsample_to_analytics() TO anon, authenticated;
