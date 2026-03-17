-- Migration 010: Fix get_fleet_trend for hourly granularity
--
-- Root cause of the hourly spike problem:
--   shift_readings stores CUMULATIVE swab/box counts from shift start.
--   The previous RPC used MAX(produced_swabs) per (hour-bucket, machine, shift).
--   The last reading of a shift (e.g. at 06:00 after 12 h) shows the full
--   shift cumulative, which made that one bar 10-50x taller than the others.
--
-- Fix:
--   HOURLY  → use LAG() to compute the delta (incremental) production between
--             consecutive readings for each machine+shift session.
--             A cumulative reset (produced_swabs drops) is treated as a new
--             session start and the reading is used as-is.
--
--   DAILY   → keep MAX() per (day, machine, shift) which correctly gives the
--             end-of-shift cumulative total; then SUM across shifts.

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

-- ── 1. Raw readings in the requested window ──────────────────────────────────
raw AS (
  SELECT
    recorded_at,
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

-- ── 2. Delta computation (for hourly path) ───────────────────────────────────
-- Partition by (machine_id, shift_number) so the LAG looks at the previous
-- reading of the same shift on this machine, regardless of calendar day.
-- When produced_swabs DECREASES (new shift session started), treat the current
-- reading value as the delta (it's the production so far in the new session).
deltas AS (
  SELECT
    recorded_at,
    machine_id,
    shift_number,
    efficiency,
    reject_rate,
    GREATEST(0,
      CASE
        WHEN produced_swabs >= LAG(produced_swabs, 1, 0::bigint)
                                   OVER (PARTITION BY machine_id, shift_number
                                         ORDER BY recorded_at
                                         ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
        THEN produced_swabs
             - LAG(produced_swabs, 1, 0::bigint)
                 OVER (PARTITION BY machine_id, shift_number
                       ORDER BY recorded_at
                       ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
        ELSE produced_swabs   -- cumulative reset: first reading of new session
      END
    ) AS delta_swabs,
    GREATEST(0,
      CASE
        WHEN produced_boxes >= LAG(produced_boxes, 1, 0::bigint)
                                   OVER (PARTITION BY machine_id, shift_number
                                         ORDER BY recorded_at
                                         ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
        THEN produced_boxes
             - LAG(produced_boxes, 1, 0::bigint)
                 OVER (PARTITION BY machine_id, shift_number
                       ORDER BY recorded_at
                       ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
        ELSE produced_boxes
      END
    ) AS delta_boxes
  FROM raw
),

-- ── 3a. DAILY production: max cumulative per (day, machine, shift) ────────────
daily_max AS (
  SELECT
    TO_CHAR(DATE_TRUNC('day', recorded_at), 'YYYY-MM-DD') AS bucket,
    machine_id,
    shift_number,
    MAX(produced_boxes)::bigint AS tot_boxes,
    MAX(produced_swabs)::bigint AS tot_swabs
  FROM raw
  WHERE bucket_granularity = 'day'
  GROUP BY 1, machine_id, shift_number
),

daily_prod AS (
  SELECT bucket,
    SUM(tot_boxes) AS total_boxes,
    SUM(tot_swabs) AS total_swabs
  FROM daily_max
  GROUP BY bucket
),

-- ── 3b. HOURLY production: sum of deltas per (hour, machine, shift) ───────────
hourly_sum AS (
  SELECT
    TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24') AS bucket,
    machine_id,
    shift_number,
    SUM(delta_boxes) AS tot_boxes,
    SUM(delta_swabs) AS tot_swabs
  FROM deltas
  WHERE bucket_granularity = 'hour'
  GROUP BY 1, machine_id, shift_number
),

hourly_prod AS (
  SELECT bucket,
    SUM(tot_boxes) AS total_boxes,
    SUM(tot_swabs) AS total_swabs
  FROM hourly_sum
  GROUP BY bucket
),

-- ── 4. Efficiency / scrap / count aggregation (shared) ───────────────────────
agg AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
      ELSE             TO_CHAR(DATE_TRUNC('day',  recorded_at), 'YYYY-MM-DD')
    END                                                        AS bucket,
    ROUND(AVG(NULLIF(efficiency, 0))::numeric, 1)              AS avg_uptime,
    ROUND(AVG(reject_rate)::numeric,           1)              AS avg_scrap,
    COUNT(*)                                                   AS reading_count,
    COUNT(DISTINCT machine_id)                                 AS machine_count,
    COUNT(DISTINCT shift_number)                               AS shift_count
  FROM raw
  GROUP BY 1
),

-- ── 5. Combine daily/hourly production into one set ───────────────────────────
prod AS (
  SELECT bucket, total_boxes, total_swabs FROM daily_prod
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM hourly_prod
)

-- ── 6. Final join ─────────────────────────────────────────────────────────────
SELECT
  a.bucket,
  COALESCE(a.avg_uptime, 0)          AS avg_uptime,
  COALESCE(a.avg_scrap,  0)          AS avg_scrap,
  COALESCE(p.total_boxes, 0)::bigint AS total_boxes,
  COALESCE(p.total_swabs, 0)::bigint AS total_swabs,
  a.machine_count,
  a.reading_count,
  a.shift_count
FROM agg a
LEFT JOIN prod p USING (bucket)
ORDER BY a.bucket
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;
