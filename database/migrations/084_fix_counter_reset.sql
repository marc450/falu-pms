-- ============================================================
-- Migration 084: detect counter resets at shift change
-- ============================================================
-- aggregate_cell_bucket computes per-bucket deltas as
-- GREATEST(0, MAX(cumulative) - anchor_from_previous_bucket).
-- When the PLC's per-shift counter resets at shift end (which
-- the simulator does in createShiftData(), and the real PLC
-- does per Marc), the new shift's MAX is suddenly smaller than
-- the previous bucket's _end value. The GREATEST clamps the
-- delta to 0 for the first two buckets after every shift
-- change — producing a spurious 10-minute "standstill" on the
-- chart at 07:00 and 19:00 local time (05:00/17:00 UTC),
-- every day, on every machine.
--
-- Fix: per-column reset detection. If the current bucket's
-- MAX is below the anchor, treat it as a fresh counter (delta
-- = current MAX) instead of clamping to 0. Each column resets
-- independently so we don't conflate a swabs reset with a
-- production_time reset.
--
-- Schema/cron/table all stay the same. Function body only.
-- Companion 084b TRUNCATEs the table and re-runs the set-based
-- 48h backfill against the fixed math so the chart heals
-- immediately.
-- ============================================================

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
  v_db_start      timestamptz := p_bucket_start - interval '1 minute';
  v_db_end        timestamptz := v_bucket_end   + interval '1 minute';

  v_machine_id    uuid;
  v_machine_code  text;
  v_label_crew    text;

  v_max_swabs     bigint;
  v_max_boxes     bigint;
  v_max_prod_t    bigint;
  v_max_discard   bigint;
  v_rdg_count     integer;

  v_anc_swabs     bigint;
  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;
  v_anc_discard   bigint;

  v_delta_swabs   bigint;
  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;
  v_delta_discard bigint;
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
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      AND sr.shift_crew  IS NOT NULL
  LOOP
    SELECT
      COUNT(*),
      MAX(sr.produced_swabs),
      MAX(sr.produced_boxes),
      MAX(sr.production_time_seconds),
      MAX(sr.discarded_swabs)
    INTO
      v_rdg_count, v_max_swabs, v_max_boxes, v_max_prod_t, v_max_discard
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      AND sr.shift_crew  IS NOT NULL;

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    SELECT sr.shift_crew
      INTO v_label_crew
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      AND sr.shift_crew  IS NOT NULL
    ORDER BY sr.recorded_at DESC
    LIMIT 1;

    SELECT
      _end_produced_swabs,
      _end_produced_boxes,
      _end_production_time_s,
      _end_discarded_swabs
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t, v_anc_discard
    FROM bucket_analytics_5m
    WHERE machine_id = v_machine_id
      AND bucket_ts  < p_bucket_start
    ORDER BY bucket_ts DESC
    LIMIT 1;

    IF NOT FOUND THEN
      -- No prior bucket: set anchor = current MAX so delta = 0.
      v_anc_swabs   := COALESCE(v_max_swabs,   0);
      v_anc_boxes   := COALESCE(v_max_boxes,   0);
      v_anc_prod_t  := COALESCE(v_max_prod_t,  0);
      v_anc_discard := COALESCE(v_max_discard, 0);
    END IF;

    -- Per-column reset detection: when the current MAX is below the anchor,
    -- the cumulative counter must have reset (shift end, PLC restart, etc).
    -- Treat the current MAX as the new cumulative — i.e. delta = MAX, not
    -- MAX - anchor. Done per column because counters can reset independently.
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
    v_delta_discard := CASE
      WHEN COALESCE(v_max_discard, 0) < v_anc_discard THEN COALESCE(v_max_discard, 0)
      ELSE COALESCE(v_max_discard, 0) - v_anc_discard
    END;

    INSERT INTO bucket_analytics_5m (
      machine_id, machine_code, cell_id, bucket_ts, shift_crew,
      swabs_produced, boxes_produced, production_time_seconds, discarded_swabs,
      reading_count,
      _end_produced_swabs, _end_produced_boxes,
      _end_production_time_s, _end_discarded_swabs
    )
    VALUES (
      v_machine_id, v_machine_code, v_real_cell_id, p_bucket_start, v_label_crew,
      v_delta_swabs, v_delta_boxes, v_delta_prod_t, v_delta_discard,
      v_rdg_count,
      COALESCE(v_max_swabs,   0), COALESCE(v_max_boxes,   0),
      COALESCE(v_max_prod_t,  0), COALESCE(v_max_discard, 0)
    )
    ON CONFLICT (machine_id, bucket_ts) DO UPDATE SET
      shift_crew              = EXCLUDED.shift_crew,
      swabs_produced          = EXCLUDED.swabs_produced,
      boxes_produced          = EXCLUDED.boxes_produced,
      production_time_seconds = EXCLUDED.production_time_seconds,
      discarded_swabs         = EXCLUDED.discarded_swabs,
      reading_count           = EXCLUDED.reading_count,
      _end_produced_swabs     = EXCLUDED._end_produced_swabs,
      _end_produced_boxes     = EXCLUDED._end_produced_boxes,
      _end_production_time_s  = EXCLUDED._end_production_time_s,
      _end_discarded_swabs    = EXCLUDED._end_discarded_swabs;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_cell_bucket(uuid, timestamptz)
  TO anon, authenticated;


-- Clear the polluted 48h window. 084b re-populates it with the fixed math.
TRUNCATE TABLE bucket_analytics_5m;
