-- Migration 027: get_machine_shift_summary — dynamic shift-label support
--
-- Previously the function hardcoded two shift labels:
--   A = 07:00–18:59   B = 19:00–06:59
-- This only works for 12-hour shifts starting at 07:00.
--
-- Fix: read shiftDurationHours (6 | 8 | 12) and firstShiftStartHour (0-23)
-- from app_settings and compute the slot index — then map to 'A'/'B'/'C'/'D'.
--
-- Formula for any reading at hour H with shift start at F and duration D:
--   slot_index = FLOOR( ((H - F + 24) % 24) / D )   → 0, 1, 2, 3
--   shift_label = SUBSTR('ABCD', slot_index + 1, 1)
--
-- The work-day boundary offset is also made dynamic (previously hardcoded 7h).

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

-- ── Read shift config (fallback to 12h starting at 07:00 if not set) ─────────
config AS (
  SELECT
    COALESCE(MAX((value->>'shiftDurationHours')::int),  12) AS dur_hours,
    COALESCE(MAX((value->>'firstShiftStartHour')::int),  7) AS first_hour
  FROM app_settings
  WHERE key = 'shift_config'
),

-- ── PATH A: shift_readings (last 48h, cumulative counters) ───────────────────
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
    ROUND(MAX(sr.production_time)::numeric / 60.0, 3)                          AS run_hours,
    MAX(sr.produced_swabs)                                                      AS swabs_produced,
    MAX(sr.produced_boxes)                                                      AS boxes_produced,
    ROUND(AVG(sr.efficiency)   FILTER (WHERE sr.efficiency   > 0)::numeric, 2) AS avg_efficiency,
    ROUND(AVG(sr.reject_rate)::numeric, 2)                                     AS avg_scrap
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
    ROUND(SUM(run_hours), 2)         AS run_hours,
    SUM(swabs_produced)              AS swabs_produced,
    SUM(boxes_produced)              AS boxes_produced,
    ROUND(AVG(avg_efficiency), 1)    AS avg_efficiency,
    ROUND(AVG(avg_scrap), 2)         AS avg_scrap
  FROM sr_sessions
  GROUP BY work_day, shift_label, machine_id, machine_code
),

-- ── PATH B: analytics_readings (>48h, already incremental) ──────────────────
ar_combined AS (
  SELECT
    TO_CHAR(
      DATE_TRUNC('day', ar.bucket_start - (c.first_hour || ' hours')::interval),
      'YYYY-MM-DD'
    ) AS work_day,
    SUBSTR('ABCD',
      1 + LEAST(3, GREATEST(0,
        FLOOR(
          (((EXTRACT(HOUR FROM ar.bucket_start)::int - c.first_hour + 24) % 24))::double precision
          / c.dur_hours::double precision
        )::int
      )),
      1
    ) AS shift_label,
    ar.machine_id,
    ar.machine_code,
    ROUND(SUM(ar.minutes_running)::numeric / 60.0, 2)                              AS run_hours,
    SUM(ar.swabs_produced)                                                          AS swabs_produced,
    SUM(ar.boxes_produced)                                                          AS boxes_produced,
    ROUND(AVG(ar.avg_efficiency) FILTER (WHERE ar.avg_efficiency > 0)::numeric, 1) AS avg_efficiency,
    ROUND(AVG(ar.avg_scrap_rate)::numeric, 2)                                      AS avg_scrap
  FROM analytics_readings ar
  CROSS JOIN config c
  WHERE ar.bucket_start >= (p_range_start - (c.first_hour || ' hours')::interval)
    AND ar.bucket_start <= p_range_end
  GROUP BY 1, 2, ar.machine_id, ar.machine_code
),

-- ── UNION: prefer sr_combined for recent data ────────────────────────────────
all_sessions AS (
  SELECT * FROM sr_combined
  UNION ALL
  SELECT a.* FROM ar_combined a
  WHERE NOT EXISTS (
    SELECT 1 FROM sr_combined s
    WHERE s.work_day    = a.work_day
      AND s.shift_label = a.shift_label
      AND s.machine_id  = a.machine_id
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
