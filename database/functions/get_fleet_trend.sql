-- ============================================================================
-- FUNCTION: get_fleet_trend
-- Current version: migration 012 (workday bucketing + hourly anchor fix)
-- ============================================================================
--
-- Arguments:
--   range_start        timestamptz  — start of the query window
--   range_end          timestamptz  — end of the query window
--   bucket_granularity text         — 'hour' or 'day'
--
-- Returns one row per time bucket with:
--   bucket        — ISO string  ('YYYY-MM-DD' for day, 'YYYY-MM-DDTHH24' for hour)
--   avg_uptime    — fleet average machine uptime % (0–100)
--   avg_scrap     — fleet average scrap/reject rate %
--   total_boxes   — total boxes produced (fleet, all machines)
--   total_swabs   — total swabs produced (fleet, all machines)
--   machine_count — number of distinct machines with data in this bucket
--   reading_count — raw reading rows in this bucket
--   shift_count   — number of distinct shifts active in this bucket
--
-- Design notes:
--   shift_readings stores CUMULATIVE swab/box counts per machine per shift.
--
--   HOURLY path:  uses LAG() to compute per-reading deltas (incremental
--                 production).  An "anchor" reading from just before the
--                 query window is fetched for each (machine, shift) so the
--                 first visible reading has a valid LAG predecessor and does
--                 not spike to the full cumulative value.
--
--   DAILY path:   uses MAX(cumulative) per (work-day, machine, shift).
--                 Work-day starts at 06:00, so readings between 00:00–05:59
--                 are attributed to the PREVIOUS calendar day (they belong
--                 to the night shift that started at 18:00 the day before).
--                 The raw window is extended back 6 h before range_start to
--                 capture these overnight readings for the first day shown.
-- ============================================================================

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

raw AS (
  SELECT
    recorded_at,
    machine_id,
    shift_number,
    efficiency::double precision      AS efficiency,
    reject_rate::double precision     AS reject_rate,
    produced_boxes,
    produced_swabs,
    (recorded_at >= range_start)      AS in_range
  FROM shift_readings
  WHERE recorded_at >= (range_start - interval '6 hours')
    AND recorded_at <= range_end
),

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

combined AS (
  SELECT * FROM raw
  UNION ALL
  SELECT * FROM anchors
),

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
     OR bucket_granularity = 'day'
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
