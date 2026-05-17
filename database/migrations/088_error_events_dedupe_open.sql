-- ============================================================
-- Migration 088: stop duplicate open error_events rows
-- ============================================================
-- The bridge inserts an error_events row on each Error/CB
-- ErrorStatus=true message. Its idempotency guard
--   `if (!m.openErrorEvents[code]) { await insert; map[code] = id; }`
-- has a race window between the check and the map write.
-- MQTT QoS-1 redelivers messages whose ack is slow, so the
-- bridge can see the same INSERT-trigger twice within
-- milliseconds. Both pass the JS check, both INSERT, the second
-- becomes an orphan with ended_at=NULL forever — and the kiosk
-- renders two cards for one event.
--
-- Two-part fix:
-- 1. Close existing orphans by setting ended_at to the next
--    same-(machine,code) row's started_at — that's roughly
--    when the event "really" ended even if this specific row
--    never got the update. Orphans with no successor stay
--    open (they might still be active).
-- 2. Add a partial unique index that blocks future duplicates
--    at the DB level. The bridge will catch the 23505 and
--    use the existing row's id instead of inserting again.
-- ============================================================

-- ── A. Close orphans where a same-(machine,code) row exists later ──────────
UPDATE error_events ee
SET    ended_at      = succ.started_at,
       duration_secs = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (succ.started_at - ee.started_at))))::int
FROM (
  SELECT a.id AS orphan_id,
         (SELECT MIN(b.started_at)
          FROM   error_events b
          WHERE  b.machine_id = a.machine_id
            AND  b.error_code = a.error_code
            AND  b.started_at > a.started_at) AS started_at
  FROM   error_events a
  WHERE  a.ended_at IS NULL
) succ
WHERE  ee.id = succ.orphan_id
  AND  succ.started_at IS NOT NULL;


-- ── B. Partial unique index on the open events ─────────────────────────────
-- (machine_id, error_code) is unique while the event is open. Closed events
-- (ended_at IS NOT NULL) are excluded — many sequential events for the same
-- code per shift are normal.
CREATE UNIQUE INDEX IF NOT EXISTS error_events_open_unique_idx
  ON error_events (machine_id, error_code)
  WHERE ended_at IS NULL;
