-- ============================================================
-- Migration 093b: 48h backfill with per-reading reset-aware math
-- ============================================================
-- Set-based mirror of 093a. LAG runs over the whole per-machine
-- reading stream, so each bucket's first reading anchors on the
-- previous bucket's last reading and resets are handled wherever
-- they fall. TRUNCATE + INSERT is transactional. Run after 093a.
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
