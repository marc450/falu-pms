-- ============================================================
-- Migration 085: retrofit hourly aggregator + phantom check view
-- ============================================================
-- Two guardrails against the counter-reset trap that produced
-- the shift-boundary phantom standstills:
--
-- 1. aggregate_cell_hour (041) currently uses
--    GREATEST(0, MAX - anchor) for deltas. It works today only
--    because the anchor lookup is partitioned by shift_number —
--    so the cross-shift counter reset coincides with "anchor
--    not found", which falls through to anchor = 0. If anyone
--    ever changes the anchor scoping (as happened with 082 on
--    the 15-min bucket table), the same phantom returns at the
--    hour scale.
--
--    Replace with the three-branch CASE so the function is
--    correct regardless of partitioning.
--
-- 2. phantom_standstill_check view: surfaces buckets where the
--    machine sent readings but production_time_seconds = 0.
--    After 084 most of these correspond to real standstills.
--    A clustered spike around a specific UTC hour signals the
--    bug has returned.
--
-- See ~/.claude/projects/.../memory/project_counter_reset_handling.md
-- for the full rationale and the pattern that should never be
-- used again.
-- ============================================================


-- ── A. Retrofit aggregate_cell_hour with reset detection ────────────────────

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
  v_shift         integer;

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
  v_has_anchor    boolean;

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
    SELECT DISTINCT sr.machine_id, COALESCE(sr.machine_code, m.machine_code), sr.shift_number
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
      COUNT(*),
      MAX(sr.produced_swabs),
      MAX(sr.produced_boxes),
      MAX(sr.production_time),
      MAX(sr.idle_time),
      MAX(sr.error_time),
      MAX(sr.discarded_swabs),
      MAX(sr.cotton_tears),
      MAX(sr.missing_sticks),
      MAX(sr.faulty_pickups),
      MAX(sr.other_errors),
      AVG(NULLIF(sr.efficiency, 0)),
      AVG(sr.reject_rate)
    INTO
      v_rdg_count, v_max_swabs, v_max_boxes, v_max_prod_t, v_max_idle_t,
      v_max_error_t, v_max_discard, v_max_cotton, v_max_sticks, v_max_pickups,
      v_max_other, v_avg_eff, v_avg_scrap
    FROM shift_readings sr
    WHERE sr.machine_id   = v_machine_id
      AND sr.shift_number = v_shift
      AND sr.recorded_at  >= v_db_start
      AND sr.recorded_at  <  v_db_end
      AND (
            (sr.plc_timestamp >= v_plc_start AND sr.plc_timestamp < v_plc_end)
            OR sr.plc_timestamp IS NULL
          );

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    v_has_anchor := FALSE;

    SELECT
      _end_produced_swabs,
      _end_produced_boxes,
      _end_production_time_s,
      _end_idle_time_s,
      _end_error_time_s,
      _end_discarded_swabs,
      _end_cotton_tears,
      _end_missing_sticks,
      _end_faulty_pickups,
      _end_other_errors,
      TRUE
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t, v_anc_idle_t, v_anc_error_t,
      v_anc_discard, v_anc_cotton, v_anc_sticks, v_anc_pickups, v_anc_other,
      v_has_anchor
    FROM hourly_analytics
    WHERE machine_id   = v_machine_id
      AND shift_number = v_shift
      AND plc_hour     < v_plc_start
    ORDER BY plc_hour DESC
    LIMIT 1;

    IF NOT FOUND OR NOT v_has_anchor THEN
      -- No prior hour for this (machine, shift): treat as first hour.
      -- Set anchor = 0 so delta = current MAX (the new shift started at 0
      -- and accumulated to MAX). Memory: project_counter_reset_handling.md.
      v_anc_swabs   := 0;
      v_anc_boxes   := 0;
      v_anc_prod_t  := 0;
      v_anc_idle_t  := 0;
      v_anc_error_t := 0;
      v_anc_discard := 0;
      v_anc_cotton  := 0;
      v_anc_sticks  := 0;
      v_anc_pickups := 0;
      v_anc_other   := 0;
    END IF;

    -- Per-column reset detection. NEVER use GREATEST(0, MAX - anchor) for
    -- shift_readings cumulative counters — it masks resets and produces
    -- phantom zero-deltas. See project_counter_reset_handling.md.
    v_delta_swabs   := CASE
      WHEN COALESCE(v_max_swabs,   0) < v_anc_swabs   THEN COALESCE(v_max_swabs,   0)
      ELSE COALESCE(v_max_swabs,   0) - v_anc_swabs
    END;
    v_delta_boxes   := CASE
      WHEN COALESCE(v_max_boxes,   0) < v_anc_boxes   THEN COALESCE(v_max_boxes,   0)
      ELSE COALESCE(v_max_boxes,   0) - v_anc_boxes
    END;
    v_delta_prod_t  := CASE
      WHEN COALESCE(v_max_prod_t,  0) < v_anc_prod_t  THEN COALESCE(v_max_prod_t,  0)
      ELSE COALESCE(v_max_prod_t,  0) - v_anc_prod_t
    END;
    v_delta_idle_t  := CASE
      WHEN COALESCE(v_max_idle_t,  0) < v_anc_idle_t  THEN COALESCE(v_max_idle_t,  0)
      ELSE COALESCE(v_max_idle_t,  0) - v_anc_idle_t
    END;
    v_delta_error_t := CASE
      WHEN COALESCE(v_max_error_t, 0) < v_anc_error_t THEN COALESCE(v_max_error_t, 0)
      ELSE COALESCE(v_max_error_t, 0) - v_anc_error_t
    END;
    v_delta_discard := CASE
      WHEN COALESCE(v_max_discard, 0) < v_anc_discard THEN COALESCE(v_max_discard, 0)
      ELSE COALESCE(v_max_discard, 0) - v_anc_discard
    END;
    v_delta_cotton  := CASE
      WHEN COALESCE(v_max_cotton,  0) < v_anc_cotton  THEN COALESCE(v_max_cotton,  0)
      ELSE COALESCE(v_max_cotton,  0) - v_anc_cotton
    END;
    v_delta_sticks  := CASE
      WHEN COALESCE(v_max_sticks,  0) < v_anc_sticks  THEN COALESCE(v_max_sticks,  0)
      ELSE COALESCE(v_max_sticks,  0) - v_anc_sticks
    END;
    v_delta_pickups := CASE
      WHEN COALESCE(v_max_pickups, 0) < v_anc_pickups THEN COALESCE(v_max_pickups, 0)
      ELSE COALESCE(v_max_pickups, 0) - v_anc_pickups
    END;
    v_delta_other   := CASE
      WHEN COALESCE(v_max_other,   0) < v_anc_other   THEN COALESCE(v_max_other,   0)
      ELSE COALESCE(v_max_other,   0) - v_anc_other
    END;

    INSERT INTO hourly_analytics (
      machine_id,              machine_code,          cell_id,
      plc_hour,                shift_number,
      swabs_produced,          boxes_produced,
      production_time_seconds, idle_time_seconds,     error_time_seconds,
      discarded_swabs,         cotton_tears,          missing_sticks,
      faulty_pickups,          other_errors,
      reading_count,           avg_efficiency,        avg_scrap_rate,
      _end_produced_swabs,     _end_produced_boxes,
      _end_production_time_s,  _end_idle_time_s,      _end_error_time_s,
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
    ON CONFLICT (machine_id, plc_hour, shift_number) DO UPDATE SET
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
      _end_produced_swabs     = EXCLUDED._end_produced_swabs,
      _end_produced_boxes     = EXCLUDED._end_produced_boxes,
      _end_production_time_s  = EXCLUDED._end_production_time_s,
      _end_idle_time_s        = EXCLUDED._end_idle_time_s,
      _end_error_time_s       = EXCLUDED._end_error_time_s,
      _end_discarded_swabs    = EXCLUDED._end_discarded_swabs,
      _end_cotton_tears       = EXCLUDED._end_cotton_tears,
      _end_missing_sticks     = EXCLUDED._end_missing_sticks,
      _end_faulty_pickups     = EXCLUDED._end_faulty_pickups,
      _end_other_errors       = EXCLUDED._end_other_errors;

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


-- ── B. phantom_standstill_check view ────────────────────────────────────────
-- One row per 5-min bucket where the machine sent readings (so the PLC was
-- online) but the aggregator recorded zero production time. After 084 this
-- should mostly be: real errors, scheduled breaks, cleaning cycles. A
-- clustered spike at a particular UTC hour (especially 05:00 or 17:00 if
-- factory is CEST) signals the counter-reset bug is back.

CREATE OR REPLACE VIEW phantom_standstill_check AS
SELECT
  bucket_ts,
  machine_id,
  machine_code,
  reading_count,
  swabs_produced,
  CASE
    WHEN swabs_produced > 0
      THEN 'partial — readings show swabs but production_time = 0 (suspect)'
    ELSE 'no production at all — probably real standstill or scheduled break'
  END AS classification
FROM   bucket_analytics_5m
WHERE  reading_count            > 0
  AND  production_time_seconds  = 0
ORDER  BY bucket_ts DESC;

GRANT SELECT ON phantom_standstill_check TO anon, authenticated;


-- ── C. phantom_standstill_hourly_pattern view ───────────────────────────────
-- Aggregates the above by hour-of-day across the last 7 days. If two
-- specific hours dominate the distribution (one per shift end), the
-- counter-reset bug is back. If the distribution is roughly uniform,
-- those are real standstills.

CREATE OR REPLACE VIEW phantom_standstill_hourly_pattern AS
SELECT
  EXTRACT(HOUR FROM bucket_ts AT TIME ZONE 'UTC')::int  AS hour_utc,
  COUNT(*)                                              AS phantom_buckets,
  COUNT(DISTINCT machine_id)                            AS affected_machines
FROM   bucket_analytics_5m
WHERE  reading_count           > 0
  AND  production_time_seconds = 0
  AND  bucket_ts              >= now() - interval '7 days'
GROUP  BY 1
ORDER  BY phantom_buckets DESC;

GRANT SELECT ON phantom_standstill_hourly_pattern TO anon, authenticated;
