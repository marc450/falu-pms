-- ============================================================
-- ClickHouse backfill — remove the shift-switch "dashed gap" from history
-- ============================================================
-- Context
--   The Machine State Timeline showed an all-zero (dashed) 5-min bucket at
--   every shift switch. Root cause: the end-of-shift Save snapshot
--   (save_flag = 1) carries the OUTGOING shift's maxed-out cumulative counters
--   but is stamped microseconds into the NEW shift, so it lands in the new
--   shift's first 5-min bucket. In agg_bucket_5m that row pins the bucket's MAX
--   to the previous high-water mark, and the reset-aware delta in
--   v_bucket_deltas_5m then computes 0 for production, idle AND error.
--
--   The bridge fix (index.js) re-stamps NEW save rows into the closing window,
--   so this is only needed to clean up buckets ALREADY rolled up.
--
-- Scope (verified 2026-06-23): 13,572 contaminated (machine, 5-min bucket)
--   pairs, 18 machines, 2025-06-11 → present. All save_flag = 1 rows sit on a
--   shift boundary, so the set is exactly "buckets that contain a closer".
--
-- Strategy
--   AggregatingMergeTree can't LOWER a stored MAX by re-inserting, so we DELETE
--   the contaminated bucket rows, then re-INSERT just those buckets from raw
--   shift_readings with the redundant closer (save_flag = 1) excluded. The
--   closer duplicates the last real reading's totals, so dropping it from the
--   rollup loses no production — it only removes the contamination.
--
-- Safe to re-run: raw shift_readings is never modified, so the target-bucket
--   set is stable and the rebuild is deterministic (DELETE then identical
--   re-INSERT). reading_count stays correct because each target bucket is
--   deleted before it is re-inserted (no double counting).
--
-- Run order: STEP 1, wait for the mutation to finish (STEP 1b), then STEP 2.
-- Run when NOT exactly on a shift boundary so the current bucket isn't live.
-- ============================================================

-- ── STEP 1 — delete the contaminated bucket rows ────────────────────────────
ALTER TABLE agg_bucket_5m
DELETE WHERE (machine_id, bucket_ts) IN (
    SELECT machine_id, toStartOfInterval(assumeNotNull(plc_timestamp), INTERVAL 5 MINUTE)
    FROM shift_readings
    WHERE save_flag = 1 AND shift_crew != '' AND plc_timestamp IS NOT NULL
);

-- ── STEP 1b — wait until the mutation reports is_done = 1 before STEP 2 ──────
-- Re-run this until the row disappears (or shows is_done = 1).
SELECT mutation_id, command, is_done, latest_fail_reason
FROM system.mutations
WHERE table = 'agg_bucket_5m' AND is_done = 0;

-- ── STEP 2 — rebuild those buckets from raw, excluding the closer ───────────
INSERT INTO agg_bucket_5m
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
WHERE plc_timestamp IS NOT NULL
  AND plc_timestamp >= toDateTime64('2020-01-01 00:00:00', 3, 'UTC')
  AND shift_crew != ''
  AND save_flag != 1                                   -- drop the redundant closer that caused the gap
  AND (machine_id, toStartOfInterval(assumeNotNull(plc_timestamp), INTERVAL 5 MINUTE)) IN (
        SELECT machine_id, toStartOfInterval(assumeNotNull(plc_timestamp), INTERVAL 5 MINUTE)
        FROM shift_readings
        WHERE save_flag = 1 AND shift_crew != '' AND plc_timestamp IS NOT NULL
      )
GROUP BY machine_id, bucket_ts;

-- ── STEP 3 (optional) — verify the gap is gone ──────────────────────────────
-- Expect ~0 rows: boundary buckets that still read all-zero despite having
-- readings. (A genuine full-bucket idle/error standstill is fine; this only
-- flags the all-three-zero defect.)
-- SELECT formatDateTime(bucket_ts,'%H:%i') AS tod, count() AS zero_buckets
-- FROM v_bucket_deltas_5m
-- WHERE delta_prod_t = 0 AND delta_idle_t = 0 AND delta_error_t = 0 AND reading_count > 10
-- GROUP BY tod ORDER BY zero_buckets DESC LIMIT 10;
