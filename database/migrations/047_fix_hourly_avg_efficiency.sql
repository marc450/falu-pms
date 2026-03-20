-- ============================================================
-- Migration 047: fix avg_efficiency in aggregate_cell_hour
-- ============================================================
-- Previously used AVG(NULLIF(sr.efficiency, 0)) which excludes
-- zero-efficiency (idle) readings from the per-machine hourly
-- average.  Consistent with migrations 046 and the frontend
-- fix, idle machines must count as 0% — changed to AVG(sr.efficiency).
--
-- The hourly_analytics table already stores discarded_swabs and
-- swabs_produced as deltas, so scrap rate is already computed
-- correctly in the frontend as discarded / produced.  No column
-- change is needed for scrap.
-- ============================================================

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
      COUNT(*)                AS rdg_count,
      MAX(sr.produced_swabs)  AS max_swabs,
      MAX(sr.produced_boxes)  AS max_boxes,
      MAX(sr.production_time) AS max_prod_t,
      MAX(sr.idle_time)       AS max_idle_t,
      MAX(sr.error_time)      AS max_error_t,
      MAX(sr.discarded_swabs) AS max_discard,
      MAX(sr.cotton_tears)    AS max_cotton,
      MAX(sr.missing_sticks)  AS max_sticks,
      MAX(sr.faulty_pickups)  AS max_pickups,
      MAX(sr.other_errors)    AS max_other,
      -- Include idle readings (efficiency = 0) in the average.
      -- Previously NULLIF excluded zeros; now all readings count.
      AVG(sr.efficiency)      AS avg_eff,
      AVG(sr.reject_rate)     AS avg_scrap
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
      _end_other_errors
    INTO
      v_anc_swabs,  v_anc_boxes,   v_anc_prod_t,  v_anc_idle_t,  v_anc_error_t,
      v_anc_discard, v_anc_cotton, v_anc_sticks,  v_anc_pickups, v_anc_other
    FROM hourly_analytics
    WHERE machine_id   = v_machine_id
      AND shift_number = v_shift
      AND plc_hour     < v_plc_start
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
