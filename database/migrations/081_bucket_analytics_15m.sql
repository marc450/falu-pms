-- ============================================================
-- Migration 081: bucket_analytics_15m pre-aggregation
-- ============================================================
-- The 24h intraday chart reads via get_fleet_trend_minute (migration 079),
-- which aggregates shift_readings on the fly with date_bin + LAG. For a
-- fleet-wide 24h window that scans hundreds of thousands of rows and
-- trips the Supabase 8s statement timeout.
--
-- This migration introduces a 15-min pre-aggregated table populated by
-- pg_cron, exactly mirroring how 041 (hourly_analytics) accelerates the
-- hourly path. The intraday RPC is rewritten as a thin SUM over this
-- table — read cost drops from ~300k rows to ~1.7k for a fleet 24h view.
-- ============================================================


-- ── A. bucket_analytics_15m table ───────────────────────────────────────────
-- One row per (machine_id, bucket_ts, shift_crew).
-- Delta columns  : production WITHIN that 15-min window only.
-- _end_ columns  : end-of-bucket cumulative values used as anchors by the
--                  next cron run to compute the following bucket's deltas.

CREATE TABLE IF NOT EXISTS bucket_analytics_15m (
  id                      bigint           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id              uuid             NOT NULL REFERENCES machines(id),
  machine_code            text             NOT NULL,
  cell_id                 uuid             REFERENCES production_cells(id),
  bucket_ts               timestamptz      NOT NULL,
  shift_crew              text             NOT NULL,

  -- Deltas (production within this 15-min window only)
  swabs_produced          bigint           NOT NULL DEFAULT 0,
  boxes_produced          bigint           NOT NULL DEFAULT 0,
  production_time_seconds bigint           NOT NULL DEFAULT 0,
  discarded_swabs         bigint           NOT NULL DEFAULT 0,
  reading_count           integer          NOT NULL DEFAULT 0,

  -- End-of-bucket cumulative anchors (used by next cron run)
  _end_produced_swabs     bigint           NOT NULL DEFAULT 0,
  _end_produced_boxes     bigint           NOT NULL DEFAULT 0,
  _end_production_time_s  bigint           NOT NULL DEFAULT 0,
  _end_discarded_swabs    bigint           NOT NULL DEFAULT 0,

  created_at              timestamptz      NOT NULL DEFAULT now(),

  UNIQUE (machine_id, bucket_ts, shift_crew)
);

CREATE INDEX IF NOT EXISTS bucket_analytics_15m_bucket_idx
  ON bucket_analytics_15m (bucket_ts DESC);

CREATE INDEX IF NOT EXISTS bucket_analytics_15m_machine_bucket_idx
  ON bucket_analytics_15m (machine_id, bucket_ts DESC);


-- ── B. aggregate_cell_bucket(cell_id, bucket_start) ─────────────────────────
-- Processes all machines in one cell for one 15-min bucket and upserts
-- the result into bucket_analytics_15m. Idempotent via ON CONFLICT.

CREATE OR REPLACE FUNCTION aggregate_cell_bucket(
  p_cell_id      uuid,
  p_bucket_start timestamptz
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- Resolve sentinel back to NULL for machine JOIN (mirrors 041)
  v_real_cell_id  uuid        := CASE
                                   WHEN p_cell_id = '00000000-0000-0000-0000-000000000000'::uuid THEN NULL
                                   ELSE p_cell_id
                                 END;

  v_bucket_end    timestamptz := p_bucket_start + interval '15 minutes';
  -- ±2 min DB buffer catches readings that arrived slightly out of order
  v_db_start      timestamptz := p_bucket_start - interval '2 minutes';
  v_db_end        timestamptz := v_bucket_end   + interval '2 minutes';

  -- Loop variables
  v_machine_id    uuid;
  v_machine_code  text;
  v_crew          text;

  -- Aggregated cumulative counters for the current (machine, crew, bucket)
  v_max_swabs     bigint;
  v_max_boxes     bigint;
  v_max_prod_t    bigint;
  v_max_discard   bigint;
  v_rdg_count     integer;

  -- Anchor values from the previous bucket
  v_anc_swabs     bigint;
  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;
  v_anc_discard   bigint;

  -- Computed deltas
  v_delta_swabs   bigint;
  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;
  v_delta_discard bigint;
BEGIN
  -- Loop over every (machine, shift_crew) with readings in the window.
  FOR v_machine_id, v_machine_code, v_crew IN
    SELECT DISTINCT
      sr.machine_id,
      COALESCE(sr.machine_code, m.machine_code),
      sr.shift_crew
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
    -- Aggregate MAX cumulative counters and reading metadata
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
      AND sr.shift_crew  = v_crew
      AND sr.recorded_at >= v_db_start
      AND sr.recorded_at <  v_db_end;

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    -- Anchor: most recent bucket for this (machine, crew) before the target
    SELECT
      _end_produced_swabs,
      _end_produced_boxes,
      _end_production_time_s,
      _end_discarded_swabs
    INTO
      v_anc_swabs, v_anc_boxes, v_anc_prod_t, v_anc_discard
    FROM bucket_analytics_15m
    WHERE machine_id = v_machine_id
      AND shift_crew = v_crew
      AND bucket_ts  < p_bucket_start
    ORDER BY bucket_ts DESC
    LIMIT 1;

    v_anc_swabs   := COALESCE(v_anc_swabs,   0);
    v_anc_boxes   := COALESCE(v_anc_boxes,   0);
    v_anc_prod_t  := COALESCE(v_anc_prod_t,  0);
    v_anc_discard := COALESCE(v_anc_discard, 0);

    -- GREATEST(0,...) guards against PLC restarts that reset cumulative counters
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
      v_machine_id, v_machine_code, v_real_cell_id, p_bucket_start, v_crew,
      v_delta_swabs, v_delta_boxes, v_delta_prod_t, v_delta_discard,
      v_rdg_count,
      COALESCE(v_max_swabs,   0), COALESCE(v_max_boxes,   0),
      COALESCE(v_max_prod_t,  0), COALESCE(v_max_discard, 0)
    )
    ON CONFLICT (machine_id, bucket_ts, shift_crew) DO UPDATE SET
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


