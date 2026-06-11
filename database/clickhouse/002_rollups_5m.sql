-- ============================================================
-- ClickHouse Phase 2 — 5-minute rollups replicating bucket_analytics_5m
-- ============================================================
-- READ-ONLY VIEWS over raw shift_readings. No aggregate table is stored —
-- this is the on-the-fly replacement for Supabase's bucket_analytics_5m +
-- aggregate_cell_bucket() pg_cron job.
--
-- Faithful replication of the EXISTING Supabase KPI logic. Source of truth:
--   - Bucketing + reset-aware delta: migration 096c (aggregate_cell_bucket)
--   - Fleet-trend KPI formulas:       migration 083 (get_fleet_trend_minute)
-- DO NOT change these formulas without sign-off — they must match Supabase.
--
-- NOTE: These are for VALIDATION (compare vs Supabase) before anything is
-- relied upon. Nothing here is wired into a dashboard tile yet.
-- ============================================================

-- ── Step 1: per-(machine, 5-min PLC bucket) MAX/MIN of each counter ──
-- Mirrors the per-bucket aggregation in aggregate_cell_bucket(), windowed by
-- plc_timestamp (migration 096), sentinel-guarded (>= 2020), crew required.
CREATE OR REPLACE VIEW v_bucket_5m AS
SELECT
    machine_id,
    any(machine_code)                                       AS machine_code,
    toStartOfInterval(plc_timestamp, INTERVAL 5 MINUTE)     AS bucket_ts,
    argMax(shift_crew, plc_timestamp)                       AS shift_crew,
    max(produced_swabs)          AS max_swabs,   min(produced_swabs)          AS min_swabs,
    max(produced_boxes)          AS max_boxes,   min(produced_boxes)          AS min_boxes,
    max(production_time_seconds) AS max_prod_t,  min(production_time_seconds) AS min_prod_t,
    max(idle_time_seconds)       AS max_idle_t,  min(idle_time_seconds)       AS min_idle_t,
    max(error_time_seconds)      AS max_error_t, min(error_time_seconds)      AS min_error_t,
    max(discarded_swabs)         AS max_discard, min(discarded_swabs)         AS min_discard,
    count()                      AS reading_count
FROM shift_readings
WHERE shift_readings.plc_timestamp IS NOT NULL
  AND shift_readings.plc_timestamp >= toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
  AND shift_readings.shift_crew != ''
GROUP BY machine_id, bucket_ts;

-- ── Step 2: reset-aware delta per bucket (anchor = previous bucket's MAX) ──
-- Exact replica of migration 096c:
--   delta = if(MAX < anchor, MAX - MIN, MAX - anchor)
-- anchor = previous existing bucket's MAX via lagInFrame; first bucket → anchor
-- = current MAX so delta = 0 (matches Postgres "first bucket: delta 0"). No
-- GREATEST clamp (deliberately — matches the corrected 096c logic).
CREATE OR REPLACE VIEW v_bucket_deltas_5m AS
SELECT
    machine_id, machine_code, bucket_ts, shift_crew, reading_count,
    -- rn = 1 is the first bucket for this machine -> delta 0 (matches Postgres)
    if(rn = 1, 0, if(max_swabs   < anc_swabs,   max_swabs   - min_swabs,   max_swabs   - anc_swabs))   AS delta_swabs,
    if(rn = 1, 0, if(max_boxes   < anc_boxes,   max_boxes   - min_boxes,   max_boxes   - anc_boxes))   AS delta_boxes,
    if(rn = 1, 0, if(max_prod_t  < anc_prod_t,  max_prod_t  - min_prod_t,  max_prod_t  - anc_prod_t))  AS delta_prod_t,
    if(rn = 1, 0, if(max_idle_t  < anc_idle_t,  max_idle_t  - min_idle_t,  max_idle_t  - anc_idle_t))  AS delta_idle_t,
    if(rn = 1, 0, if(max_error_t < anc_error_t, max_error_t - min_error_t, max_error_t - anc_error_t)) AS delta_error_t,
    if(rn = 1, 0, if(max_discard < anc_discard, max_discard - min_discard, max_discard - anc_discard)) AS delta_discard
FROM (
    SELECT
        *,
        row_number()            OVER w AS rn,
        lagInFrame(max_swabs)   OVER w AS anc_swabs,
        lagInFrame(max_boxes)   OVER w AS anc_boxes,
        lagInFrame(max_prod_t)  OVER w AS anc_prod_t,
        lagInFrame(max_idle_t)  OVER w AS anc_idle_t,
        lagInFrame(max_error_t) OVER w AS anc_error_t,
        lagInFrame(max_discard) OVER w AS anc_discard
    FROM v_bucket_5m
    WINDOW w AS (PARTITION BY machine_id ORDER BY bucket_ts)
);

-- ── Step 3: fleet trend per 5-min bucket — replica of get_fleet_trend_minute ──
-- avg_uptime  = sum(production_time_delta) / (machine_count * 300s) * 100
-- avg_scrap   = sum(discarded_delta) / sum(swabs_delta) * 100   (volume-weighted)
-- total_swabs / total_boxes = sum of deltas
CREATE OR REPLACE VIEW v_fleet_trend_5m AS
SELECT
    formatDateTime(bucket_ts, '%Y-%m-%dT%H:%i')                                   AS bucket,
    round(sum(delta_prod_t) / (uniqExact(machine_id) * 5 * 60) * 100, 1)          AS avg_uptime,
    if(sum(delta_swabs) > 0, round(sum(delta_discard) / sum(delta_swabs) * 100, 1), 0) AS avg_scrap,
    toInt64(sum(delta_boxes))                                                     AS total_boxes,
    toInt64(sum(delta_swabs))                                                     AS total_swabs,
    uniqExact(machine_id)                                                         AS machine_count,
    toInt64(sum(reading_count))                                                   AS reading_count,
    uniqExact(shift_crew)                                                         AS shift_count
FROM v_bucket_deltas_5m
GROUP BY bucket_ts
ORDER BY bucket_ts;

-- ============================================================
-- NOT replicated here yet (need their own sign-off, separate step):
--   - Daily/work-day rollup with the -7h factory-timezone offset
--     (factory_timezone in app_settings; get_fleet_trend daily path)
--   - bu_normalized = (swabs/7200) / run_MINUTES * 12   (run_hours is minutes!)
--   - corrected efficiency / BU run-rate (frontend live-tile math)
-- ============================================================
