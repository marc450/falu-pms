-- ============================================================
-- Migration 082: fix bucket_analytics_15m anchor at shift changes
-- ============================================================
-- 081 keyed the per-bucket cumulative-counter anchor by
-- (machine_id, shift_crew). shift_crew rotates (crew "A" works
-- 07:00-19:00, crew "B" 19:00-07:00, then they swap), so the
-- anchor lookup at the start of each shift returned that crew's
-- _end value from 12-24h earlier — while the PLC counter had
-- grown continuously in the meantime. Result: every shift change
-- (07:00 and 19:00) produced a spike of one full shift's worth
-- of work crammed into one 15-min bucket. Intraday uptime hit
-- 300-500%, BU output spiked to 10× normal.
--
-- The PLC counters are machine-level, not crew-level — they
-- don't reset at shift change. So the correct anchor is the
-- previous bucket for the same machine, regardless of crew.
--
-- This migration: schema + function fix only, no backfill.
-- The optional 48h backfill is in 082b — it does too much work
-- per HTTP request for the Supabase SQL editor to run in one
-- shot, so it's split into chunks the user runs separately.
-- After 082 runs, the cron job (every 15 min) starts producing
-- correct rows. The chart self-heals over ~24h, or run 082b
-- for an immediate fix.
-- ============================================================


-- ── A. Drop polluted data and replace unique constraint ─────────────────────
-- 48h rolling table, so no long-term data is lost. The new function
-- writes one row per (machine, bucket); the previous one wrote one
-- per (machine, bucket, crew), and some shift-transition buckets had
-- two rows — they would violate the new constraint, so we wipe first.

TRUNCATE TABLE bucket_analytics_15m;

ALTER TABLE bucket_analytics_15m
  DROP CONSTRAINT IF EXISTS bucket_analytics_15m_machine_id_bucket_ts_shift_crew_key;

ALTER TABLE bucket_analytics_15m
  DROP CONSTRAINT IF EXISTS bucket_analytics_15m_machine_id_bucket_ts_key;

ALTER TABLE bucket_analytics_15m
  ADD CONSTRAINT bucket_analytics_15m_machine_id_bucket_ts_key
  UNIQUE (machine_id, bucket_ts);


-- ── B. Rewrite aggregate_cell_bucket ────────────────────────────────────────
-- - Loop per machine (not per (machine, crew)). One row per (machine, bucket).
-- - Anchor lookup by machine_id only — matches the machine-level nature of
--   the PLC counter.
-- - Crew label = crew of the latest reading in the window (incoming crew at
--   a handoff bucket).
-- - No anchor → anchor := current MAX, so delta = 0 for the first bucket of
--   a machine. Prevents the "first bucket post-deploy is a spike" failure
--   mode that the old function had (anchor=0 → delta=full lifetime counter).

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

  v_bucket_end    timestamptz := p_bucket_start + interval '15 minutes';
  v_db_start      timestamptz := p_bucket_start - interval '2 minutes';
  v_db_end        timestamptz := v_bucket_end   + interval '2 minutes';

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
  v_has_anchor    boolean;

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
      _end_discarded_swabs,
      TRUE
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t, v_anc_discard, v_has_anchor
    FROM bucket_analytics_15m
    WHERE machine_id = v_machine_id
      AND bucket_ts  < p_bucket_start
    ORDER BY bucket_ts DESC
    LIMIT 1;

    IF NOT FOUND THEN
      -- No prior bucket for this machine: treat current MAX as the anchor
      -- so delta = 0. The bucket still records _end_* values, so the next
      -- bucket has a real anchor and produces a correct delta.
      v_anc_swabs   := COALESCE(v_max_swabs,   0);
      v_anc_boxes   := COALESCE(v_max_boxes,   0);
      v_anc_prod_t  := COALESCE(v_max_prod_t,  0);
      v_anc_discard := COALESCE(v_max_discard, 0);
    END IF;

    v_delta_swabs   := GREATEST(0, COALESCE(v_max_swabs,   0) - v_anc_swabs);
    v_delta_boxes   := GREATEST(0, COALESCE(v_max_boxes,   0) - v_anc_boxes);
    v_delta_prod_t  := GREATEST(0, COALESCE(v_max_prod_t,  0) - v_anc_prod_t);
    v_delta_discard := GREATEST(0, COALESCE(v_max_discard, 0) - v_anc_discard);

    INSERT INTO bucket_analytics_15m (
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
