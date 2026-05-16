-- ============================================================
-- Migration 080: anon read access for the tablet kiosk
-- ============================================================
-- The tablet kiosk uses the Supabase anon key (no per-user login)
-- to validate its token, render the cell ranking, and look up
-- active error events. Migration 079 assumed anon already had
-- SELECT on the relevant tables; it does not, so the kiosk page
-- shows "Unknown device" for valid tokens.
--
-- This migration adds the four read policies the kiosk needs. All
-- four tables hold operational data already visible to every
-- authenticated user; no sensitive customer information is on
-- these rows.
-- ============================================================

DROP POLICY IF EXISTS "anon_read_machines" ON machines;
CREATE POLICY  "anon_read_machines"
  ON machines FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_production_cells" ON production_cells;
CREATE POLICY  "anon_read_production_cells"
  ON production_cells FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_error_events" ON error_events;
CREATE POLICY  "anon_read_error_events"
  ON error_events FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "anon_read_plc_error_codes" ON plc_error_codes;
CREATE POLICY  "anon_read_plc_error_codes"
  ON plc_error_codes FOR SELECT TO anon USING (true);
