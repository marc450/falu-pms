-- ============================================================
-- Migration 066: Standardize terminology and unit suffixes
-- ============================================================
-- Bundles three cleanups that all require the same coordinated
-- bridge + frontend deploy:
--
--   A. Typo fix: machines.current_swaps -> current_swabs
--      (the product is swabs, everywhere else in the schema spells
--      it correctly; this was the only holdout.)
--
--   B. Terminology: "reject" -> "scrap" across all columns that
--      store the scrap-rate metric. The output side of every RPC
--      already uses avg_scrap* naming and the user-facing KPI is
--      "Avg Scrap Rate", so this aligns the inputs with the
--      existing outputs. The PLC payload field remains `Reject`
--      -- the bridge translates Reject -> scrap_rate on write.
--
--   C. Unit suffixes: every time column gets an explicit _seconds
--      suffix. Additionally, machines.idle_time_calc and
--      machines.error_time_calc are NORMALIZED from minutes to
--      seconds (UPDATE * 60) before the rename. The bridge used
--      to divide PLC seconds by 60 before writing; after this
--      migration it writes seconds directly, gaining back the
--      up-to-30s precision that rounding was dropping.
--
-- Column renames
-- --------------
--   machines.current_swaps              -> current_swabs
--   machines.current_reject             -> current_scrap_rate
--   machines.idle_time_calc (MIN -> S)  -> idle_time_seconds
--   machines.error_time_calc (MIN -> S) -> error_time_seconds
--   shift_readings.reject_rate          -> scrap_rate
--   shift_readings.production_time      -> production_time_seconds
--   shift_readings.idle_time            -> idle_time_seconds
--   shift_readings.error_time           -> error_time_seconds
--   saved_shift_logs.reject_rate        -> scrap_rate
--   saved_shift_logs.production_time    -> production_time_seconds
--   saved_shift_logs.idle_time          -> idle_time_seconds
--   saved_shift_logs.error_time         -> error_time_seconds
--   hourly_analytics._end_production_time_s -> end_production_time_seconds
--   hourly_analytics._end_idle_time_s       -> end_idle_time_seconds
--   hourly_analytics._end_error_time_s      -> end_error_time_seconds
--
-- RPCs dropped and recreated with new column names
-- ------------------------------------------------
--   aggregate_cell_hour        (from migration 061)
--   aggregate_daily_summary    (from migration 062)
--   get_machine_shift_summary  (from migration 063)
--   get_fleet_trend            (from migration 060)
--
-- Bodies are copied verbatim from those migrations and only the
-- renamed column references are substituted. No logic changes.
--
-- Required coordinated deploy
-- ---------------------------
-- After this migration runs, deploy in this order:
--   1. mqtt-bridge: writes new column names, stops dividing
--      IdleTime/ErrorTime by 60.
--   2. frontend: reads new column names; dashboard formatter
--      divides idle_time_seconds / error_time_seconds by 60 when
--      rendering the "X min" label so the displayed KPI value is
--      unchanged.
--
-- KPI impact
-- ----------
-- This migration does NOT change any KPI calculation logic.
-- Column renames are pure pass-throughs in all RPC bodies. The
-- minutes->seconds normalization on machines.idle_time_calc /
-- error_time_calc touches only live-display columns that no RPC
-- or analytics table reads; the frontend formatter is adjusted
-- so end-user values stay byte-identical.
--
-- Not idempotent: will fail if run twice (renamed columns no
-- longer exist). Wrap in a single transaction so either the whole
-- migration succeeds or none of it does.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- SECTION 1: Drop dependent functions
-- ────────────────────────────────────────────────────────────
-- These functions reference columns being renamed. Postgres does
-- NOT auto-update function bodies on column rename; the functions
-- would silently start failing at execution time. Drop them here
-- and recreate at the end of the migration.

