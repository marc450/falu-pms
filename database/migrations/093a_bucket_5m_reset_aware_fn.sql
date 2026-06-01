-- ============================================================
-- Migration 093a: per-reading reset-aware aggregate_cell_bucket
-- ============================================================
-- Removes the ±1min padded window (Trap 3) and computes each
-- counter's delta as a per-reading reset-aware SUM over the
-- true 5-min window. Kills the all-zero straddle bucket at
-- 07:00 / 19:00 shift change and the over-attribution one
-- bucket later. Supersedes 089e. Run 093b after this.
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
    -- snapshot (post-reset values after an in-bucket reset).
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

    -- Anchor = previous bucket's last reading (_end_*); NULL if first ever.
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
