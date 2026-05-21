-- ============================================================
-- Migration 089c: backfill last 48h with idle + error seconds
-- ============================================================
-- Part 3 of 4 — TRUNCATEs bucket_analytics_5m and re-derives every
-- bucket in the 48h retention window from shift_readings in one
-- set-based pass (same shape as 084b). Without this, pre-089b
-- buckets carry 0 for idle/error and the Machine Monitor tile
-- would read uptime as ~100% for any window that touches them.
--
-- The intraday chart will be empty for ~30s while the INSERT
-- runs — both statements are in one transaction so readers see
-- either the old state or the fully repopulated table, never an
-- empty one. Pick a quiet moment if that matters.
--
-- Requires 089a + 089b. Safe to re-run if needed.
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
