-- ============================================================
-- Migration 082: fix bucket_analytics_15m anchor at shift changes
-- ============================================================
-- 081 keyed the per-bucket cumulative-counter anchor by
-- (machine_id, shift_crew). shift_crew rotates (crew "A" works
-- the 07:00-19:00 day shift, crew "B" the 19:00-07:00 night
-- shift, then they swap), so the anchor lookup at the start of
-- each shift returned that crew's _end value from 12-24h
-- earlier — while the PLC counter had grown continuously in
-- the meantime. Result: every shift change (07:00 and 19:00)
-- produced a spike in production_time_seconds / swabs_produced
-- of one full shift's worth of work crammed into one 15-min
-- bucket. Intraday uptime charts hit 300-500%, BU output
-- spiked to 10× normal.
--
-- The PLC counters are machine-level, not crew-level — they
-- don't reset at shift change. So the correct anchor is the
-- previous bucket for the same machine, regardless of crew.
-- This migration:
--   1. Collapses the unique key to (machine_id, bucket_ts) —
--      one row per machine per 15-min window. The shift_crew
--      column is kept as a label: the crew of the latest
--      reading in the window (= the incoming crew at a
--      handoff bucket).
--   2. Rewrites aggregate_cell_bucket to loop per machine
--      (not per (machine, crew)) and look up the anchor by
--      machine only.
--   3. Truncates the polluted backing table and re-runs the
--      48h backfill against the fixed logic.
-- get_fleet_trend_minute is unchanged — its read query SUMs
-- across rows in a bucket and is correct under the new shape.
-- ============================================================


-- ── A. Drop polluted data and replace unique constraint ─────────────────────
-- The 48h rolling window means there's no long-term loss; the
-- backfill at the end of this migration regenerates everything.

TRUNCATE TABLE bucket_analytics_15m;

ALTER TABLE bucket_analytics_15m
  DROP CONSTRAINT bucket_analytics_15m_machine_id_bucket_ts_shift_crew_key;

ALTER TABLE bucket_analytics_15m
  ADD CONSTRAINT bucket_analytics_15m_machine_id_bucket_ts_key
  UNIQUE (machine_id, bucket_ts);


-- ── B. Rewrite aggregate_cell_bucket ────────────────────────────────────────
-- Anchor is keyed by machine_id only. Crew is recorded as the
-- crew of the latest reading in the window (incoming crew).

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

  v_delta_swabs   bigint;
  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;
  v_delta_discard bigint;
BEGIN
  -- Loop per machine (not per (machine, crew)). One bucket row per machine.
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
    -- MAX of cumulative counters across ALL readings for this machine in
    -- the window, regardless of crew. The PLC counter is monotonic
    -- across shift boundaries.
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

    -- Crew label = crew of the latest reading in the window. At a shift
    -- handoff bucket this is the incoming crew (they own most of the
    -- 15-min window and all of the next ones).
    SELECT sr.shift_crew
      INTO v_label_crew
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end
      AND sr.shift_crew  IS NOT NULL
    ORDER BY sr.recorded_at DESC
    LIMIT 1;

    -- Anchor: most recent prior bucket for this machine, regardless of crew.
    SELECT
      _end_produced_swabs,
      _end_produced_boxes,
      _end_production_time_s,
      _end_discarded_swabs
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t, v_anc_discard
    FROM bucket_analytics_15m
    WHERE machine_id = v_machine_id
      AND bucket_ts  < p_bucket_start
    ORDER BY bucket_ts DESC
    LIMIT 1;

    v_anc_swabs   := COALESCE(v_anc_swabs,   0);
    v_anc_boxes   := COALESCE(v_anc_boxes,   0);
    v_anc_prod_t  := COALESCE(v_anc_prod_t,  0);
    v_anc_discard := COALESCE(v_anc_discard, 0);

    -- GREATEST(0,...) guards against PLC restarts that reset counters
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


-- ── C. Backfill the last 48h with the fixed logic ───────────────────────────

DO $$
DECLARE
  v_bucket   timestamptz;
  v_earliest timestamptz := date_bin(
    interval '15 minutes',
    now() - interval '48 hours',
    TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
  );
  v_latest   timestamptz := date_bin(
    interval '15 minutes',
    now(),
    TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
  ) - interval '15 minutes';
BEGIN
  FOR v_bucket IN
    SELECT generate_series(v_earliest, v_latest, interval '15 minutes')
  LOOP
    PERFORM aggregate_all_cells_for_bucket(v_bucket);
  END LOOP;
END $$;
