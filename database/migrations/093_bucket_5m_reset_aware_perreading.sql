-- ============================================================
-- Migration 093: per-reading reset-aware bucket deltas
-- ============================================================
-- Kills the dashed "no data" gap on the Machine State Timeline
-- at every 07:00 / 19:00 shift boundary (= 05:00 / 17:00 UTC).
--
-- Root cause (verified 2026-06-01 against bucket_analytics_5m):
-- the boundary buckets are NOT missing rows. They hold ~85
-- readings each but show production=0 AND idle=0 AND error=0,
-- so the frontend draws them as an empty diagonal-stripe gap.
--
-- The 089e aggregator reads a PADDED window
--   v_db_start = bucket_start - 1 min
--   v_db_end   = bucket_end   + 1 min
-- At a shift boundary that -1 min pad pulls the pre-reset
-- high-water mark of every per-shift counter into the first
-- post-reset bucket. So MAX ~= anchor for production, idle AND
-- error at once, every delta collapses to ~0, and the whole
-- bucket reads as a standstill even though the machine is
-- running. The padding also double-counts ~1 tick one bucket
-- after each boundary (the 089g over-attribution check).
--
-- Both 089e (live aggregator) and 089f (set-based backfill)
-- compute a single MAX-anchor / MAX-MIN delta per counter over
-- a whole bucket. That bulk math cannot tell a counter that
-- reset mid-window from one that ran continuously.
--
-- New approach: compute each counter's delta as a per-reading
-- reset-aware SUM over the TRUE bucket window (no padding):
--
--   delta = Σ CASE
--     WHEN prev IS NULL        THEN 0          -- no baseline yet
--     WHEN cur >= prev         THEN cur - prev -- forward growth
--     ELSE cur                                 -- reset: grew from 0
--   END
--
-- where prev = the immediately preceding reading's value for
-- the same machine (LAG ordered by recorded_at). The previous
-- bucket's last reading is folded in as the baseline for this
-- bucket's first reading, so:
--   * normal buckets telescope to (last reading - prev bucket's
--     last reading) — identical to the old MAX-anchor result;
--   * a reset anywhere in the window is attributed as in-bucket
--     growth only, so the boundary bucket now shows real
--     production instead of zero, and the bucket after it is no
--     longer double-counted.
--
-- _end_* is now stored as the LAST chronological reading's
-- value (not MAX), so after an in-bucket reset the next bucket
-- anchors on the post-reset counter, not the pre-reset high.
--
-- Part 2 below re-runs the 48h backfill with the same
-- per-reading math so the existing chart heals immediately.
--
-- KPI calculation change — applied with Marc's explicit approval.
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

  v_machine_id    uuid;
  v_machine_code  text;
  v_label_crew    text;

  v_rdg_count     integer;

  v_end_swabs     bigint;
  v_end_boxes     bigint;
  v_end_prod_t    bigint;
  v_end_idle_t    bigint;
  v_end_error_t   bigint;
  v_end_discard   bigint;

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
      AND sr.recorded_at >= p_bucket_start
      AND sr.recorded_at <  v_bucket_end
      AND sr.shift_crew  IS NOT NULL
  LOOP
    SELECT COUNT(*)
      INTO v_rdg_count
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.recorded_at >= p_bucket_start
      AND sr.recorded_at <  v_bucket_end
      AND sr.shift_crew  IS NOT NULL;

    IF v_rdg_count IS NULL OR v_rdg_count = 0 THEN
      CONTINUE;
    END IF;

    -- Last chronological reading: crew label + end-of-bucket counter
    -- snapshot. After an in-bucket reset these are the post-reset values,
    -- which is exactly what the next bucket must anchor on.
    SELECT
      sr.shift_crew,
      sr.produced_swabs,          sr.produced_boxes,
      sr.production_time_seconds, sr.idle_time_seconds,
      sr.error_time_seconds,      sr.discarded_swabs
    INTO
      v_label_crew,
      v_end_swabs,  v_end_boxes,
      v_end_prod_t, v_end_idle_t,
      v_end_error_t, v_end_discard
    FROM shift_readings sr
    WHERE sr.machine_id  = v_machine_id
      AND sr.recorded_at >= p_bucket_start
      AND sr.recorded_at <  v_bucket_end
      AND sr.shift_crew  IS NOT NULL
    ORDER BY sr.recorded_at DESC
    LIMIT 1;

    -- Anchor = previous bucket's last reading (stored as _end_*). Folded in
    -- as the baseline for this bucket's first reading so cross-bucket growth
    -- telescopes correctly. NULL when this is the first bucket ever for the
    -- machine; then the first reading contributes 0 (no baseline to grow from).
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
      v_anc_swabs   := NULL;
      v_anc_boxes   := NULL;
      v_anc_prod_t  := NULL;
      v_anc_idle_t  := NULL;
      v_anc_error_t := NULL;
      v_anc_discard := NULL;
    END IF;

    -- Per-reading reset-aware delta sum over the true bucket window.
    WITH r AS (
      SELECT
        sr.recorded_at,
        sr.produced_swabs,
        sr.produced_boxes,
        sr.production_time_seconds,
        sr.idle_time_seconds,
        sr.error_time_seconds,
        sr.discarded_swabs
      FROM shift_readings sr
      WHERE sr.machine_id  = v_machine_id
        AND sr.recorded_at >= p_bucket_start
        AND sr.recorded_at <  v_bucket_end
        AND sr.shift_crew  IS NOT NULL
    ),
    lagged AS (
      SELECT
        r.*,
        COALESCE(LAG(produced_swabs)          OVER w, v_anc_swabs)   AS p_swabs,
        COALESCE(LAG(produced_boxes)          OVER w, v_anc_boxes)   AS p_boxes,
        COALESCE(LAG(production_time_seconds) OVER w, v_anc_prod_t)  AS p_prod_t,
        COALESCE(LAG(idle_time_seconds)       OVER w, v_anc_idle_t)  AS p_idle_t,
        COALESCE(LAG(error_time_seconds)      OVER w, v_anc_error_t) AS p_error_t,
        COALESCE(LAG(discarded_swabs)         OVER w, v_anc_discard) AS p_discard
      FROM r
      WINDOW w AS (ORDER BY recorded_at)
    )
    SELECT
      COALESCE(SUM(CASE WHEN p_swabs   IS NULL THEN 0 WHEN produced_swabs          >= p_swabs   THEN produced_swabs          - p_swabs   ELSE produced_swabs          END), 0),
      COALESCE(SUM(CASE WHEN p_boxes   IS NULL THEN 0 WHEN produced_boxes          >= p_boxes   THEN produced_boxes          - p_boxes   ELSE produced_boxes          END), 0),
      COALESCE(SUM(CASE WHEN p_prod_t  IS NULL THEN 0 WHEN production_time_seconds >= p_prod_t  THEN production_time_seconds - p_prod_t  ELSE production_time_seconds END), 0),
      COALESCE(SUM(CASE WHEN p_idle_t  IS NULL THEN 0 WHEN idle_time_seconds       >= p_idle_t  THEN idle_time_seconds       - p_idle_t  ELSE idle_time_seconds       END), 0),
      COALESCE(SUM(CASE WHEN p_error_t IS NULL THEN 0 WHEN error_time_seconds      >= p_error_t THEN error_time_seconds      - p_error_t ELSE error_time_seconds      END), 0),
      COALESCE(SUM(CASE WHEN p_discard IS NULL THEN 0 WHEN discarded_swabs         >= p_discard THEN discarded_swabs         - p_discard ELSE discarded_swabs         END), 0)
    INTO
      v_delta_swabs, v_delta_boxes, v_delta_prod_t,
      v_delta_idle_t, v_delta_error_t, v_delta_discard
    FROM lagged;

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
      COALESCE(v_end_swabs,   0), COALESCE(v_end_boxes,   0),
      COALESCE(v_end_prod_t,  0), COALESCE(v_end_idle_t,  0), COALESCE(v_end_error_t, 0),
      COALESCE(v_end_discard, 0)
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

