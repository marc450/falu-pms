-- ============================================================
-- ClickHouse Phase 2 — incremental MV for cheap long-range reads
-- ============================================================
-- Maintains per-(machine, 5-min bucket) MAX/MIN/count incrementally as raw
-- readings land, so the 5m/1h/1d tiers read ~5k stored bucket-rows instead of
-- re-scanning a year of raw 5s rows. ClickHouse maintains it itself (no cron,
-- no drift). The reset-aware delta is still applied at READ time over these
-- bucket states (lag), so numbers stay identical to the raw views.
--
-- Uses SimpleAggregateFunction(max/min/sum): the stored value IS the partial
-- aggregate, and AggregatingMergeTree combines parts with the same function.
-- ============================================================

-- ── Stored bucket states ──
CREATE TABLE IF NOT EXISTS agg_bucket_5m
(
    machine_id    String,
    bucket_ts     DateTime64(3, 'UTC'),
    machine_code  SimpleAggregateFunction(max, String),
    shift_crew    SimpleAggregateFunction(max, String),
    max_swabs     SimpleAggregateFunction(max, UInt64),  min_swabs   SimpleAggregateFunction(min, UInt64),
    max_boxes     SimpleAggregateFunction(max, UInt64),  min_boxes   SimpleAggregateFunction(min, UInt64),
    max_prod_t    SimpleAggregateFunction(max, Float64), min_prod_t  SimpleAggregateFunction(min, Float64),
    max_idle_t    SimpleAggregateFunction(max, Float64), min_idle_t  SimpleAggregateFunction(min, Float64),
    max_error_t   SimpleAggregateFunction(max, Float64), min_error_t SimpleAggregateFunction(min, Float64),
    max_discard   SimpleAggregateFunction(max, UInt64),  min_discard SimpleAggregateFunction(min, UInt64),
    reading_count SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket_ts)
ORDER BY (machine_id, bucket_ts);

-- ── Incremental MV: every new insert updates the bucket states ──
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_bucket_5m TO agg_bucket_5m AS
SELECT
    machine_id,
    toStartOfInterval(assumeNotNull(plc_timestamp), INTERVAL 5 MINUTE) AS bucket_ts,
    max(machine_code) AS machine_code,
    max(shift_crew)   AS shift_crew,
    max(produced_swabs) AS max_swabs, min(produced_swabs) AS min_swabs,
    max(produced_boxes) AS max_boxes, min(produced_boxes) AS min_boxes,
    max(production_time_seconds) AS max_prod_t, min(production_time_seconds) AS min_prod_t,
    max(idle_time_seconds) AS max_idle_t, min(idle_time_seconds) AS min_idle_t,
    max(error_time_seconds) AS max_error_t, min(error_time_seconds) AS min_error_t,
    max(discarded_swabs) AS max_discard, min(discarded_swabs) AS min_discard,
    toUInt64(count()) AS reading_count
FROM shift_readings
WHERE shift_readings.plc_timestamp IS NOT NULL
  AND shift_readings.plc_timestamp >= toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
  AND shift_readings.shift_crew != ''
GROUP BY machine_id, bucket_ts;

-- ── Read view: re-merge parts to final per-bucket values (same shape as v_bucket_5m) ──
CREATE OR REPLACE VIEW v_bucket_5m_agg AS
SELECT
    machine_id,
    max(machine_code) AS machine_code,
    bucket_ts,
    max(shift_crew)   AS shift_crew,
    max(max_swabs) AS max_swabs, min(min_swabs) AS min_swabs,
    max(max_boxes) AS max_boxes, min(min_boxes) AS min_boxes,
    max(max_prod_t) AS max_prod_t, min(min_prod_t) AS min_prod_t,
    max(max_idle_t) AS max_idle_t, min(min_idle_t) AS min_idle_t,
    max(max_error_t) AS max_error_t, min(min_error_t) AS min_error_t,
    max(max_discard) AS max_discard, min(min_discard) AS min_discard,
    sum(reading_count) AS reading_count
FROM agg_bucket_5m
GROUP BY machine_id, bucket_ts;

-- ── Backfill existing rows. RUN ONCE (right after creating the MV). MAX/MIN are
--    idempotent so overlap with the MV on the in-flight bucket is harmless for
--    KPIs (only reading_count of the current bucket may be double-counted; it is
--    not a KPI). Do NOT re-run, or reading_count inflates. ──
INSERT INTO agg_bucket_5m
SELECT machine_id, toStartOfInterval(assumeNotNull(plc_timestamp), INTERVAL 5 MINUTE) AS bucket_ts,
    max(machine_code), max(shift_crew),
    max(produced_swabs), min(produced_swabs), max(produced_boxes), min(produced_boxes),
    max(production_time_seconds), min(production_time_seconds), max(idle_time_seconds), min(idle_time_seconds),
    max(error_time_seconds), min(error_time_seconds), max(discarded_swabs), min(discarded_swabs),
    toUInt64(count())
FROM shift_readings
WHERE plc_timestamp IS NOT NULL AND plc_timestamp >= toDateTime64('2020-01-01 00:00:00',3,'UTC') AND shift_crew != ''
GROUP BY machine_id, bucket_ts;

-- ── Repoint the delta view at the MV-backed bucket view, so 5m/1h/1d read the
--    stored states instead of scanning raw. (5s stays on raw — too fine for 5m.)
--    Validated: MV-backed v_fleet_trend_5m == Supabase, all buckets exact. ──
CREATE OR REPLACE VIEW v_bucket_deltas_5m AS
SELECT machine_id, machine_code, bucket_ts, shift_crew, reading_count,
    if(rn = 1, 0, if(max_swabs   < anc_swabs,   max_swabs   - min_swabs,   max_swabs   - anc_swabs))   AS delta_swabs,
    if(rn = 1, 0, if(max_boxes   < anc_boxes,   max_boxes   - min_boxes,   max_boxes   - anc_boxes))   AS delta_boxes,
    if(rn = 1, 0, if(max_prod_t  < anc_prod_t,  max_prod_t  - min_prod_t,  max_prod_t  - anc_prod_t))  AS delta_prod_t,
    if(rn = 1, 0, if(max_idle_t  < anc_idle_t,  max_idle_t  - min_idle_t,  max_idle_t  - anc_idle_t))  AS delta_idle_t,
    if(rn = 1, 0, if(max_error_t < anc_error_t, max_error_t - min_error_t, max_error_t - anc_error_t)) AS delta_error_t,
    if(rn = 1, 0, if(max_discard < anc_discard, max_discard - min_discard, max_discard - anc_discard)) AS delta_discard
FROM (
    SELECT *,
        row_number()            OVER w AS rn,
        lagInFrame(max_swabs)   OVER w AS anc_swabs,
        lagInFrame(max_boxes)   OVER w AS anc_boxes,
        lagInFrame(max_prod_t)  OVER w AS anc_prod_t,
        lagInFrame(max_idle_t)  OVER w AS anc_idle_t,
        lagInFrame(max_error_t) OVER w AS anc_error_t,
        lagInFrame(max_discard) OVER w AS anc_discard
    FROM v_bucket_5m_agg
    WINDOW w AS (PARTITION BY machine_id ORDER BY bucket_ts)
);
