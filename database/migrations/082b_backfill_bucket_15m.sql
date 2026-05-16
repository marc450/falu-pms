-- ============================================================
-- Migration 082b: backfill bucket_analytics_15m (optional)
-- ============================================================
-- Run AFTER 082. The cron-driven function aggregates one
-- bucket at a time procedurally, which is fine for "fill the
-- bucket that just closed" but too slow for a 48h backfill
-- (one HTTP request to the SQL editor doesn't finish before
-- the gateway times out).
--
-- This script does the same work as a single set-based query:
-- bin readings into 15-min buckets, take MAX of cumulative
-- counters per (machine, bucket), use LAG to compute the
-- delta from the previous bucket per machine. One INSERT,
-- ~1.5k rows, completes in seconds.
-- ============================================================

INSERT INTO bucket_analytics_15m (
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
      interval '15 minutes',
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
                            interval '15 minutes',
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
FROM with_anchors
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
