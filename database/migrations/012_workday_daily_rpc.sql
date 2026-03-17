-- Migration 012: Work-day bucketing for daily chart (supersedes 011 for daily path)
--
-- Problem: shift 2 runs 18:00–06:00, so its last 4 readings fall on the NEXT
-- calendar day.  DATE_TRUNC('day', recorded_at) therefore splits shift 2 across
-- two calendar days:
--   • Readings at 20:00 and 22:00 → attributed to day D
--   • Readings at 00:00, 02:00, 04:00, 06:00 → attributed to day D+1
-- Result: the first and last day of any queried range always appear short/red
-- because they only contain part of the night shift.
--
-- Fix: define the work-day as starting at 06:00, not midnight.
--   work_day(ts) = DATE_TRUNC('day', ts - interval '6 hours')
-- A reading at Mar 11 03:00 → work-day Mar 10. ✓
--
-- The raw window is also extended back 6 h (to range_start − 6 h) so that
-- overnight readings belonging to the first day in range are captured.
-- Anchor readings for the hourly spike fix are fetched from before
-- range_start − 6 h accordingly.

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

-- ── Extended raw window ────────────────────────────────────────────────────
-- For the daily path we extend back 6 h before range_start so that overnight
-- readings (00:00–05:59) that belong to the last shift of the previous
-- work-day are included and attributed correctly.
-- The in_range flag marks rows that are strictly within the original window;
-- those are the only rows that feed the hourly and efficiency aggregations.
raw AS (
  SELECT
    recorded_at,
    machine_id,
    shift_number,
    efficiency::double precision      AS efficiency,
    reject_rate::double precision     AS reject_rate,
    produced_boxes,
    produced_swabs,
    (recorded_at >= range_start)      AS in_range   -- FALSE for the 6 h extension
  FROM shift_readings
  WHERE recorded_at >= (range_start - interval '6 hours')
    AND recorded_at <= range_end
),

-- ── Anchor readings (hourly spike fix) ────────────────────────────────────
-- One row per (machine, shift): most recent reading before the extended window.
-- Gives the LAG a valid predecessor for the first in-range reading of each
-- shift session, preventing cumulative spikes on hourly charts.
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
  WHERE recorded_at < (range_start - interval '6 hours')
  ORDER BY machine_id, shift_number, recorded_at DESC
),

-- ── Combined: anchors + raw (for LAG window) ──────────────────────────────
combined AS (
  SELECT * FROM raw
  UNION ALL
  SELECT * FROM anchors
),

-- ── Delta computation (hourly path) ───────────────────────────────────────
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
        ELSE produced_swabs   -- cumulative reset: new shift session
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

-- ── Daily: max cumulative per (work-day, machine, shift) ──────────────────
-- work_day = DATE_TRUNC('day', recorded_at - 6 h)
-- A reading at 03:00 on day D+1 becomes work-day D, keeping both shifts of
-- each work-day fully attributed to the same bar.
-- Uses all raw rows (including the 6 h extension, in_range = TRUE or FALSE).
daily_max AS (
  SELECT
    TO_CHAR(
      DATE_TRUNC('day', recorded_at - interval '6 hours'),
      'YYYY-MM-DD'
    )                           AS bucket,
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

-- ── Hourly: sum of strictly in-range deltas per (hour, machine, shift) ────
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

-- ── Efficiency / scrap aggregation ────────────────────────────────────────
-- Daily: use work-day bucketing, same as daily_max, include 6 h extension.
-- Hourly: use strict in-range readings only.
agg AS (
  SELECT
    CASE bucket_granularity
      WHEN 'hour'
        THEN TO_CHAR(DATE_TRUNC('hour', recorded_at), 'YYYY-MM-DD"T"HH24')
      ELSE
        TO_CHAR(DATE_TRUNC('day', recorded_at - interval '6 hours'), 'YYYY-MM-DD')
    END                                                       AS bucket,
    ROUND(AVG(NULLIF(efficiency, 0))::numeric, 1)             AS avg_uptime,
    ROUND(AVG(reject_rate)::numeric,           1)             AS avg_scrap,
    COUNT(*)                                                  AS reading_count,
    COUNT(DISTINCT machine_id)                                AS machine_count,
    COUNT(DISTINCT shift_number)                              AS shift_count
  FROM raw
  WHERE bucket_granularity = 'hour' AND in_range = TRUE
     OR bucket_granularity = 'day'   -- include 6 h extension for daily agg
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
