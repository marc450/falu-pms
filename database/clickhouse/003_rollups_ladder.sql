-- ============================================================
-- ClickHouse Phase 2 — granularity ladder + shift resolver
-- ============================================================
-- Extends 002 (5-min) with the rest of the ladder. All read-only views over
-- raw shift_readings. Same reset-aware delta math as 002 (faithful to Supabase).
--
--   window <= 1h  -> 5s   (v_fleet_trend_5s, per-reading grain)
--   window <= 24h -> 5min (v_fleet_trend_5m, in 002)
--   window <= 7d  -> 1h   (v_fleet_trend_1h)
--   window <= 12m -> 1d   (v_fleet_trend_1d, factory work-day)
--
-- Coarser tiers (1h, 1d) roll up the proven 5-min deltas (sum), so no logic is
-- duplicated and daily intra-shift resets are handled correctly. Fleet uptime
-- generalises as: sum(production_delta) / (Σ bucket availability) * 100, where
-- each (machine, 5-min) row contributes 300s of availability => count()*300.
-- ============================================================

-- ── 1-hour trend (<= 7 days) — roll up 5-min deltas ──
CREATE OR REPLACE VIEW v_fleet_trend_1h AS
SELECT
    formatDateTime(toStartOfInterval(bucket_ts, INTERVAL 1 HOUR), '%Y-%m-%dT%H:00') AS bucket,
    round(sum(delta_prod_t) / (count() * 300) * 100, 1)                              AS avg_uptime,
    if(sum(delta_swabs) > 0, round(sum(delta_discard) / sum(delta_swabs) * 100, 1), 0) AS avg_scrap,
    toInt64(sum(delta_boxes))                                                        AS total_boxes,
    toInt64(sum(delta_swabs))                                                        AS total_swabs,
    uniqExact(machine_id)                                                            AS machine_count
FROM v_bucket_deltas_5m
GROUP BY toStartOfInterval(bucket_ts, INTERVAL 1 HOUR)
ORDER BY 1;

-- ── 1-day trend (<= 12 months) — factory work-day buckets ──
-- Work-day boundary = 07:00 factory-local (Europe/Zurich) => -7h offset, exactly
-- mirroring Postgres: DATE_TRUNC('day', (ts AT TIME ZONE tz) - INTERVAL '7 hours').
CREATE OR REPLACE VIEW v_fleet_trend_1d AS
SELECT
    toString(toDate(toTimeZone(bucket_ts, 'Europe/Zurich') - INTERVAL 7 HOUR))       AS bucket,
    round(sum(delta_prod_t) / (count() * 300) * 100, 1)                              AS avg_uptime,
    if(sum(delta_swabs) > 0, round(sum(delta_discard) / sum(delta_swabs) * 100, 1), 0) AS avg_scrap,
    toInt64(sum(delta_boxes))                                                        AS total_boxes,
    toInt64(sum(delta_swabs))                                                        AS total_swabs,
    uniqExact(machine_id)                                                            AS machine_count
FROM v_bucket_deltas_5m
GROUP BY toDate(toTimeZone(bucket_ts, 'Europe/Zurich') - INTERVAL 7 HOUR)
ORDER BY 1;

-- ── 5-second grain (<= 1 hour) — per-reading deltas straight from raw ──
-- Same reset-aware delta, but bucket width = 5s. For short windows only.
CREATE OR REPLACE VIEW v_bucket_5s AS
SELECT
    machine_id,
    any(machine_code)                                  AS machine_code,
    toStartOfInterval(plc_timestamp, INTERVAL 5 SECOND) AS bucket_ts,
    argMax(shift_crew, plc_timestamp)                  AS shift_crew,
    max(produced_swabs) AS max_swabs, min(produced_swabs) AS min_swabs,
    max(produced_boxes) AS max_boxes, min(produced_boxes) AS min_boxes,
    max(production_time_seconds) AS max_prod_t, min(production_time_seconds) AS min_prod_t,
    max(idle_time_seconds) AS max_idle_t, min(idle_time_seconds) AS min_idle_t,
    max(error_time_seconds) AS max_error_t, min(error_time_seconds) AS min_error_t,
    max(discarded_swabs) AS max_discard, min(discarded_swabs) AS min_discard,
    count() AS reading_count
FROM shift_readings
WHERE shift_readings.plc_timestamp IS NOT NULL
  AND shift_readings.plc_timestamp >= toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
  AND shift_readings.shift_crew != ''
GROUP BY machine_id, bucket_ts;

CREATE OR REPLACE VIEW v_bucket_deltas_5s AS
SELECT
    machine_id, machine_code, bucket_ts, shift_crew, reading_count,
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
    FROM v_bucket_5s
    WINDOW w AS (PARTITION BY machine_id ORDER BY bucket_ts)
);

CREATE OR REPLACE VIEW v_fleet_trend_5s AS
SELECT
    formatDateTime(bucket_ts, '%Y-%m-%dT%H:%i:%S')                                   AS bucket,
    round(sum(delta_prod_t) / (count() * 5) * 100, 1)                                AS avg_uptime,
    if(sum(delta_swabs) > 0, round(sum(delta_discard) / sum(delta_swabs) * 100, 1), 0) AS avg_scrap,
    toInt64(sum(delta_boxes))                                                        AS total_boxes,
    toInt64(sum(delta_swabs))                                                        AS total_swabs,
    uniqExact(machine_id)                                                            AS machine_count
FROM v_bucket_deltas_5s
GROUP BY bucket_ts
ORDER BY bucket_ts;

-- ── Shift resolver — current & last shift bounds (UTC), for the presets ──
-- Shift config: Europe/Zurich, 12h shifts starting 07:00 and 19:00 local.
CREATE OR REPLACE VIEW v_shift_bounds AS
WITH
    toTimeZone(now(), 'Europe/Zurich')          AS nl,
    toHour(nl)                                  AS h,
    toDate(nl)                                  AS d,
    multiIf(
        h >= 19, makeDateTime(toYear(d),   toMonth(d),   toDayOfMonth(d),   19, 0, 0, 'Europe/Zurich'),
        h >= 7,  makeDateTime(toYear(d),   toMonth(d),   toDayOfMonth(d),    7, 0, 0, 'Europe/Zurich'),
                 makeDateTime(toYear(d-1), toMonth(d-1), toDayOfMonth(d-1), 19, 0, 0, 'Europe/Zurich')
    )                                           AS cur_start
SELECT
    cur_start                        AS current_shift_start,
    cur_start + INTERVAL 12 HOUR     AS current_shift_end,
    cur_start - INTERVAL 12 HOUR     AS last_shift_start,
    cur_start                        AS last_shift_end;
