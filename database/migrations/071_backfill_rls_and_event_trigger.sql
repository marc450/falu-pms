-- ============================================================
-- Migration 071: Backfill RLS function, event trigger, ENABLE RLS
--                statements, and missing policies
-- ============================================================
-- Final drift-capture migration. Closes the remaining gaps that
-- migrations 013b and 070 did not cover. After this, a fresh
-- from-scratch customer deployment built from database/migrations/
-- alone produces a schema that matches prod in its RLS posture.
--
-- What this migration captures
-- ----------------------------
-- 1. The custom event-trigger function rls_auto_enable() and the
--    ensure_rls event trigger that wires it up. This function
--    automatically enables row level security on every new table
--    created in the public schema. It's defense-in-depth for
--    future migrations and for anything ever created outside
--    them.
--
-- 2. Explicit ALTER TABLE ... ENABLE ROW LEVEL SECURITY for four
--    tables whose CREATE TABLE migrations omitted it:
--      - plc_error_codes  (migration 054)
--      - error_events     (migration 055)
--      - error_shift_summary (migration 055)
--      - production_cells (no create migration until 013b)
--    Prod currently has RLS enabled on all of these (per the
--    ensure_rls trigger firing at their creation time). This
--    migration makes the enable explicit so it doesn't depend on
--    the trigger being installed first in a fresh build.
--
-- 3. Eight policies that exist in prod but were never introduced
--    through a migration file:
--      - machines.auth_update_machines
--      - plc_error_codes."Allow public read access on plc_error_codes"
--      - error_events."Allow read access"
--      - error_shift_summary."Allow read access"
--      - production_cells.auth_read / auth_insert / auth_update / auth_delete
--
-- Idempotency
-- -----------
-- CREATE OR REPLACE FUNCTION, DROP EVENT TRIGGER IF EXISTS +
-- CREATE EVENT TRIGGER, ALTER TABLE ENABLE RLS (no-op when
-- already enabled), DROP POLICY IF EXISTS + CREATE POLICY.
-- Safe to run on prod (no-op) and on a fresh build (establishes
-- the final RLS posture).
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- Section 1: Custom event trigger that auto-enables RLS on any
-- new public-schema table. Copied verbatim from prod.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL
        AND cmd.schema_name IN ('public')
        AND cmd.schema_name NOT IN ('pg_catalog','information_schema')
        AND cmd.schema_name NOT LIKE 'pg_toast%'
        AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

DROP EVENT TRIGGER IF EXISTS ensure_rls;
CREATE EVENT TRIGGER ensure_rls
  ON ddl_command_end
  EXECUTE FUNCTION public.rls_auto_enable();


-- ────────────────────────────────────────────────────────────
-- Section 2: Explicit ENABLE RLS on tables whose create
-- migrations omitted it. No-op where already enabled.
-- ────────────────────────────────────────────────────────────

ALTER TABLE plc_error_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_shift_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_cells    ENABLE ROW LEVEL SECURITY;


-- ────────────────────────────────────────────────────────────
-- Section 3: Drift policies. Each is DROP + CREATE so the
-- migration is fully idempotent.
-- ────────────────────────────────────────────────────────────

-- machines: authenticated users can UPDATE
DROP POLICY IF EXISTS "auth_update_machines" ON machines;
CREATE POLICY "auth_update_machines"
  ON machines FOR UPDATE TO public
  USING (auth.role() = 'authenticated');

-- plc_error_codes: public read (reference data)
DROP POLICY IF EXISTS "Allow public read access on plc_error_codes" ON plc_error_codes;
CREATE POLICY "Allow public read access on plc_error_codes"
  ON plc_error_codes FOR SELECT TO public
  USING (true);

-- error_events: public read
DROP POLICY IF EXISTS "Allow read access" ON error_events;
CREATE POLICY "Allow read access"
  ON error_events FOR SELECT TO public
  USING (true);

-- error_shift_summary: public read
DROP POLICY IF EXISTS "Allow read access" ON error_shift_summary;
CREATE POLICY "Allow read access"
  ON error_shift_summary FOR SELECT TO public
  USING (true);

-- production_cells: authenticated users get full CRUD
DROP POLICY IF EXISTS "auth_read" ON production_cells;
CREATE POLICY "auth_read"
  ON production_cells FOR SELECT TO public
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_insert" ON production_cells;
CREATE POLICY "auth_insert"
  ON production_cells FOR INSERT TO public
  WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_update" ON production_cells;
CREATE POLICY "auth_update"
  ON production_cells FOR UPDATE TO public
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "auth_delete" ON production_cells;
CREATE POLICY "auth_delete"
  ON production_cells FOR DELETE TO public
  USING (auth.role() = 'authenticated');

COMMIT;
