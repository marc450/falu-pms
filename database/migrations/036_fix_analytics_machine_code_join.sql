-- Migration 036: fix machine_id mismatch between analytics_readings and saved_shift_logs
--
-- Root cause:
--   analytics_readings was populated when machines had different UUIDs (old
--   registrations).  saved_shift_logs was populated after re-registration.
--   Both tables share the same machine_code ("11563" etc.) but the UUIDs differ,
--   so any JOIN on machine_id returns no rows.
--
-- Fix part A: redo the minutes_running backfill joining by machine_code.
--   Migration 035 joined by machine_id and therefore updated 0 rows.
--
-- Fix part B: update get_machine_shift_summary to join the analytics_readings
--   subquery by machine_code instead of machine_id.

-- ── Part A: backfill minutes_running by machine_code ──────────────────────────

-- Rows where swabs were produced: estimate running time from machine speed.
-- CB machines (name or code starts with CB) = 2800 pcs/min
-- CT machines (name or code starts with CT) = 2300 pcs/min
UPDATE analytics_readings ar
SET minutes_running = ROUND(
  LEAST(
    5.0,
    ar.swabs_produced::numeric / CASE
      WHEN m.name        ILIKE 'CB%' THEN 2800.0
      WHEN m.name        ILIKE 'CT%' THEN 2300.0
      WHEN m.machine_code ILIKE 'CB%' THEN 2800.0
      WHEN m.machine_code ILIKE 'CT%' THEN 2300.0
      ELSE 2800.0
    END
  ),
  2
)
FROM machines m
WHERE m.machine_code = ar.machine_code   -- join by code, not by UUID
  AND ar.minutes_running IS NULL
  AND ar.swabs_produced > 0;

-- Buckets where the machine produced nothing: running time = 0
UPDATE analytics_readings
SET minutes_running = 0
WHERE minutes_running IS NULL;


-- ── Part B: fix get_machine_shift_summary ─────────────────────────────────────

CREATE OR REPLACE FUNCTION get_machine_shift_summary(
  p_range_start timestamptz,
  p_range_end   timestamptz
)
RETURNS TABLE (
  work_day       text,
  shift_label    text,
  machine_id     uuid,
  machine_code   text,
  run_hours      numeric,
  swabs_produced bigint,
  boxes_produced bigint,
  bu_normalized  numeric,
  avg_efficiency numeric,
  avg_scrap      numeric
)
LANGUAGE sql
STABLE
AS $$
WITH

config AS (
  SELECT
    COALESCE(MAX((value->>'shiftDurationHours')::int),  12) AS dur_hours,
    COALESCE(MAX((value->>'firstShiftStartHour')::int),  7) AS first_hour
  FROM app_settings
  WHERE key = 'shift_config'
),

ssl_data AS (
  SELECT
    TO_CHAR(
      DATE_TRUNC('day', sl.saved_at - (c.first_hour || ' hours')::interval),
      'YYYY-MM-DD'
    ) AS work_day,
    SUBSTR('ABCD',
      1 + LEAST(3, GREATEST(0,
        FLOOR(
          (((EXTRACT(HOUR FROM sl.saved_at)::int - c.first_hour + 24) % 24))::double precision
          / c.dur_hours::double precision
        )::int
      )),
      1
    ) AS shift_label,
    sl.machine_id,
    sl.machine_code,

    ROUND(
      COALESCE(
        -- Primary: sum analytics_readings.minutes_running over the shift window.
        -- Joined by machine_code (not machine_id) to handle UUID mismatches
        -- caused by machine re-registration.
        (
          SELECT SUM(ar.minutes_running)
          FROM analytics_readings ar
          WHERE ar.machine_code = sl.machine_code
            AND ar.bucket_start >= sl.saved_at - (c.dur_hours || ' hours')::interval
            AND ar.bucket_start <  sl.saved_at
        ) / 60.0,
        -- Fallback: PLC production_time counter.
        -- Correct for real hardware; may be low in the simulator when Railway
        -- restarts the process near a shift boundary.
        NULLIF(sl.production_time, 0)::numeric / 3600.0
      ),
      2
    ) AS run_hours,

    sl.produced_swabs                 AS swabs_produced,
    sl.produced_boxes                 AS boxes_produced,
    ROUND(sl.efficiency::numeric,  1) AS avg_efficiency,
    ROUND(sl.reject_rate::numeric, 2) AS avg_scrap
  FROM saved_shift_logs sl
  CROSS JOIN config c
  WHERE sl.saved_at >= (p_range_start - (c.first_hour || ' hours')::interval)
    AND sl.saved_at <= p_range_end
),

