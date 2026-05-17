-- ============================================================
-- Migration 087: push instead of poll for tablet error state
-- ============================================================
-- The tablet kiosk currently polls error_events + machines.status
-- every 3 seconds. Worst-case lag between the bridge writing an
-- error event and the operator's screen flipping to the error
-- view is ~3 s, and the polling burns ~28k DB reads per tablet
-- per day for the >99% of ticks where nothing changed.
--
-- Adding the tables to supabase_realtime publishes their writes
-- to Supabase's Realtime broker. The tablet subscribes by
-- machine_id (UUID); INSERT/UPDATE events arrive over a
-- persistent WebSocket within <100ms. Lag goes from up to 3 s
-- to ~50 ms, polling load drops to one query at session start.
--
-- RLS already grants SELECT on both tables to anon/authenticated
-- (001 + 071 + 080) so Realtime's row-level filter inherits
-- correctly.
--
-- Idempotent: pg_publication_tables check before ADD so re-runs
-- don't error.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE  pubname  = 'supabase_realtime'
      AND  tablename = 'error_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE error_events;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE  pubname  = 'supabase_realtime'
      AND  tablename = 'machines'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE machines;
  END IF;
END $$;
