-- Migration 031: get_machine_shift_summary — use saved_shift_logs as primary source
--
-- Architecture change:
--
--   OLD (migrations 017-030):
--     PATH A  shift_readings       last 48 h (cumulative, delta math)
--     PATH B  analytics_readings   older data (5-min buckets from cron downsample)
--     Problem: analytics_readings requires pg_cron to be scheduled and running;
--              if the cron never ran the table is empty, so all date ranges
--              beyond 48 h return no rows.
--
--   NEW:
--     PATH A  saved_shift_logs     ALL completed shifts — definitive end-of-shift
--                                  totals sent by the simulator/PLC with Save=true.
--                                  No delta math, no downsampling, always accurate
--                                  regardless of bridge uptime during the shift.
--     PATH B  shift_readings       Current ONGOING shift only (no Save row yet).
--                                  Uses COALESCE(save_flag MAX, overall MAX) / 3600
--                                  as in migration 030, so a partial shift shows
--                                  the best available running-time estimate.
--
--   The UNION prefers saved_shift_logs; shift_readings fills in any (work_day,
--   shift_label, machine_id) combination not yet present in saved_shift_logs
--   (i.e. the shift still in progress).

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

-- ── Shift config ──────────────────────────────────────────────────────────────
config AS (
  SELECT
    COALESCE(MAX((value->>'shiftDurationHours')::int),  12) AS dur_hours,
    COALESCE(MAX((value->>'firstShiftStartHour')::int),  7) AS first_hour
  FROM app_settings
  WHERE key = 'shift_config'
),

-- ── PATH A: saved_shift_logs (completed shifts, authoritative) ────────────────
-- The simulator sends Save=true at shift end; the bridge writes a row here with
-- the final cumulative totals for that shift.  production_time is in seconds
-- and was reset to 0 at the start of this shift, so / 3600 gives exact run hours.
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
    ROUND(sl.production_time::numeric / 3600.0, 2)                AS run_hours,
    sl.produced_swabs                                              AS swabs_produced,
    sl.produced_boxes                                              AS boxes_produced,
    ROUND(sl.efficiency::numeric,  1)                              AS avg_efficiency,
    ROUND(sl.reject_rate::numeric, 2)                              AS avg_scrap
  FROM saved_shift_logs sl
  CROSS JOIN config c
  WHERE sl.saved_at >= (p_range_start - (c.first_hour || ' hours')::interval)
    AND sl.saved_at <= p_range_end
),

-- Collapse multiple rows for the same (work_day, shift_label, machine_id)
-- (edge case: simulator logged the same shift more than once after a restart)
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

-- ── PATH B: shift_readings (current ongoing shift only) ───────────────────────
-- Only consulted for (work_day, shift_label, machine_id) combinations NOT
-- already present in ssl_combined, i.e. the shift still in progress.
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

-- ── UNION: saved_shift_logs wins; shift_readings fills ongoing shifts ──────────
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
