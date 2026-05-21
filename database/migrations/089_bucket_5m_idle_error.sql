-- ============================================================
-- Migration 089: idle + error seconds on bucket_analytics_5m
-- ============================================================
-- The Machine Monitor "Avg Uptime" tile averages per bucket
-- avg_uptime over the window. That figure uses a flat
-- denominator (production / (machines * 300)) and doesn't
-- subtract error time from idle or forgive planned breaks, so
-- it drifts from the park-overview number derived from
-- calcCorrectedEfficiency in the frontend.
--
-- To compute the corrected formula
--   production / (production + max(0, max(0, idle-error) - planned) + error)
-- over an arbitrary rolling window, we need per-bucket idle
-- and error seconds. Today bucket_analytics_5m stores only
-- production. This migration:
--
--   1. Adds idle_time_seconds + error_time_seconds (deltas)
--      and the matching _end_idle_time_s / _end_error_time_s
--      anchors used by the next cron run.
--   2. Rewrites aggregate_cell_bucket to populate them, using
--      the same three-branch CASE reset detection 084 applies
--      to production / swabs / boxes / discarded
--      (project_counter_reset_handling.md). The idle and error
--      counters live in shift_readings as cumulative per-shift
--      values, same as production_time_seconds, so the reset
--      pattern applies identically.
--   3. TRUNCATEs the table and re-runs the set-based 48h
--      backfill so existing buckets get the new columns
--      populated. Without this they'd carry default 0 and the
--      tile would read uptime = 100% for any window that
--      includes pre-migration buckets.
--   4. Extends get_fleet_trend_minute to return per-bucket
--      summed raw seconds (production / idle / error) so the
--      frontend can compute the corrected formula over the
--      summed window. avg_uptime / avg_scrap are unchanged so
--      the existing chart line keeps working without churn.
-- ============================================================


-- ── A. Schema additions ─────────────────────────────────────────────────────
-- New columns default to 0 so any aggregator path that hasn't been touched
-- yet (or rows written before the backfill runs) stays consistent.

ALTER TABLE bucket_analytics_5m
  ADD COLUMN IF NOT EXISTS idle_time_seconds  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_time_seconds bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS _end_idle_time_s   bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS _end_error_time_s  bigint NOT NULL DEFAULT 0;


-- ── B. aggregate_cell_bucket: now writes idle + error too ───────────────────

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
  v_max_idle_t    bigint;
  v_max_error_t   bigint;
  v_max_discard   bigint;
  v_rdg_count     integer;

  v_anc_swabs     bigint;
  v_anc_boxes     bigint;
  v_anc_prod_t    bigint;
  v_anc_idle_t    bigint;
  v_anc_error_t   bigint;
  v_anc_discard   bigint;

  v_delta_swabs   bigint;
  v_delta_boxes   bigint;
  v_delta_prod_t  bigint;
  v_delta_idle_t  bigint;
  v_delta_error_t bigint;
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
      MAX(sr.idle_time_seconds),
      MAX(sr.error_time_seconds),
      MAX(sr.discarded_swabs)
    INTO
      v_rdg_count,
      v_max_swabs, v_max_boxes, v_max_prod_t,
      v_max_idle_t, v_max_error_t, v_max_discard
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
      _end_idle_time_s,
      _end_error_time_s,
      _end_discarded_swabs
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

    -- Per-column reset detection: idle and error are per-shift cumulative
    -- counters in shift_readings (same contract as production_time_seconds),
    -- so the same CASE pattern applies — never GREATEST(0, MAX - anchor).
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


-- ── C. Backfill last 48h ────────────────────────────────────────────────────
-- The new columns default to 0 on existing rows. Re-derive every bucket in
-- the retention window from shift_readings (set-based, same shape as 084b)
-- so the tile reads correct uptime immediately after the migration runs.

TRUNCATE TABLE bucket_analytics_5m;