DROP FUNCTION IF EXISTS aggregate_cell_hour(uuid, timestamptz);
DROP FUNCTION IF EXISTS aggregate_daily_summary(date);
DROP FUNCTION IF EXISTS get_machine_shift_summary(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS get_fleet_trend(timestamptz, timestamptz, text);


-- ────────────────────────────────────────────────────────────
-- SECTION 2: Normalize machines._calc columns to seconds
-- ────────────────────────────────────────────────────────────
-- These two columns store minutes (bridge divides PLC seconds by
-- 60 before writing). Multiply existing rows by 60 so they match
-- the PLC's native unit before the rename.

UPDATE machines
SET idle_time_calc  = idle_time_calc  * 60
WHERE idle_time_calc  IS NOT NULL;

UPDATE machines
SET error_time_calc = error_time_calc * 60
WHERE error_time_calc IS NOT NULL;


-- ────────────────────────────────────────────────────────────
-- SECTION 3: Rename columns
-- ────────────────────────────────────────────────────────────

-- machines
ALTER TABLE machines RENAME COLUMN current_swaps     TO current_swabs;
ALTER TABLE machines RENAME COLUMN current_reject    TO current_scrap_rate;
ALTER TABLE machines RENAME COLUMN idle_time_calc    TO idle_time_seconds;
ALTER TABLE machines RENAME COLUMN error_time_calc   TO error_time_seconds;

-- shift_readings
ALTER TABLE shift_readings RENAME COLUMN reject_rate     TO scrap_rate;
ALTER TABLE shift_readings RENAME COLUMN production_time TO production_time_seconds;
ALTER TABLE shift_readings RENAME COLUMN idle_time       TO idle_time_seconds;
ALTER TABLE shift_readings RENAME COLUMN error_time      TO error_time_seconds;

-- saved_shift_logs
ALTER TABLE saved_shift_logs RENAME COLUMN reject_rate     TO scrap_rate;
ALTER TABLE saved_shift_logs RENAME COLUMN production_time TO production_time_seconds;
ALTER TABLE saved_shift_logs RENAME COLUMN idle_time       TO idle_time_seconds;
ALTER TABLE saved_shift_logs RENAME COLUMN error_time      TO error_time_seconds;

-- hourly_analytics: drop leading underscore, spell out "seconds"
ALTER TABLE hourly_analytics RENAME COLUMN _end_production_time_s TO end_production_time_seconds;
ALTER TABLE hourly_analytics RENAME COLUMN _end_idle_time_s       TO end_idle_time_seconds;
ALTER TABLE hourly_analytics RENAME COLUMN _end_error_time_s      TO end_error_time_seconds;


-- ────────────────────────────────────────────────────────────
-- SECTION 4: Recreate aggregate_cell_hour (from migration 061)
-- Body verbatim, only renamed columns substituted.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aggregate_cell_hour(
  p_cell_id     uuid,
  p_target_hour timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_real_cell_id  uuid        := CASE
                                   WHEN p_cell_id = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
                                   ELSE p_cell_id
                                 END;

  v_plc_start     timestamptz := p_target_hour;
  v_plc_end       timestamptz := p_target_hour + interval '1 hour';
  v_db_start      timestamptz := p_target_hour - interval '12 minutes';
  v_db_end        timestamptz := p_target_hour + interval '1 hour 12 minutes';

  v_machine_id    uuid;
  v_machine_code  text;
  v_shift         text;

  v_max_swabs     bigint;
  v_max_boxes     bigint;
  v_max_prod_t    bigint;
  v_max_idle_t    bigint;
  v_max_error_t   bigint;
  v_max_discard   bigint;
  v_max_cotton    bigint;
  v_max_sticks    bigint;
  v_max_pickups   bigint;
  v_max_other     bigint;
  v_rdg_count     integer;
  v_avg_eff       double precision;
  v_avg_scrap     double precision;

  v_anc_swabs     bigint;
  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;
  v_anc_idle_t    bigint;
  v_anc_error_t   bigint;
  v_anc_discard   bigint;
  v_anc_cotton    bigint;
  v_anc_sticks    bigint;
  v_anc_pickups   bigint;
  v_anc_other     bigint;

  v_delta_swabs   bigint;
  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;
  v_delta_idle_t  bigint;
  v_delta_error_t bigint;
  v_delta_discard bigint;
  v_delta_cotton  bigint;
  v_delta_sticks  bigint;
  v_delta_pickups bigint;
  v_delta_other   bigint;

  v_rows_written  integer := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM cell_aggregation_log
    WHERE cell_id = p_cell_id AND plc_hour = p_target_hour
  ) THEN
    RETURN;
  END IF;

  FOR v_machine_id, v_machine_code, v_shift IN
    SELECT DISTINCT sr.machine_id, COALESCE(sr.machine_code, m.machine_code), sr.shift_crew
    FROM   shift_readings sr
    JOIN   machines       m  ON m.id = sr.machine_id
    WHERE
      (
        (v_real_cell_id IS NULL AND m.cell_id IS NULL)
        OR m.cell_id = v_real_cell_id
      )
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      AND (
            (sr.plc_timestamp >= v_plc_start AND sr.plc_timestamp < v_plc_end)
            OR sr.plc_timestamp IS NULL
          )
  LOOP
    SELECT
      COUNT(*)                         AS rdg_count,
      MAX(sr.produced_swabs)           AS max_swabs,
      MAX(sr.produced_boxes)           AS max_boxes,
      MAX(sr.production_time_seconds)  AS max_prod_t,
      MAX(sr.idle_time_seconds)        AS max_idle_t,
      MAX(sr.error_time_seconds)       AS max_error_t,
      MAX(sr.discarded_swabs)          AS max_discard,
      MAX(sr.cotton_tears)             AS max_cotton,
      MAX(sr.missing_sticks)           AS max_sticks,
      MAX(sr.faulty_pickups)           AS max_pickups,
      MAX(sr.other_errors)             AS max_other,
      AVG(sr.efficiency)               AS avg_eff,
      AVG(sr.scrap_rate)               AS avg_scrap
    INTO
      v_rdg_count, v_max_swabs, v_max_boxes, v_max_prod_t, v_max_idle_t,
      v_max_error_t, v_max_discard, v_max_cotton, v_max_sticks, v_max_pickups,
      v_max_other, v_avg_eff, v_avg_scrap
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.shift_crew  = v_shift
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      AND (
            (sr.plc_timestamp >= v_plc_start AND sr.plc_timestamp < v_plc_end)
            OR sr.plc_timestamp IS NULL
          );

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    -- Anchor lookup: most recent hourly_analytics row for this
    -- machine REGARDLESS of shift_crew (PLC counters span crews).
    SELECT
      _end_produced_swabs,
      _end_produced_boxes,
      end_production_time_seconds,
      end_idle_time_seconds,
      end_error_time_seconds,
      _end_discarded_swabs,
      _end_cotton_tears,
      _end_missing_sticks,
      _end_faulty_pickups,
      _end_other_errors
    INTO
      v_anc_swabs,  v_anc_boxes,   v_anc_prod_t,  v_anc_idle_t,  v_anc_error_t,
      v_anc_discard, v_anc_cotton, v_anc_sticks,  v_anc_pickups, v_anc_other
    FROM hourly_analytics
    WHERE machine_id  = v_machine_id
      AND plc_hour    < v_plc_start
    ORDER BY plc_hour DESC
    LIMIT 1;

    v_anc_swabs   := COALESCE(v_anc_swabs,   0);
    v_anc_boxes   := COALESCE(v_anc_boxes,   0);
    v_anc_prod_t  := COALESCE(v_anc_prod_t,  0);
    v_anc_idle_t  := COALESCE(v_anc_idle_t,  0);
    v_anc_error_t := COALESCE(v_anc_error_t, 0);
    v_anc_discard := COALESCE(v_anc_discard, 0);
    v_anc_cotton  := COALESCE(v_anc_cotton,  0);
    v_anc_sticks  := COALESCE(v_anc_sticks,  0);
    v_anc_pickups := COALESCE(v_anc_pickups, 0);
    v_anc_other   := COALESCE(v_anc_other,   0);

    v_delta_swabs   := GREATEST(0, COALESCE(v_max_swabs,   0) - v_anc_swabs);
    v_delta_boxes   := GREATEST(0, COALESCE(v_max_boxes,   0) - v_anc_boxes);
    v_delta_prod_t  := GREATEST(0, COALESCE(v_max_prod_t,  0) - v_anc_prod_t);
    v_delta_idle_t  := GREATEST(0, COALESCE(v_max_idle_t,  0) - v_anc_idle_t);
    v_delta_error_t := GREATEST(0, COALESCE(v_max_error_t, 0) - v_anc_error_t);
    v_delta_discard := GREATEST(0, COALESCE(v_max_discard, 0) - v_anc_discard);
    v_delta_cotton  := GREATEST(0, COALESCE(v_max_cotton,  0) - v_anc_cotton);
    v_delta_sticks  := GREATEST(0, COALESCE(v_max_sticks,  0) - v_anc_sticks);
    v_delta_pickups := GREATEST(0, COALESCE(v_max_pickups, 0) - v_anc_pickups);
    v_delta_other   := GREATEST(0, COALESCE(v_max_other,   0) - v_anc_other);

    INSERT INTO hourly_analytics (
      machine_id,              machine_code,          cell_id,
      plc_hour,                shift_crew,
      swabs_produced,          boxes_produced,
      production_time_seconds, idle_time_seconds,     error_time_seconds,
      discarded_swabs,         cotton_tears,          missing_sticks,
      faulty_pickups,          other_errors,
      reading_count,           avg_efficiency,        avg_scrap_rate,
      _end_produced_swabs,     _end_produced_boxes,
      end_production_time_seconds, end_idle_time_seconds, end_error_time_seconds,
      _end_discarded_swabs,    _end_cotton_tears,     _end_missing_sticks,
      _end_faulty_pickups,     _end_other_errors
    )
    VALUES (
      v_machine_id,             v_machine_code,        v_real_cell_id,
      v_plc_start,              v_shift,
      v_delta_swabs,            v_delta_boxes,
      v_delta_prod_t,           v_delta_idle_t,        v_delta_error_t,
      v_delta_discard,          v_delta_cotton,        v_delta_sticks,
      v_delta_pickups,          v_delta_other,
      v_rdg_count,
      COALESCE(v_avg_eff,   0), COALESCE(v_avg_scrap, 0),
      COALESCE(v_max_swabs,   0), COALESCE(v_max_boxes,   0),
      COALESCE(v_max_prod_t,  0), COALESCE(v_max_idle_t,  0), COALESCE(v_max_error_t, 0),
      COALESCE(v_max_discard, 0), COALESCE(v_max_cotton,  0), COALESCE(v_max_sticks,  0),
      COALESCE(v_max_pickups, 0), COALESCE(v_max_other,   0)
    )
    ON CONFLICT (machine_code, plc_hour, shift_crew) DO UPDATE SET
      swabs_produced              = EXCLUDED.swabs_produced,
      boxes_produced              = EXCLUDED.boxes_produced,
      production_time_seconds     = EXCLUDED.production_time_seconds,
      idle_time_seconds           = EXCLUDED.idle_time_seconds,
      error_time_seconds          = EXCLUDED.error_time_seconds,
      discarded_swabs             = EXCLUDED.discarded_swabs,
      cotton_tears                = EXCLUDED.cotton_tears,
      missing_sticks              = EXCLUDED.missing_sticks,
      faulty_pickups              = EXCLUDED.faulty_pickups,
      other_errors                = EXCLUDED.other_errors,
      reading_count               = EXCLUDED.reading_count,
      avg_efficiency              = EXCLUDED.avg_efficiency,
      avg_scrap_rate              = EXCLUDED.avg_scrap_rate,
      _end_produced_swabs         = EXCLUDED._end_produced_swabs,
      _end_produced_boxes         = EXCLUDED._end_produced_boxes,
      end_production_time_seconds = EXCLUDED.end_production_time_seconds,
      end_idle_time_seconds       = EXCLUDED.end_idle_time_seconds,
      end_error_time_seconds      = EXCLUDED.end_error_time_seconds,
      _end_discarded_swabs        = EXCLUDED._end_discarded_swabs,
      _end_cotton_tears           = EXCLUDED._end_cotton_tears,
      _end_missing_sticks         = EXCLUDED._end_missing_sticks,
      _end_faulty_pickups         = EXCLUDED._end_faulty_pickups,
      _end_other_errors           = EXCLUDED._end_other_errors;

    v_rows_written := v_rows_written + 1;
  END LOOP;

  INSERT INTO cell_aggregation_log (cell_id, plc_hour, row_count)
  VALUES (p_cell_id, p_target_hour, v_rows_written)
  ON CONFLICT (cell_id, plc_hour) DO UPDATE SET
    ran_at    = now(),
    row_count = EXCLUDED.row_count;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_cell_hour(uuid, timestamptz)
  TO anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- SECTION 5: Recreate aggregate_daily_summary (from migration 062)
-- Body verbatim, only renamed columns substituted.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION aggregate_daily_summary(p_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_written integer := 0;
BEGIN
  -- Step 1: upsert per-machine rows
  WITH ssl_data AS (
    SELECT
      p_date                        AS summary_date,
      CASE
        WHEN EXTRACT(HOUR FROM sl.saved_at) >= 7
         AND EXTRACT(HOUR FROM sl.saved_at) < 19
        THEN 'A' ELSE 'B'
      END                           AS shift_label,
      sl.machine_id,
      COALESCE(sl.machine_code, m.machine_code) AS machine_code,
      m.cell_id,
      sl.production_time_seconds,
      sl.idle_time_seconds,
      COALESCE(sl.error_time_seconds, 0)    AS error_time_seconds,
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
    WHERE sl.saved_at >= p_date::timestamptz
      AND sl.saved_at <  (p_date + 1)::timestamptz
  ),
  combined AS (
    SELECT
      summary_date,
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
    FROM ssl_data
    GROUP BY summary_date, shift_label, machine_id, machine_code, cell_id
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

  -- Step 2: upsert fleet-level totals.
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
-- SECTION 6: Recreate get_machine_shift_summary (from migration 063)
-- Body verbatim, only renamed columns substituted.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_machine_shift_summary(
  p_range_start timestamptz,
  p_range_end   timestamptz
)
RETURNS TABLE (
  work_day       text,
  shift_crew     text,
  machine_id     uuid,
  machine_code   text,
  run_hours      numeric,
  swabs_produced bigint,
  boxes_produced bigint,
  bu_normalized  numeric,
  avg_efficiency numeric,
  avg_scrap      numeric
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

  sr_sessions AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sr.recorded_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      sr.shift_crew,
      sr.machine_id,
      m.machine_code,
      ROUND(MAX(sr.production_time_seconds)::numeric / 60.0, 3) AS run_hours,
      MAX(sr.produced_swabs) AS swabs_produced,
      MAX(sr.produced_boxes) AS boxes_produced,
      ROUND(AVG(sr.efficiency) FILTER (WHERE sr.efficiency > 0)::numeric, 2) AS avg_efficiency,
      ROUND(AVG(sr.scrap_rate)::numeric, 2) AS avg_scrap
    FROM shift_readings sr
    JOIN machines m ON m.id = sr.machine_id
    WHERE sr.recorded_at >= (p_range_start - INTERVAL '7 hours')
      AND sr.recorded_at <= p_range_end
    GROUP BY 1, sr.shift_crew, sr.machine_id, m.machine_code
  ),

  sr_combined AS (
    SELECT
      s.work_day, s.shift_crew, s.machine_id, s.machine_code,
      ROUND(SUM(s.run_hours), 2) AS run_hours,
      SUM(s.swabs_produced) AS swabs_produced,
      SUM(s.boxes_produced) AS boxes_produced,
      ROUND(AVG(s.avg_efficiency), 1) AS avg_efficiency,
      ROUND(AVG(s.avg_scrap), 2) AS avg_scrap
    FROM sr_sessions s
    GROUP BY s.work_day, s.shift_crew, s.machine_id, s.machine_code
  ),

  ssl_combined AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (sl.saved_at AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD') AS work_day,
      COALESCE(sl.shift_crew, 'Unassigned') AS shift_crew,
      sl.machine_id,
      sl.machine_code,
      ROUND(SUM(sl.production_time_seconds)::numeric / 60.0, 2) AS run_hours,
      SUM(sl.produced_swabs)::bigint AS swabs_produced,
      SUM(sl.produced_boxes)::bigint AS boxes_produced,
      ROUND(AVG(sl.efficiency) FILTER (WHERE sl.efficiency > 0)::numeric, 1) AS avg_efficiency,
      ROUND(AVG(sl.scrap_rate)::numeric, 2) AS avg_scrap
    FROM saved_shift_logs sl
    WHERE sl.saved_at >= (p_range_start - INTERVAL '7 hours')
      AND sl.saved_at <= p_range_end
    GROUP BY 1, sl.shift_crew, sl.machine_id, sl.machine_code
  ),

  all_sessions AS (
    SELECT * FROM sr_combined
    UNION ALL
    SELECT a.* FROM ssl_combined a
    WHERE NOT EXISTS (
      SELECT 1 FROM sr_combined s
      WHERE s.work_day    = a.work_day
        AND s.shift_crew  = a.shift_crew
        AND s.machine_id  = a.machine_id
    )
  )

  SELECT
    a.work_day,
    a.shift_crew,
    a.machine_id,
    a.machine_code,
    a.run_hours,
    a.swabs_produced,
    a.boxes_produced,
    CASE WHEN a.run_hours > 0
      THEN ROUND((a.swabs_produced::numeric / 7200.0) / a.run_hours * 12.0, 1)
      ELSE NULL
    END AS bu_normalized,
    a.avg_efficiency,
    a.avg_scrap
  FROM all_sessions a
  WHERE a.work_day >= TO_CHAR(DATE_TRUNC('day', (p_range_start AT TIME ZONE tz) - INTERVAL '7 hours'), 'YYYY-MM-DD')
    AND a.work_day <= TO_CHAR(DATE_TRUNC('day', (p_range_end AT TIME ZONE tz)), 'YYYY-MM-DD')
  ORDER BY a.work_day DESC, a.shift_crew, a.machine_code;
END;
$$;

GRANT EXECUTE ON FUNCTION get_machine_shift_summary(timestamptz, timestamptz)
  TO anon, authenticated;


-- ────────────────────────────────────────────────────────────
-- SECTION 7: Recreate get_fleet_trend (from migration 060)
-- Body verbatim, only renamed columns substituted. The local
-- alias `reject_rate` inside the CTE is renamed to `scrap_rate`
-- for consistency.
-- ────────────────────────────────────────────────────────────

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
      shift_crew,
      efficiency::double precision  AS efficiency,
      scrap_rate::double precision  AS scrap_rate,
      produced_boxes,
      produced_swabs,
      (recorded_at >= range_start)  AS in_range
    FROM shift_readings
    WHERE recorded_at >= (range_start - interval '7 hours')
      AND recorded_at <= range_end
  ),

  anchors AS (
    SELECT DISTINCT ON (machine_id, shift_crew)
      recorded_at, machine_id, shift_crew,
      0::double precision AS efficiency,
      0::double precision AS scrap_rate,
      produced_boxes, produced_swabs,
      FALSE AS in_range
    FROM shift_readings
    WHERE recorded_at < (range_start - interval '7 hours')
    ORDER BY machine_id, shift_crew, recorded_at DESC
  ),

  combined AS (
    SELECT * FROM raw
    UNION ALL
    SELECT * FROM anchors
  ),

  deltas AS (
    SELECT
      recorded_at, machine_id, shift_crew, efficiency, scrap_rate, in_range,
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
      PARTITION BY machine_id, shift_crew
      ORDER BY recorded_at
      ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
    )
  ),

  sr_daily_max AS (
    SELECT
      TO_CHAR(DATE_TRUNC('day', (recorded_at AT TIME ZONE tz) - interval '7 hours'), 'YYYY-MM-DD') AS bucket,
      machine_id, shift_crew,
      MAX(produced_boxes)::bigint AS tot_boxes,
      MAX(produced_swabs)::bigint AS tot_swabs
    FROM raw
    WHERE bucket_granularity = 'day'
    GROUP BY 1, machine_id, shift_crew
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
      ROUND(AVG(scrap_rate)::numeric,            1)      AS avg_scrap,
      COUNT(*)                                           AS reading_count,
      COUNT(DISTINCT machine_id)                         AS machine_count,
      COUNT(DISTINCT shift_crew)                         AS shift_count
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
      ROUND(AVG(sl.scrap_rate)::numeric, 1)              AS avg_scrap,
      COUNT(*)::bigint                                   AS reading_count,
      COUNT(DISTINCT sl.machine_id)::bigint              AS machine_count,
      COUNT(DISTINCT sl.shift_crew)::bigint              AS shift_count
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


COMMIT;
