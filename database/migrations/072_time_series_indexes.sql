-- ============================================================
-- Migration 072: Missing time-series indexes
-- ============================================================
-- Two indexes that time-series dashboards and troubleshooting
-- queries will increasingly want as shift_readings and
-- error_events grow.
--
-- 1. shift_readings (machine_id, recorded_at DESC)
--    Migration 001 originally created idx_shift_readings_machine_shift
--    on (machine_id, shift_number, recorded_at DESC). Migration 060
--    dropped the shift_number column, which cascaded into dropping
--    that index. We lost the composite machine+time lookup
--    without noticing. Restoring it.
--    Query pattern: "last N readings for machine X"
--
-- 2. error_events (started_at DESC) WHERE ended_at IS NULL
--    Partial index for the "currently-ongoing errors" query.
--    Different shape from the existing idx_error_events_cleanup
--    which is for time-based bulk cleanup. At scale, filtering
--    active errors from a full scan gets expensive.
--    Query pattern: "give me the fleet's active errors right now"
--
-- IMPORTANT: No BEGIN/COMMIT wrapper.
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block. Using CONCURRENTLY avoids blocking writes while the
-- index builds (important for a table the bridge writes to
-- every 5 seconds).
--
-- Idempotency: IF NOT EXISTS on both, safe to re-run.
-- Failure mode: if a CREATE INDEX CONCURRENTLY fails mid-build
-- it leaves an INVALID index behind. Query to find and drop:
--   SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--   WHERE NOT i.indisvalid AND c.relname IN (
--     'shift_readings_machine_recorded_idx',
--     'error_events_active_idx'
--   );
--   DROP INDEX IF EXISTS <name>;
-- Then re-run this migration.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS shift_readings_machine_recorded_idx
  ON shift_readings (machine_id, recorded_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS error_events_active_idx
  ON error_events (started_at DESC)
  WHERE ended_at IS NULL;