INSERT INTO bucket_analytics_5m (
  machine_id, machine_code, cell_id, bucket_ts, shift_crew,
  swabs_produced, boxes_produced,
  production_time_seconds, idle_time_seconds, error_time_seconds,
  discarded_swabs, reading_count,
  _end_produced_swabs, _end_produced_boxes,
  _end_production_time_s, _end_idle_time_s, _end_error_time_s,
  _end_discarded_swabs
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
    sr.idle_time_seconds,
    sr.error_time_seconds,
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
    MAX(idle_time_seconds)                                         AS max_idle_t,
    MAX(error_time_seconds)                                        AS max_error_t,
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
    LAG(max_idle_t)  OVER w AS anc_idle_t,
    LAG(max_error_t) OVER w AS anc_error_t,
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
  CASE
    WHEN anc_swabs   IS NULL              THEN 0
    WHEN max_swabs   < anc_swabs          THEN max_swabs
    ELSE max_swabs   - anc_swabs
  END                                                              AS swabs_produced,
  CASE
    WHEN anc_boxes   IS NULL              THEN 0
    WHEN max_boxes   < anc_boxes          THEN max_boxes
    ELSE max_boxes   - anc_boxes
  END                                                              AS boxes_produced,
  CASE
    WHEN anc_prod_t  IS NULL              THEN 0
    WHEN max_prod_t  < anc_prod_t         THEN max_prod_t
    ELSE max_prod_t  - anc_prod_t
  END                                                              AS production_time_seconds,
  CASE
    WHEN anc_idle_t  IS NULL              THEN 0
    WHEN max_idle_t  < anc_idle_t         THEN max_idle_t
    ELSE max_idle_t  - anc_idle_t
  END                                                              AS idle_time_seconds,
  CASE
    WHEN anc_error_t IS NULL              THEN 0
    WHEN max_error_t < anc_error_t        THEN max_error_t
    ELSE max_error_t - anc_error_t
  END                                                              AS error_time_seconds,
  CASE
    WHEN anc_discard IS NULL              THEN 0
    WHEN max_discard < anc_discard        THEN max_discard
    ELSE max_discard - anc_discard
  END                                                              AS discarded_swabs,
  reading_count,
  max_swabs   AS _end_produced_swabs,
  max_boxes   AS _end_produced_boxes,
  max_prod_t  AS _end_production_time_s,
  max_idle_t  AS _end_idle_time_s,
  max_error_t AS _end_error_time_s,
  max_discard AS _end_discarded_swabs
FROM with_anchors
ON CONFLICT (machine_id, bucket_ts) DO NOTHING;


-- ── D. Read RPC: expose raw summed seconds per bucket ───────────────────────
-- Backwards-compatible: avg_uptime / avg_scrap / total_boxes / total_swabs /
-- machine_count / reading_count / shift_count are unchanged so the existing
-- chart code (which reads avg_uptime per bucket) keeps working.
-- The three new columns let the tile sum across buckets and apply the
-- corrected formula in the frontend.

DROP FUNCTION IF EXISTS get_fleet_trend_minute(timestamptz, timestamptz, uuid[]);

CREATE OR REPLACE FUNCTION get_fleet_trend_minute(
  range_start  timestamptz,
  range_end    timestamptz,
  machine_ids  uuid[] DEFAULT NULL
)
RETURNS TABLE (
  bucket                   text,
  avg_uptime               numeric,
  avg_scrap                numeric,
  total_boxes              bigint,
  total_swabs              bigint,
  machine_count            bigint,
  reading_count            bigint,
  shift_count              bigint,
  total_production_seconds bigint,
  total_idle_seconds       bigint,
  total_error_seconds      bigint
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
    COUNT(DISTINCT shift_crew)                             AS shift_count,
    SUM(production_time_seconds)::bigint                   AS total_production_seconds,
    SUM(idle_time_seconds)::bigint                         AS total_idle_seconds,
    SUM(error_time_seconds)::bigint                        AS total_error_seconds
  FROM bucket_analytics_5m
  WHERE bucket_ts >= range_start
    AND bucket_ts <  range_end
    AND (machine_ids IS NULL OR machine_id = ANY(machine_ids))
  GROUP BY bucket_ts
  ORDER BY bucket_ts;
$$;

GRANT EXECUTE ON FUNCTION get_fleet_trend_minute(timestamptz, timestamptz, uuid[])
  TO anon, authenticated;