ssl_combined AS (
  SELECT
    work_day, shift_label, machine_id, machine_code,
    ROUND(AVG(run_hours),      2) AS run_hours,
    MAX(swabs_produced)           AS swabs_produced,
    MAX(boxes_produced)           AS boxes_produced,
    ROUND(AVG(avg_efficiency), 1) AS avg_efficiency,
    ROUND(AVG(avg_scrap),      2) AS avg_scrap
  FROM ssl_data
  GROUP BY work_day, shift_label, machine_id, machine_code
),

sr_sessions AS (
  SELECT
    TO_CHAR(
      DATE_TRUNC('day', sr.recorded_at - (c.first_hour || ' hours')::interval),
      'YYYY-MM-DD'
    ) AS work_day,
    SUBSTR('ABCD',
      1 + LEAST(3, GREATEST(0,
        FLOOR(
          (((EXTRACT(HOUR FROM sr.recorded_at)::int - c.first_hour + 24) % 24))::double precision
          / c.dur_hours::double precision
        )::int
      )),
      1
    ) AS shift_label,
    sr.machine_id,
    m.machine_code,
    sr.shift_number,
    ROUND(
      COALESCE(
        MAX(sr.production_time) FILTER (WHERE sr.save_flag),
        MAX(sr.production_time)
      )::numeric / 3600.0,
      2
    )                                                                           AS run_hours,
    MAX(sr.produced_swabs)                                                      AS swabs_produced,
    MAX(sr.produced_boxes)                                                      AS boxes_produced,
    ROUND(AVG(sr.efficiency)   FILTER (WHERE sr.efficiency   > 0)::numeric, 2) AS avg_efficiency,
    ROUND(AVG(sr.reject_rate)::numeric, 2)                                      AS avg_scrap
  FROM shift_readings sr
  JOIN machines m ON m.id = sr.machine_id
  CROSS JOIN config c
  WHERE sr.recorded_at >= (p_range_start - (c.first_hour || ' hours')::interval)
    AND sr.recorded_at <= p_range_end
  GROUP BY 1, 2, sr.machine_id, m.machine_code, sr.shift_number
),

sr_combined AS (
  SELECT
    work_day, shift_label, machine_id, machine_code,
    ROUND(SUM(run_hours), 2)      AS run_hours,
    SUM(swabs_produced)           AS swabs_produced,
    SUM(boxes_produced)           AS boxes_produced,
    ROUND(AVG(avg_efficiency), 1) AS avg_efficiency,
    ROUND(AVG(avg_scrap), 2)      AS avg_scrap
  FROM sr_sessions
  GROUP BY work_day, shift_label, machine_id, machine_code
),

all_sessions AS (
  SELECT * FROM ssl_combined
  UNION ALL
  SELECT r.* FROM sr_combined r
  WHERE NOT EXISTS (
    SELECT 1 FROM ssl_combined s
    WHERE s.work_day    = r.work_day
      AND s.shift_label = r.shift_label
      AND s.machine_id  = r.machine_id
  )
)

SELECT
  work_day,
  shift_label,
  machine_id,
  machine_code,
  run_hours,
  swabs_produced,
  boxes_produced,
  CASE WHEN run_hours > 0
    THEN ROUND((swabs_produced::numeric / 7200.0) / run_hours * 12.0, 1)
    ELSE NULL
  END AS bu_normalized,
  avg_efficiency,
  avg_scrap
FROM all_sessions, config c
WHERE work_day >= TO_CHAR(
    DATE_TRUNC('day', p_range_start - (c.first_hour || ' hours')::interval),
    'YYYY-MM-DD'
  )
  AND work_day <= TO_CHAR(DATE_TRUNC('day', p_range_end), 'YYYY-MM-DD')
ORDER BY work_day DESC, shift_label, machine_code
$$;

GRANT EXECUTE ON FUNCTION get_machine_shift_summary(timestamptz, timestamptz)
  TO anon, authenticated;
