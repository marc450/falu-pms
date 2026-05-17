-- ============================================================
-- Migration 084b: rebackfill bucket_analytics_5m after 084
-- ============================================================
-- Same set-based shape as 083b, but the per-column delta now
-- detects counter resets: when the per-machine MAX in a bucket
-- is below the previous bucket's MAX (counter reset at shift
-- end), the delta is the new MAX itself rather than
-- GREATEST(0, MAX - anchor) which would clamp to 0.
--
-- Without this, every shift change (07:00 / 19:00 local =
-- 05:00 / 17:00 UTC) produces ~10 min of spurious zero
-- production on the chart.
-- ============================================================

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
  -- Per-column reset detection: when the current bucket's MAX is below the
  -- previous bucket's MAX (LAG anchor), the cumulative counter must have
  -- reset (shift end). Treat the current MAX as the delta itself rather
  -- than (MAX - anchor) — which would otherwise clamp to 0 via the
  -- previous GREATEST(0, ...) and visually flatline the chart.
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
    WHEN anc_discard IS NULL              THEN 0
    WHEN max_discard < anc_discard        THEN max_discard
    ELSE max_discard - anc_discard
  END                                                              AS discarded_swabs,
  reading_count,
  max_swabs   AS _end_produced_swabs,
  max_boxes   AS _end_produced_boxes,
  max_prod_t  AS _end_production_time_s,
  max_discard AS _end_discarded_swabs
FROM with_anchors
ON CONFLICT (machine_id, bucket_ts) DO NOTHING;
