-- ============================================================
-- Migration 096c: index + index-friendly PLC-time window
-- ============================================================
-- 096's window predicate used CASE(plc_timestamp/recorded_at), which
-- no index can satisfy, so per-machine MAX/MIN went sequential and the
-- 48h backfill hit statement_timeout. Fix:
--   1. composite index (machine_id, plc_timestamp) for the per-machine
--      MAX/MIN range scan that timed out.
--   2. window by a PLAIN plc_timestamp range. The bucket bounds are
--      2026 dates, so the range itself excludes NULL and pre-2020
--      sentinel clocks — no CASE needed, and the predicate is sargable.
--
-- Readings with NULL/sentinel plc_timestamp are simply not bucketed
-- (the simulator always sets a valid Timestamp; real PLCs only emit
-- sentinels on error, which should not drive analytics anyway).
--
-- Run BEFORE re-running 096b. KPI windowing clock unchanged from 096
-- (still PLC publish time) — this only makes it fast. Marc-approved.
-- ============================================================


-- ── A. composite index for the per-machine range scan ───────────────────────
CREATE INDEX IF NOT EXISTS shift_readings_machine_plc_idx
  ON shift_readings (machine_id, plc_timestamp);


-- ── B. aggregate_cell_bucket: plain (sargable) plc_timestamp window ─────────
CREATE OR REPLACE FUNCTION aggregate_cell_bucket(
  p_cell_id      uuid,
  p_bucket_start timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_real_cell_id  uuid        := CASE
                                   WHEN p_cell_id = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
                                   ELSE p_cell_id
                                 END;

  v_bucket_end    timestamptz := p_bucket_start + interval '5 minutes';
  v_db_start      timestamptz := p_bucket_start;
  v_db_end        timestamptz := v_bucket_end;

  v_machine_id    uuid;
  v_machine_code  text;
  v_label_crew    text;

  v_max_swabs     bigint;  v_min_swabs     bigint;
  v_max_boxes     bigint;  v_min_boxes     bigint;
  v_max_prod_t    bigint;  v_min_prod_t    bigint;
  v_max_idle_t    bigint;  v_min_idle_t    bigint;
  v_max_error_t   bigint;  v_min_error_t   bigint;
  v_max_discard   bigint;  v_min_discard   bigint;

  v_rdg_count     integer;

  v_anc_swabs     bigint;  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;  v_anc_idle_t    bigint;
  v_anc_error_t   bigint;  v_anc_discard   bigint;

  v_delta_swabs   bigint;  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;  v_delta_idle_t  bigint;
  v_delta_error_t bigint;  v_delta_discard bigint;
BEGIN
  FOR v_machine_id, v_machine_code IN
    SELECT DISTINCT
      sr.machine_id,
      COALESCE(sr.machine_code, m.machine_code)
    FROM   shift_readings sr
    JOIN   machines       m  ON m.id = sr.machine_id
    WHERE
      (
        (v_real_cell_id IS NULL AND m.cell_id IS NULL)
        OR m.cell_id = v_real_cell_id
      )
      AND sr.plc_timestamp >= v_db_start
      AND sr.plc_timestamp <  v_db_end
      AND sr.shift_crew  IS NOT NULL
  LOOP
    SELECT
      COUNT(*),
      MAX(sr.produced_swabs),           MIN(sr.produced_swabs),
      MAX(sr.produced_boxes),           MIN(sr.produced_boxes),
      MAX(sr.production_time_seconds),  MIN(sr.production_time_seconds),
      MAX(sr.idle_time_seconds),        MIN(sr.idle_time_seconds),
      MAX(sr.error_time_seconds),       MIN(sr.error_time_seconds),
      MAX(sr.discarded_swabs),          MIN(sr.discarded_swabs)
    INTO
      v_rdg_count,
      v_max_swabs,   v_min_swabs,
      v_max_boxes,   v_min_boxes,
      v_max_prod_t,  v_min_prod_t,
      v_max_idle_t,  v_min_idle_t,
      v_max_error_t, v_min_error_t,
      v_max_discard, v_min_discard
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.plc_timestamp >= v_db_start
      AND sr.plc_timestamp <  v_db_end
      AND sr.shift_crew  IS NOT NULL;

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    SELECT sr.shift_crew
      INTO v_label_crew
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.plc_timestamp >= v_db_start
      AND sr.plc_timestamp <  v_db_end
      AND sr.shift_crew  IS NOT NULL
    ORDER BY sr.plc_timestamp DESC
    LIMIT 1;

    SELECT
      _end_produced_swabs,    _end_produced_boxes,
      _end_production_time_s, _end_idle_time_s,
      _end_error_time_s,      _end_discarded_swabs
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t,
      v_anc_idle_t, v_anc_error_t, v_anc_discard
    FROM bucket_analytics_5m
    WHERE machine_id = v_machine_id
      AND bucket_ts  < p_bucket_start
    ORDER BY bucket_ts DESC
    LIMIT 1;

    IF NOT FOUND THEN
      v_anc_swabs   := COALESCE(v_max_swabs,   0);
      v_anc_boxes   := COALESCE(v_max_boxes,   0);
      v_anc_prod_t  := COALESCE(v_max_prod_t,  0);
      v_anc_idle_t  := COALESCE(v_max_idle_t,  0);
      v_anc_error_t := COALESCE(v_max_error_t, 0);
      v_anc_discard := COALESCE(v_max_discard, 0);
    END IF;

    v_delta_swabs   := CASE WHEN COALESCE(v_max_swabs,   0) < v_anc_swabs   THEN COALESCE(v_max_swabs,   0) - COALESCE(v_min_swabs,   0) ELSE COALESCE(v_max_swabs,   0) - v_anc_swabs   END;
    v_delta_boxes   := CASE WHEN COALESCE(v_max_boxes,   0) < v_anc_boxes   THEN COALESCE(v_max_boxes,   0) - COALESCE(v_min_boxes,   0) ELSE COALESCE(v_max_boxes,   0) - v_anc_boxes   END;
    v_delta_prod_t  := CASE WHEN COALESCE(v_max_prod_t,  0) < v_anc_prod_t  THEN COALESCE(v_max_prod_t,  0) - COALESCE(v_min_prod_t,  0) ELSE COALESCE(v_max_prod_t,  0) - v_anc_prod_t  END;
    v_delta_idle_t  := CASE WHEN COALESCE(v_max_idle_t,  0) < v_anc_idle_t  THEN COALESCE(v_max_idle_t,  0) - COALESCE(v_min_idle_t,  0) ELSE COALESCE(v_max_idle_t,  0) - v_anc_idle_t  END;
    v_delta_error_t := CASE WHEN COALESCE(v_max_error_t, 0) < v_anc_error_t THEN COALESCE(v_max_error_t, 0) - COALESCE(v_min_error_t, 0) ELSE COALESCE(v_max_error_t, 0) - v_anc_error_t END;
    v_delta_discard := CASE WHEN COALESCE(v_max_discard, 0) < v_anc_discard THEN COALESCE(v_max_discard, 0) - COALESCE(v_min_discard, 0) ELSE COALESCE(v_max_discard, 0) - v_anc_discard END;

    INSERT INTO bucket_analytics_5m (
      machine_id, machine_code, cell_id, bucket_ts, shift_crew,
      swabs_produced, boxes_produced,
      production_time_seconds, idle_time_seconds, error_time_seconds,
      discarded_swabs, reading_count,
      _end_produced_swabs, _end_produced_boxes,
      _end_production_time_s, _end_idle_time_s, _end_error_time_s,
      _end_discarded_swabs
    )
    VALUES (
      v_machine_id, v_machine_code, v_real_cell_id, p_bucket_start, v_label_crew,
      v_delta_swabs, v_delta_boxes,
      v_delta_prod_t, v_delta_idle_t, v_delta_error_t,
      v_delta_discard, v_rdg_count,
      COALESCE(v_max_swabs,   0), COALESCE(v_max_boxes,   0),
      COALESCE(v_max_prod_t,  0), COALESCE(v_max_idle_t,  0), COALESCE(v_max_error_t, 0),
      COALESCE(v_max_discard, 0)
    )
    ON CONFLICT (machine_id, bucket_ts) DO UPDATE SET
      shift_crew              = EXCLUDED.shift_crew,
      swabs_produced          = EXCLUDED.swabs_produced,
      boxes_produced          = EXCLUDED.boxes_produced,
      production_time_seconds = EXCLUDED.production_time_seconds,
      idle_time_seconds       = EXCLUDED.idle_time_seconds,
      error_time_seconds      = EXCLUDED.error_time_seconds,
      discarded_swabs         = EXCLUDED.discarded_swabs,
      reading_count           = EXCLUDED.reading_count,
      _end_produced_swabs     = EXCLUDED._end_produced_swabs,
      _end_produced_boxes     = EXCLUDED._end_produced_boxes,
      _end_production_time_s  = EXCLUDED._end_production_time_s,
      _end_idle_time_s        = EXCLUDED._end_idle_time_s,
      _end_error_time_s       = EXCLUDED._end_error_time_s,
      _end_discarded_swabs    = EXCLUDED._end_discarded_swabs;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_cell_bucket(uuid, timestamptz)
  TO anon, authenticated;
