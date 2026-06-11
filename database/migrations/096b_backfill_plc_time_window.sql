-- ============================================================
-- Migration 096b: backfill 48h on the PLC-time window
-- ============================================================
-- Re-aggregates every 5-min bucket in the retention window using
-- the PLC-time logic from 096. Existing rows were computed by
-- recorded_at and hold inflated deltas wherever the ingest lag
-- shifted; this recomputes them correctly (upsert) and cleans the
-- intraday chart immediately instead of waiting ~48h for the bad
-- rows to age out.
--
-- The underlying shift_readings are fine — their counters are
-- correct on the PLC clock; only the windowing was wrong — so
-- re-bucketing by PLC time yields correct history.
--
-- Run AFTER 096 AND 096c (096c adds the index that keeps this fast;
-- without it the per-machine scans go sequential and time out).
-- Re-aggregates all cells for ~576 buckets, ascending so the anchor
-- chain stays consistent. Safe to re-run.
-- ============================================================

SET statement_timeout = '600s';   -- backfill is one long call; lift the editor cap

SELECT aggregate_recent_buckets(interval '48 hours');
