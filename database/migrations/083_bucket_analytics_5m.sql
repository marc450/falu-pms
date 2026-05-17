-- ============================================================
-- Migration 083: rewrite bucket_analytics_15m as 5-min buckets
-- ============================================================
-- The 24h intraday chart aggregates over 15-min windows. That's
-- coarse enough that short events disappear: a 30-second
-- standstill is ~0.5% of a 15-min bucket, the line stays
-- visually flat. Switching to 5-min buckets makes short
-- standstills and short error events visible while still
-- aggregating ~5 readings per bucket per machine (PLC sends
-- every ~1 min), so deltas stay statistically meaningful.
--
-- Drop the 15m table/functions/crons and replace with their
-- 5m equivalents. Schema is identical except for the table
-- name; uptime denominator drops from (machines × 900) to
-- (machines × 300) to match the new bucket length. Read RPC
-- signature is unchanged, so the frontend works as-is (apart
-- from one constant flipped 15 → 5 in supabase.ts).
--
-- Anchor logic (per 082) and "no anchor → delta = 0" (per
-- 082) are preserved.
-- ============================================================


-- ── A. Tear down the 15m infrastructure ─────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aggregate-bucket-15m') THEN
    PERFORM cron.unschedule('aggregate-bucket-15m');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-bucket-15m') THEN
    PERFORM cron.unschedule('cleanup-bucket-15m');
  END IF;
END $$;

DROP FUNCTION IF EXISTS aggregate_all_cells_for_bucket(timestamptz);
DROP FUNCTION IF EXISTS aggregate_cell_bucket(uuid, timestamptz);
DROP FUNCTION IF EXISTS get_fleet_trend_minute(timestamptz, timestamptz, uuid[]);
DROP TABLE IF EXISTS bucket_analytics_15m;


-- ── B. bucket_analytics_5m table ────────────────────────────────────────────

CREATE TABLE bucket_analytics_5m (
  id                      bigint           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  machine_id              uuid             NOT NULL REFERENCES machines(id),
  machine_code            text             NOT NULL,
  cell_id                 uuid             REFERENCES production_cells(id),
  bucket_ts               timestamptz      NOT NULL,
  shift_crew              text             NOT NULL,

  -- Deltas (production within this 5-min window only)
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

  CONSTRAINT bucket_analytics_5m_machine_id_bucket_ts_key
    UNIQUE (machine_id, bucket_ts)
);

CREATE INDEX bucket_analytics_5m_bucket_idx
  ON bucket_analytics_5m (bucket_ts DESC);

CREATE INDEX bucket_analytics_5m_machine_bucket_idx
  ON bucket_analytics_5m (machine_id, bucket_ts DESC);


-- ── C. aggregate_cell_bucket(cell_id, bucket_start) ─────────────────────────
-- Per-cell procedural aggregator used by the cron job to fill the bucket
-- that just closed. One row per (machine, bucket). Anchor by machine only
-- (082). No anchor → use current MAX so first bucket has delta = 0 (082).

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
  -- ±1 min DB buffer catches readings that arrived slightly out of order.
  -- Tighter than the 15m version (±2 min) because the bucket itself is
  -- smaller; wider buffers would overlap too aggressively.
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
      v_anc_swabs   := COALESCE(v_max_swabs,   0);
      v_anc_boxes   := COALESCE(v_max_boxes,   0);
      v_anc_prod_t  := COALESCE(v_max_prod_t,  0);
      v_anc_discard := COALESCE(v_max_discard, 0);
    END IF;

    v_delta_swabs   := GREATEST(0, COALESCE(v_max_swabs,   0) - v_anc_swabs);
    v_delta_boxes   := GREATEST(0, COALESCE(v_max_boxes,   0) - v_anc_boxes);
    v_delta_prod_t  := GREATEST(0, COALESCE(v_max_prod_t,  0) - v_anc_prod_t);
    v_delta_discard := GREATEST(0, COALESCE(v_max_discard, 0) - v_anc_discard);

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


-- ── D. aggregate_all_cells_for_bucket(bucket_start) ─────────────────────────

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

  PERFORM aggregate_cell_bucket(
    '00000000-0000-0000-0000-000000000000'::uuid,
    p_bucket_start
  );
END;
$$;

GRANT EXECUTE ON FUNCTION aggregate_all_cells_for_bucket(timestamptz)
  TO anon, authenticated;


-- ── E. Read RPC ─────────────────────────────────────────────────────────────
-- Same signature and column shape as the 15m version. Uptime denominator
-- adjusts from 15*60=900 to 5*60=300 seconds per bucket.

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
            / (COUNT(DISTINCT machine_id) * 5 * 60)) * 100,
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
  FROM bucket_analytics_5m
  WHERE bucket_ts >= range_start
    AND bucket_ts <  range_end
    AND (machine_ids IS NULL OR machine_id = ANY(machine_ids))
  GROUP BY bucket_ts
  ORDER BY bucket_ts;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend_minute(timestamptz, timestamptz, uuid[])
  TO anon, authenticated;


