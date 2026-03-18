-- Migration 030: get_machine_shift_summary — fix run_hours for bridge-gap scenarios
--
-- Root cause (migration 029 introduced a regression):
--   The simulator resets production_time to 0 at each shift boundary.
--   migration 029 used (MAX − MIN) / 3600.  When the MQTT bridge was offline
--   for most of a shift and reconnected only near the end, the captured readings
--   all have production_time values close to the final total (e.g. 32 000 – 32 360 s).
--   MAX − MIN = 360 s / 3600 = 0.1 h — grossly wrong.
--
-- Fix:
--   1. If a save_flag = true row exists for the shift (sent by the simulator at
--      shift end), its production_time IS the definitive cumulative running time.
--      Use that value directly / 3600.
--   2. Otherwise (ongoing shift, or bridge missed the save message) fall back to
--      MAX(production_time) / 3600.  Since the simulator resets at shift start,
--      MAX = highest captured value = best available approximation.
--
-- This is correct for simulator data (resets per shift).  Real PLCs that never
-- reset production_time would require the delta approach; a separate migration
-- can address that if real hardware is connected later.

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
    -- Use the save-flag row's production_time when available (it is the
    -- definitive cumulative running-time value the simulator emits at shift end).
    -- Fall back to MAX overall for ongoing shifts or when the bridge missed
    -- the save message.  Both are divided by 3600 to convert seconds to hours.
    -- (No MAX-MIN delta: the simulator resets production_time to 0 each shift,
    --  so MIN is always near 0 and the delta equals MAX anyway -- but the delta
    --  breaks whenever the bridge reconnects mid-shift and only captures the tail.)
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