-- ── C. aggregate_all_cells_for_bucket(bucket_start) ─────────────────────────
-- Wrapper called by pg_cron. Iterates all production cells plus a final
-- pass for machines that are not assigned to any cell.

CREATE OR REPLACE FUNCTION aggregate_all_cells_for_bucket(p_bucket_start timestamptz)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_cell_id uuid;
BEGIN
  FOR v_cell_id IN
    SELECT id FROM production_cells
    WHERE id != '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY position
  LOOP
    PERFORM aggregate_cell_bucket(v_cell_id, p_bucket_start);
  END LOOP;

  -- Machines with no cell assigned (sentinel UUID)
  PERFORM aggregate_cell_bucket(
    '00000000-0000-0000-0000-000000000000'::uuid,
    p_bucket_start
  );
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_all_cells_for_bucket(timestamptz)
  TO anon, authenticated;


-- ── D. Replace get_fleet_trend_minute with a thin reader ────────────────────
-- Signature change: drops bucket_minutes (the table is fixed at 15 min).
-- Read path collapses to SUM/COUNT per bucket — no LAG, no date_bin.

DROP FUNCTION IF EXISTS get_fleet_trend_minute(timestamptz, timestamptz, int, uuid[]);

CREATE OR REPLACE FUNCTION get_fleet_trend_minute(
  range_start  timestamptz,
  range_end    timestamptz,
  machine_ids  uuid[] DEFAULT NULL
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
LANGUAGE sql
STABLE
AS $$
  SELECT
    to_char(bucket_ts, 'YYYY-MM-DD"T"HH24:MI')             AS bucket,
    CASE
      WHEN COUNT(DISTINCT machine_id) > 0 THEN
        round(
          (SUM(production_time_seconds)::numeric
            / (COUNT(DISTINCT machine_id) * 15 * 60)) * 100,
          1
        )
      ELSE 0
    END                                                    AS avg_uptime,
    CASE
      WHEN SUM(swabs_produced) > 0 THEN
        round((SUM(discarded_swabs)::numeric / SUM(swabs_produced)) * 100, 1)
      ELSE 0
    END                                                    AS avg_scrap,
    SUM(boxes_produced)::bigint                            AS total_boxes,
    SUM(swabs_produced)::bigint                            AS total_swabs,
    COUNT(DISTINCT machine_id)                             AS machine_count,
    SUM(reading_count)::bigint                             AS reading_count,
    COUNT(DISTINCT shift_crew)                             AS shift_count
  FROM bucket_analytics_15m
  WHERE bucket_ts >= range_start
    AND bucket_ts <  range_end
    AND (machine_ids IS NULL OR machine_id = ANY(machine_ids))
  GROUP BY bucket_ts
  ORDER BY bucket_ts;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend_minute(timestamptz, timestamptz, uuid[])
  TO anon, authenticated;


-- ── E. Backfill from shift_readings ─────────────────────────────────────────
-- shift_readings is retained for ~48h. Populate the new table for every
-- completed 15-min boundary in that window so the chart works immediately
-- after deploy. Buckets are processed in time order so the LAG anchors
-- chain correctly.

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


-- ── F. pg_cron jobs ─────────────────────────────────────────────────────────

-- Aggregate the just-completed 15-min bucket. Fires at :02, :17, :32, :47
-- so the bucket boundary (:00, :15, :30, :45) is already 2 min in the past,
-- giving late-arriving inserts time to land.
SELECT cron.schedule(
  'aggregate-bucket-15m',
  '2-59/15 * * * *',
  $cron$
    SELECT aggregate_all_cells_for_bucket(
      date_bin(
        interval '15 minutes',
        now() - interval '15 minutes',
        TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
      )
    )
  $cron$
);

-- Nightly cleanup: 48h rolling window (matches shift_readings retention).
SELECT cron.schedule(
  'cleanup-bucket-15m',
  '35 3 * * *',
  $cron$
    DELETE FROM bucket_analytics_15m WHERE bucket_ts < now() - interval '48 hours';
  $cron$
);


-- ── G. Row-level security ───────────────────────────────────────────────────
-- Supabase Data API grants per project convention (CLAUDE.md).

ALTER TABLE bucket_analytics_15m ENABLE ROW LEVEL SECURITY;

GRANT SELECT                         ON bucket_analytics_15m TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON bucket_analytics_15m TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON bucket_analytics_15m TO service_role;

DROP POLICY IF EXISTS bucket_analytics_15m_read ON bucket_analytics_15m;

CREATE POLICY bucket_analytics_15m_read
  ON bucket_analytics_15m FOR SELECT TO anon, authenticated USING (true);
