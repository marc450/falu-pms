-- Migration 018: Fix downsample_to_analytics() ROUND cast error
-- ============================================================================
-- PostgreSQL ROUND(x, n) requires x to be numeric.
-- EXTRACT(EPOCH FROM ...) returns double precision, so dividing by 60.0 also
-- gives double precision.  Adding ::numeric casts fixes the 42883 error.
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

      -- ── 5-min bucket this reading belongs to ─────────────────────────────
      date_trunc('hour', sr.recorded_at)
        + (FLOOR(EXTRACT(EPOCH FROM
              (sr.recorded_at - date_trunc('hour', sr.recorded_at))
           ) / 300) * INTERVAL '5 minutes')  AS bucket_start,

      -- ── Time gap to the previous reading for this machine (seconds) ───────
      COALESCE(
        EXTRACT(EPOCH FROM (
          sr.recorded_at
          - LAG(sr.recorded_at) OVER (
              PARTITION BY sr.machine_id
              ORDER BY sr.recorded_at
            )
        )),
        0.0
      ) AS raw_gap_secs,

      -- ── Incremental swabs / boxes (LAG within machine + shift) ───────────
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
    SELECT
      *,
      LEAST(raw_gap_secs,  60.0) AS gap_secs,
      GREATEST(raw_gap_secs - 60.0, 0.0) AS extra_offline
    FROM timed
  )

  SELECT
    machine_id,
    machine_code,
    bucket_start,

    -- Cast to numeric before ROUND to satisfy PostgreSQL's type rules
    ROUND(SUM(gap_secs) FILTER (WHERE status IN ('run','running'))::numeric
          / 60.0, 2)                                           AS minutes_running,

    ROUND(SUM(gap_secs) FILTER (WHERE status = 'idle')::numeric
          / 60.0, 2)                                           AS minutes_idle,

    ROUND(SUM(gap_secs) FILTER (WHERE status = 'error')::numeric
          / 60.0, 2)                                           AS minutes_error,

    ROUND((
        COALESCE(SUM(gap_secs) FILTER (
            WHERE status = 'offline' OR status IS NULL), 0)
      + COALESCE(SUM(extra_offline), 0)
    )::numeric / 60.0, 2)                                     AS minutes_offline,

    ROUND(AVG(speed)       FILTER (WHERE status IN ('run','running'))::numeric, 2),
    ROUND(AVG(efficiency)  FILTER (WHERE status IN ('run','running'))::numeric, 2),
    ROUND(AVG(reject_rate) FILTER (WHERE status IN ('run','running'))::numeric, 2),

    COALESCE(SUM(delta_swabs), 0),
    COALESCE(SUM(delta_boxes), 0)

  FROM capped
  GROUP BY machine_id, machine_code, bucket_start
  ON CONFLICT (machine_id, bucket_start) DO NOTHING;

  -- ── Remove raw readings that have been summarised ─────────────────────────
  DELETE FROM shift_readings
  WHERE recorded_at < NOW() - INTERVAL '48 hours';

END;
$$;

GRANT EXECUTE ON FUNCTION downsample_to_analytics() TO anon, authenticated;