-- ── F. Set-based backfill ───────────────────────────────────────────────────
-- 48h × 12 buckets/h = 576 buckets per machine. One INSERT, completes in
-- seconds. Same shape as 082b but with 5-min bins.

INSERT INTO bucket_analytics_5m (
  machine_id, machine_code, cell_id, bucket_ts, shift_crew,
  swabs_produced, boxes_produced, production_time_seconds, discarded_swabs,
  reading_count,
  _end_produced_swabs, _end_produced_boxes,
  _end_production_time_s, _end_discarded_swabs
)
WITH bucketed AS (
  SELECT
    sr.machine_id,
    COALESCE(sr.machine_code, m.machine_code)                                    AS machine_code,
    m.cell_id                                                                    AS cell_id,
    date_bin(
      interval '5 minutes',
      sr.recorded_at,
      TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
    )                                                                            AS bucket_ts,
    sr.recorded_at,
    sr.shift_crew,
    sr.produced_swabs,
    sr.produced_boxes,
    sr.production_time_seconds,
    sr.discarded_swabs
  FROM shift_readings sr
  JOIN machines        m  ON m.id = sr.machine_id
  WHERE sr.recorded_at >= now() - interval '48 hours'
    AND sr.recorded_at <  date_bin(
                            interval '5 minutes',
                            now(),
                            TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
                          )
    AND sr.shift_crew IS NOT NULL
),
agg AS (
  SELECT
    machine_id,
    bucket_ts,
    MAX(machine_code)                                              AS machine_code,
    MAX(cell_id::text)::uuid                                       AS cell_id,
    COUNT(*)::int                                                  AS reading_count,
    MAX(produced_swabs)                                            AS max_swabs,
    MAX(produced_boxes)                                            AS max_boxes,
    MAX(production_time_seconds)                                   AS max_prod_t,
    MAX(discarded_swabs)                                           AS max_discard,
    (ARRAY_AGG(shift_crew ORDER BY recorded_at DESC))[1]           AS shift_crew
  FROM bucketed
  GROUP BY machine_id, bucket_ts
),
with_anchors AS (
  SELECT
    a.*,
    LAG(max_swabs)   OVER w AS anc_swabs,
    LAG(max_boxes)   OVER w AS anc_boxes,
    LAG(max_prod_t)  OVER w AS anc_prod_t,
    LAG(max_discard) OVER w AS anc_discard
  FROM agg a
  WINDOW w AS (PARTITION BY machine_id ORDER BY bucket_ts)
)
SELECT
  machine_id,
  machine_code,
  cell_id,
  bucket_ts,
  shift_crew,
  GREATEST(0, max_swabs   - COALESCE(anc_swabs,   max_swabs))   AS swabs_produced,
  GREATEST(0, max_boxes   - COALESCE(anc_boxes,   max_boxes))   AS boxes_produced,
  GREATEST(0, max_prod_t  - COALESCE(anc_prod_t,  max_prod_t))  AS production_time_seconds,
  GREATEST(0, max_discard - COALESCE(anc_discard, max_discard)) AS discarded_swabs,
  reading_count,
  max_swabs   AS _end_produced_swabs,
  max_boxes   AS _end_produced_boxes,
  max_prod_t  AS _end_production_time_s,
  max_discard AS _end_discarded_swabs
FROM with_anchors;


-- ── G. pg_cron jobs ─────────────────────────────────────────────────────────
-- Every 5 min at :02, :07, :12, ... — 2 min after the bucket boundary so
-- late writes have landed.

SELECT cron.schedule(
  'aggregate-bucket-5m',
  '2-59/5 * * * *',
  $cron$
    SELECT aggregate_all_cells_for_bucket(
      date_bin(
        interval '5 minutes',
        now() - interval '5 minutes',
        TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
      )
    )
  $cron$
);

SELECT cron.schedule(
  'cleanup-bucket-5m',
  '35 3 * * *',
  $cron$
    DELETE FROM bucket_analytics_5m WHERE bucket_ts < now() - interval '48 hours';
  $cron$
);


-- ── H. Row-level security ───────────────────────────────────────────────────

ALTER TABLE bucket_analytics_5m ENABLE ROW LEVEL SECURITY;

GRANT SELECT                         ON bucket_analytics_5m TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON bucket_analytics_5m TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON bucket_analytics_5m TO service_role;

CREATE POLICY bucket_analytics_5m_read
  ON bucket_analytics_5m FOR SELECT TO anon, authenticated USING (true);
