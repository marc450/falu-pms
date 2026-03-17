-- Migration 011: Fix hourly BU spikes with anchor readings
--
-- Root cause of remaining hourly spikes (even after migration 010):
--   The LAG window only sees rows WITHIN the query range (range_start..range_end).
--   When a shift started BEFORE range_start, the first visible reading has no
--   LAG predecessor → the window function falls back to 0 → delta = full
--   cumulative value at that point → one huge spike bar.
--
-- Fix:
--   HOURLY  → Fetch one "anchor" reading per (machine, shift) from just before
--             range_start. Include it in the LAG computation (as a base row) but
--             exclude it from the final output (in_range = FALSE).
--             The first visible in-range reading now has a valid predecessor, so
--             the delta is correct (= production since the anchor timestamp).
--
--   DAILY   → Unchanged: MAX(cumulative) per (day, machine, shift) is correct
--             for cumulative data; no anchor needed.

CREATE OR REPLACE FUNCTION get_fleet_trend(
  range_start        timestamptz,
  range_end          timestamptz,
  bucket_granularity text           -- 'hour' or 'day'
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

-- ── In-range readings ──────────────────────────────────────────────────────
raw AS (
  SELECT
    recorded_at,
    machine_id,
    shift_number,
    efficiency::double precision      AS efficiency,
    reject_rate::double precision     AS reject_rate,
    produced_boxes,
    produced_swabs,
    TRUE AS in_range
  FROM shift_readings
  WHERE recorded_at >= range_start
    AND recorded_at <= range_end
),

-- ── Anchor readings ────────────────────────────────────────────────────────
-- One row per (machine, shift): the most recent reading BEFORE range_start.
-- Used only to prime the LAG; never included in output (in_range = FALSE).
anchors AS (
  SELECT DISTINCT ON (machine_id, shift_number)
    recorded_at,
    machine_id,
    shift_number,
    0::double precision AS efficiency,
    0::double precision AS reject_rate,
    produced_boxes,
    produced_swabs,
    FALSE AS in_range
  FROM shift_readings
  WHERE recorded_at < range_start
  ORDER BY machine_id, shift_number, recorded_at DESC
),

-- ── Combine: anchors first so LAG() sees them before in-range rows ─────────
combined AS (
  SELECT * FROM raw
  UNION ALL
  SELECT * FROM anchors
),

-- ── Delta computation (for hourly path) ───────────────────────────────────
-- LAG window spans the full combined set, partitioned by (machine, shift).
-- Cumulative reset detection: if produced_swabs decreased, the session
-- restarted; use the current value directly as the delta.
deltas AS (
  SELECT
    recorded_at,
    machine_id,
    shift_number,
    efficiency,
    reject_rate,
    in_range,
    GREATEST(0,
      CASE
        WHEN produced_swabs >= LAG(produced_swabs, 1, 0::bigint) OVER w
        THEN produced_swabs - LAG(produced_swabs, 1, 0::bigint) OVER w
        ELSE produced_swabs   -- reset: treat as first reading of new session
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

-- ── Daily: max cumulative per (day, machine, shift) ────────────────────────
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

-- ── Hourly: sum of in-range deltas per (hour, machine, shift) ─────────────
hourly_sum AS (
  SELECT
    TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24') AS bucket,
    machine_id,
    shift_number,
    SUM(delta_boxes) AS tot_boxes,
    SUM(delta_swabs) AS tot_swabs
  FROM deltas
  WHERE bucket_granularity = 'hour'
    AND in_range = TRUE
  GROUP BY 1, machine_id, shift_number
),

hourly_prod AS (
  SELECT bucket,
    SUM(tot_boxes) AS total_boxes,
    SUM(tot_swabs) AS total_swabs
  FROM hourly_sum
  GROUP BY bucket
),

-- ── Efficiency / scrap aggregation (in-range only) ────────────────────────
agg AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
      ELSE             TO_CHAR(DATE_TRUNC('day',  recorded_at), 'YYYY-MM-DD')
    END                                                       AS bucket,
    ROUND(AVG(NULLIF(efficiency, 0))::numeric, 1)             AS avg_uptime,
    ROUND(AVG(reject_rate)::numeric,           1)             AS avg_scrap,
    COUNT(*)                                                  AS reading_count,
    COUNT(DISTINCT machine_id)                                AS machine_count,
    COUNT(DISTINCT shift_number)                              AS shift_count
  FROM raw
  GROUP BY 1
),

prod AS (
  SELECT bucket, total_boxes, total_swabs FROM daily_prod
  UNION ALL
  SELECT bucket, total_boxes, total_swabs FROM hourly_prod
)

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