-- ============================================================
-- Part 2: re-run the 48h backfill with per-reading math
-- ============================================================
-- Set-based mirror of the aggregator above. LAG runs over the
-- whole per-machine reading stream (not per bucket), so each
-- bucket's first reading automatically anchors on the previous
-- bucket's last reading and resets are handled wherever they
-- fall. TRUNCATE + INSERT is transactional; readers see either
-- the old table or the fully repopulated one, never empty.
-- ============================================================

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
WITH base AS (
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
lagged AS (
  SELECT
    base.*,
    LAG(produced_swabs)          OVER w AS p_swabs,
    LAG(produced_boxes)          OVER w AS p_boxes,
    LAG(production_time_seconds) OVER w AS p_prod_t,
    LAG(idle_time_seconds)       OVER w AS p_idle_t,
    LAG(error_time_seconds)      OVER w AS p_error_t,
    LAG(discarded_swabs)         OVER w AS p_discard
  FROM base
  WINDOW w AS (PARTITION BY machine_id ORDER BY recorded_at)
),
deltas AS (
  SELECT
    machine_id,
    machine_code,
    cell_id,
    bucket_ts,
    recorded_at,
    shift_crew,
    produced_swabs,
    produced_boxes,
    production_time_seconds,
    idle_time_seconds,
    error_time_seconds,
    discarded_swabs,
    CASE WHEN p_swabs   IS NULL THEN 0 WHEN produced_swabs          >= p_swabs   THEN produced_swabs          - p_swabs   ELSE produced_swabs          END AS d_swabs,
    CASE WHEN p_boxes   IS NULL THEN 0 WHEN produced_boxes          >= p_boxes   THEN produced_boxes          - p_boxes   ELSE produced_boxes          END AS d_boxes,
    CASE WHEN p_prod_t  IS NULL THEN 0 WHEN production_time_seconds >= p_prod_t  THEN production_time_seconds - p_prod_t  ELSE production_time_seconds END AS d_prod_t,
    CASE WHEN p_idle_t  IS NULL THEN 0 WHEN idle_time_seconds       >= p_idle_t  THEN idle_time_seconds       - p_idle_t  ELSE idle_time_seconds       END AS d_idle_t,
    CASE WHEN p_error_t IS NULL THEN 0 WHEN error_time_seconds      >= p_error_t THEN error_time_seconds      - p_error_t ELSE error_time_seconds      END AS d_error_t,
    CASE WHEN p_discard IS NULL THEN 0 WHEN discarded_swabs         >= p_discard THEN discarded_swabs         - p_discard ELSE discarded_swabs         END AS d_discard
  FROM lagged
)
SELECT
  machine_id,
  MAX(machine_code)                                                  AS machine_code,
  MAX(cell_id::text)::uuid                                           AS cell_id,
  bucket_ts,
  (ARRAY_AGG(shift_crew              ORDER BY recorded_at DESC))[1]  AS shift_crew,
  SUM(d_swabs)                                                       AS swabs_produced,
  SUM(d_boxes)                                                       AS boxes_produced,
  SUM(d_prod_t)                                                      AS production_time_seconds,
  SUM(d_idle_t)                                                      AS idle_time_seconds,
  SUM(d_error_t)                                                     AS error_time_seconds,
  SUM(d_discard)                                                     AS discarded_swabs,
  COUNT(*)::int                                                      AS reading_count,
  (ARRAY_AGG(produced_swabs          ORDER BY recorded_at DESC))[1]  AS _end_produced_swabs,
  (ARRAY_AGG(produced_boxes          ORDER BY recorded_at DESC))[1]  AS _end_produced_boxes,
  (ARRAY_AGG(production_time_seconds ORDER BY recorded_at DESC))[1]  AS _end_production_time_s,
  (ARRAY_AGG(idle_time_seconds       ORDER BY recorded_at DESC))[1]  AS _end_idle_time_s,
  (ARRAY_AGG(error_time_seconds      ORDER BY recorded_at DESC))[1]  AS _end_error_time_s,
  (ARRAY_AGG(discarded_swabs         ORDER BY recorded_at DESC))[1]  AS _end_discarded_swabs
FROM deltas
GROUP BY machine_id, bucket_ts
ON CONFLICT (machine_id, bucket_ts) DO NOTHING;
