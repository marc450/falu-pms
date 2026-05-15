-- ============================================================
-- Migration 078: Group daily aggregation by factory-local working day
-- ============================================================
-- aggregate_daily_summary used `p_date::timestamptz` (UTC midnight) as the
-- filter bound, so a working day — day shift + the following night shift —
-- was split across two summary_date rows because the night shift's SAVE
-- (e.g. 07:00 Zurich = 05:00 UTC) lands on the next UTC date.
--
-- This migration redefines summary_date to be the factory-local date that
-- the shift STARTED on. A night shift running 19:00 May 14 -> 07:00 May 15
-- now lives under summary_date = 2026-05-14 together with the day shift
-- that ran 07:00 May 14 -> 19:00 May 14.
--
-- The cron schedule also moves to 12:00 UTC daily so all shifts of the
-- previous factory-local working day have settled, regardless of timezone,
-- and uses the factory timezone to compute "yesterday".
-- ============================================================

CREATE OR REPLACE FUNCTION aggregate_daily_summary(p_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_written integer := 0;
  v_tz           text;
  v_first_start  numeric;
  v_duration     numeric;
BEGIN
  -- Read factory timezone and shift config from app_settings.
  SELECT value #>> '{}' INTO v_tz FROM app_settings WHERE key = 'factory_timezone';
  IF v_tz IS NULL OR v_tz = '' THEN v_tz := 'Europe/Zurich'; END IF;

  SELECT
    COALESCE((value->>'firstShiftStartHour')::numeric, 7),
    COALESCE((value->>'shiftDurationHours')::numeric,  12)
  INTO v_first_start, v_duration
  FROM app_settings WHERE key = 'shift_config';
  IF v_first_start IS NULL THEN v_first_start := 7;  END IF;
  IF v_duration    IS NULL THEN v_duration    := 12; END IF;

  WITH ssl_data AS (
    SELECT
      -- (saved_at - 1 minute) in factory local time. The 1-minute step keeps
      -- boundary-saved rows attributed to the shift that just ended.
      ((sl.saved_at - interval '1 minute') AT TIME ZONE v_tz) AS local_t,
      sl.machine_id,
      COALESCE(sl.machine_code, m.machine_code) AS machine_code,
      m.cell_id,
      sl.production_time_seconds,
      sl.idle_time_seconds,
      COALESCE(sl.error_time_seconds, 0)        AS error_time_seconds,
      sl.produced_swabs,
      sl.produced_boxes,
      sl.discarded_swabs,
      sl.cotton_tears,
      sl.missing_sticks,
      sl.faulty_pickups,
      sl.other_errors,
      sl.efficiency,
      sl.scrap_rate
    FROM saved_shift_logs sl
    JOIN machines m ON m.id = sl.machine_id
    -- Widened to ±1 day so working_day = p_date can be matched even when
    -- the SAVE timestamp falls on the other side of a UTC midnight.
    WHERE sl.saved_at >= (p_date::timestamptz - interval '1 day')
      AND sl.saved_at <  ((p_date + 1)::timestamptz + interval '1 day')
  ),
  classified AS (
    SELECT
      -- Working day: shifts that started BEFORE midnight local (i.e. saved
      -- at a local hour < firstShiftStartHour) belong to the previous day.
      CASE
        WHEN (EXTRACT(HOUR FROM local_t) + EXTRACT(MINUTE FROM local_t) / 60.0) < v_first_start
        THEN (local_t::date - 1)
        ELSE  local_t::date
      END AS working_day,
      -- Shift label: slot 0 -> 'A', slot 1 -> 'B'.
      CASE
        WHEN FLOOR(
          MOD(
            (EXTRACT(HOUR FROM local_t) + EXTRACT(MINUTE FROM local_t) / 60.0
              - v_first_start + 24)::numeric,
            24
          ) / v_duration
        ) = 0 THEN 'A' ELSE 'B'
      END AS shift_label,
      machine_id, machine_code, cell_id,
      production_time_seconds, idle_time_seconds, error_time_seconds,
      produced_swabs, produced_boxes, discarded_swabs,
      cotton_tears, missing_sticks, faulty_pickups, other_errors,
      efficiency, scrap_rate
    FROM ssl_data
  ),
  combined AS (
    SELECT
      working_day                                                           AS summary_date,
      shift_label,
      machine_id,
      machine_code,
      cell_id,
      SUM(produced_swabs)::bigint                                           AS swabs_produced,
      SUM(produced_boxes)::bigint                                           AS boxes_produced,
      SUM(production_time_seconds)::bigint                                  AS production_time_seconds,
      SUM(idle_time_seconds)::bigint                                        AS idle_time_seconds,
      SUM(error_time_seconds)::bigint                                       AS error_time_seconds,
      SUM(discarded_swabs)::bigint                                          AS discarded_swabs,
      SUM(cotton_tears)::bigint                                             AS cotton_tears,
      SUM(missing_sticks)::bigint                                           AS missing_sticks,
      SUM(faulty_pickups)::bigint                                           AS faulty_pickups,
      SUM(other_errors)::bigint                                             AS other_errors,
      COUNT(*)::integer                                                     AS reading_count,
      ROUND((AVG(efficiency) FILTER (WHERE efficiency > 0))::numeric, 2)   AS avg_efficiency,
      ROUND(AVG(scrap_rate)::numeric, 2)                                   AS avg_scrap_rate
    FROM classified
    WHERE working_day = p_date
    GROUP BY working_day, shift_label, machine_id, machine_code, cell_id
  ),
  upserted AS (
    INSERT INTO daily_machine_summary (
      summary_date, shift_label, machine_id, machine_code, cell_id,
      swabs_produced, boxes_produced,
      production_time_seconds, idle_time_seconds, error_time_seconds,
      discarded_swabs, cotton_tears, missing_sticks, faulty_pickups, other_errors,
      reading_count, avg_efficiency, avg_scrap_rate,
      updated_at
    )
    SELECT
      summary_date, shift_label, machine_id, machine_code, cell_id,
      COALESCE(swabs_produced, 0), COALESCE(boxes_produced, 0),
      COALESCE(production_time_seconds, 0), COALESCE(idle_time_seconds, 0), COALESCE(error_time_seconds, 0),
      COALESCE(discarded_swabs, 0), COALESCE(cotton_tears, 0), COALESCE(missing_sticks, 0),
      COALESCE(faulty_pickups, 0), COALESCE(other_errors, 0),
      reading_count,
      COALESCE(avg_efficiency, 0), COALESCE(avg_scrap_rate, 0),
      now()
    FROM combined
    ON CONFLICT (summary_date, shift_label, machine_id) DO UPDATE SET
      machine_code            = EXCLUDED.machine_code,
      cell_id                 = EXCLUDED.cell_id,
      swabs_produced          = EXCLUDED.swabs_produced,
      boxes_produced          = EXCLUDED.boxes_produced,
      production_time_seconds = EXCLUDED.production_time_seconds,
      idle_time_seconds       = EXCLUDED.idle_time_seconds,
      error_time_seconds      = EXCLUDED.error_time_seconds,
      discarded_swabs         = EXCLUDED.discarded_swabs,
      cotton_tears            = EXCLUDED.cotton_tears,
      missing_sticks          = EXCLUDED.missing_sticks,
      faulty_pickups          = EXCLUDED.faulty_pickups,
      other_errors            = EXCLUDED.other_errors,
      reading_count           = EXCLUDED.reading_count,
      avg_efficiency          = EXCLUDED.avg_efficiency,
      avg_scrap_rate          = EXCLUDED.avg_scrap_rate,
      updated_at              = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_rows_written FROM upserted;

  -- Fleet-level rollup over the same working day.
  INSERT INTO daily_fleet_summary (
    summary_date, total_swabs, total_boxes,
    machine_count, shift_count, reading_count,
    avg_uptime, avg_scrap,
    total_discarded_swabs,
    updated_at
  )
  SELECT
    d.summary_date,
    SUM(d.swabs_produced)::bigint                                           AS total_swabs,
    SUM(d.boxes_produced)::bigint                                           AS total_boxes,
    COUNT(DISTINCT d.machine_id)::integer                                   AS machine_count,
    COUNT(DISTINCT d.shift_label)::integer                                  AS shift_count,
    SUM(d.reading_count)::bigint                                            AS reading_count,
    ROUND(
      (SUM(d.production_time_seconds)::double precision
       / NULLIF(COUNT(DISTINCT d.machine_id) * 86400.0, 0)
       * 100
      )::numeric, 1
    )::double precision                                                     AS avg_uptime,
    ROUND(
      (SUM(d.avg_scrap_rate * d.reading_count)
       / NULLIF(SUM(d.reading_count), 0)
      )::numeric, 1
    )::double precision                                                     AS avg_scrap,
    SUM(d.discarded_swabs)::bigint                                          AS total_discarded_swabs,
    now()
  FROM daily_machine_summary d
  WHERE d.summary_date = p_date
  GROUP BY d.summary_date
  ON CONFLICT (summary_date) DO UPDATE SET
    total_swabs           = EXCLUDED.total_swabs,
    total_boxes           = EXCLUDED.total_boxes,
    machine_count         = EXCLUDED.machine_count,
    shift_count           = EXCLUDED.shift_count,
    reading_count         = EXCLUDED.reading_count,
    avg_uptime            = EXCLUDED.avg_uptime,
    avg_scrap             = EXCLUDED.avg_scrap,
    total_discarded_swabs = EXCLUDED.total_discarded_swabs,
    updated_at            = now();

  RETURN v_rows_written;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_daily_summary(date)
  TO anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- Reschedule the daily aggregation. Run at 12:00 UTC so any factory
-- timezone's previous-day night shift has finished saving. Use the
-- factory timezone to compute "yesterday" rather than UTC.
-- ────────────────────────────────────────────────────────────

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'aggregate-daily-summary';

SELECT cron.schedule(
  'aggregate-daily-summary',
  '0 12 * * *',
  $cron$SELECT aggregate_daily_summary(
    ((now() AT TIME ZONE COALESCE(
      (SELECT value #>> '{}' FROM app_settings WHERE key = 'factory_timezone'),
      'Europe/Zurich'
    ))::date - 1)
  )$cron$
);


-- ────────────────────────────────────────────────────────────
-- Rebuild every daily_machine_summary / daily_fleet_summary row.
-- Old rows used UTC-date summary_date; new rows use factory-local
-- working_day, so a clean wipe avoids stale-key leftovers.
-- ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_date         date;
  v_tz           text;
  v_first_start  numeric;
BEGIN
  SELECT value #>> '{}' INTO v_tz FROM app_settings WHERE key = 'factory_timezone';
  IF v_tz IS NULL OR v_tz = '' THEN v_tz := 'Europe/Zurich'; END IF;

  SELECT COALESCE((value->>'firstShiftStartHour')::numeric, 7) INTO v_first_start
  FROM app_settings WHERE key = 'shift_config';
  IF v_first_start IS NULL THEN v_first_start := 7; END IF;

  TRUNCATE daily_fleet_summary;
  TRUNCATE daily_machine_summary;

  FOR v_date IN
    SELECT DISTINCT
      CASE
        WHEN (EXTRACT(HOUR FROM ((sl.saved_at - interval '1 minute') AT TIME ZONE v_tz))
              + EXTRACT(MINUTE FROM ((sl.saved_at - interval '1 minute') AT TIME ZONE v_tz)) / 60.0)
              < v_first_start
        THEN (((sl.saved_at - interval '1 minute') AT TIME ZONE v_tz)::date - 1)
        ELSE  ((sl.saved_at - interval '1 minute') AT TIME ZONE v_tz)::date
      END AS work_day
    FROM saved_shift_logs sl
    ORDER BY work_day
  LOOP
    PERFORM aggregate_daily_summary(v_date);
  END LOOP;
END $$;
