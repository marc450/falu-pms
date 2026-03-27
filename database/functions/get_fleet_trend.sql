-- ============================================================================
-- FUNCTION: get_fleet_trend
-- Current version: migration 054 (factory timezone support)
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
--   HOURLY path:  uses LAG() to compute per-reading deltas.  An anchor
--                 reading from just before the query window is fetched for
--                 each (machine, shift) so the first visible reading has a
--                 valid LAG predecessor and does not spike.
--
--   DAILY path:   uses MAX(cumulative) per (work-day, machine, shift).
--                 Work-day starts at configured first_hour (default 07:00).
--
--   TWO-SOURCE UNION:
--                 shift_readings     — last 48 h, cumulative, needs delta/LAG
--                 saved_shift_logs   — historical, clean per-shift PLC totals
--
--   Factory timezone is read from app_settings.factory_timezone.
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
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  tz text;
BEGIN
  SELECT value #>> '{}' INTO tz FROM app_settings WHERE key = 'factory_timezone';
  IF tz IS NULL THEN tz := 'Europe/Zurich'; END IF;

  RETURN QUERY
  WITH

  config AS (
    SELECT
      COALESCE(MAX((value->>'firstShiftStartHour')::int),  7) AS first_hour,
      COALESCE(MAX((value->>'shiftDurationHours')::int),  12) AS dur_hours
    FROM app_settings
    WHERE key = 'shift_config'
  ),

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

  sr_daily_max AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (recorded_at AT TIME ZONE tz) - interval '7 hours'), 'YYYY-MM-DD') AS bucket,
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

  sr_hourly AS (
    SELECT
      TO_CHAR(DATE_TRUNC('hour', recorded_at AT TIME ZONE tz), 'YYYY-MM-DD"T"HH24') AS bucket,
      SUM(delta_boxes) AS total_boxes,
      SUM(delta_swabs) AS total_swabs
    FROM deltas
    WHERE bucket_granularity = 'hour' AND in_range = TRUE
    GROUP BY 1
  ),

  ssl_daily AS (
    SELECT
      TO_CHAR(
        DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - (c.first_hour || ' hours')::interval),
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

  prod AS (
    SELECT bucket, total_boxes, total_swabs FROM sr_daily
    UNION ALL
    SELECT bucket, total_boxes, total_swabs FROM sr_hourly
    UNION ALL
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

  sr_agg AS (
    SELECT
      CASE bucket_granularity
        WHEN 'hour' THEN TO_CHAR(DATE_TRUNC('hour', recorded_at AT TIME ZONE tz), 'YYYY-MM-DD"T"HH24')
        ELSE             TO_CHAR(DATE_TRUNC('day',  (recorded_at AT TIME ZONE tz) - interval '7 hours'), 'YYYY-MM-DD')
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

  ssl_agg AS (
    SELECT
      TO_CHAR(
        DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - (c.first_hour || ' hours')::interval),
        'YYYY-MM-DD'
      ) AS bucket,
      ROUND(AVG(NULLIF(sl.efficiency, 0))::numeric, 1)   AS avg_uptime,
      ROUND(AVG(sl.reject_rate)::numeric, 1)             AS avg_scrap,
      COUNT(*)::bigint                                   AS reading_count,
      COUNT(DISTINCT sl.machine_id)::bigint              AS machine_count,
      COUNT(DISTINCT
        SUBSTR('ABCD',
          1 + LEAST(3, GREATEST(0,
            FLOOR(
              (((EXTRACT(HOUR FROM sl.saved_at AT TIME ZONE tz)::int - c.first_hour + 24) % 24))::double precision
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
  ORDER BY a.bucket;
END;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend(timestamptz, timestamptz, text)
  TO anon, authenticated;
