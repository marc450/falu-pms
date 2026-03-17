-- Migration 015: Make downsample_to_analytics interval-agnostic
-- ============================================================================
--
-- Problem in migration 014:
--   minutes_running / idle / error / offline were calculated as:
--     COUNT(*) * 5.0 / 60.0
--   The hardcoded 5.0 assumes readings arrive every 5 seconds.
--   At 2-second intervals: overcounts by 2.5×.
--   At 10-second intervals: undercounts by 2×.
--
-- Fix:
--   Measure the actual time gap between consecutive readings using
--   LAG(recorded_at).  Each reading "owns" the seconds since the previous
--   reading, and that duration is attributed to the reading's status.
--
--   Gap cap = 60 seconds:
--     Normal gaps: 2 s, 5 s, 10 s — all well under the cap.
--     Large gaps (bridge restart, shift transition, offline period) exceed
--     the cap; the excess is attributed to minutes_offline rather than to
--     whichever status the next reading happens to have.
--
--   Result: minutes_running + minutes_idle + minutes_error + minutes_offline
--   always equals the real time covered in the bucket, regardless of the
--   recording interval.  No code change is needed if the interval changes
--   in the future.

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
      -- Partitioned by machine only so shift-boundary gaps are included and
      -- correctly capped rather than silently dropped.
      -- First reading per machine has no predecessor → gap = 0.
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
        ELSE sr.produced_swabs   -- cumulative reset at shift start
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

  -- ── Apply 60-second cap ───────────────────────────────────────────────────
  -- gap_secs  = seconds attributed to the reading's own status (max 60)
  -- extra_offline = seconds beyond the cap, always attributed to offline
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

    -- minutes in each state = SUM of real elapsed seconds / 60
    ROUND(SUM(gap_secs) FILTER (WHERE status IN ('run','running'))
          / 60.0, 2)                                           AS minutes_running,

    ROUND(SUM(gap_secs) FILTER (WHERE status = 'idle')
          / 60.0, 2)                                           AS minutes_idle,

    ROUND(SUM(gap_secs) FILTER (WHERE status = 'error')
          / 60.0, 2)                                           AS minutes_error,

    -- offline = explicit offline readings + all gap excess beyond 60 s cap
    ROUND((
        COALESCE(SUM(gap_secs) FILTER (
            WHERE status = 'offline' OR status IS NULL), 0)
      + COALESCE(SUM(extra_offline), 0)
    ) / 60.0, 2)                                              AS minutes_offline,

    ROUND(AVG(speed)       FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(efficiency)  FILTER (WHERE status IN ('run','running')), 2),
    ROUND(AVG(reject_rate) FILTER (WHERE status IN ('run','running')), 2),

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
