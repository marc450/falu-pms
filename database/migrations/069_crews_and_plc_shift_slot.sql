-- ============================================================
-- Migration 069: Crews lookup table and plc_shift_slot rename
-- ============================================================
-- Two cleanups bundled because they're both about making the
-- shift/crew model less ambiguous:
--
-- A. New `crews` lookup table
--    `shift_crew` is stored as free text across shift_readings,
--    saved_shift_logs, error_events, error_shift_summary,
--    hourly_analytics, daily_machine_summary. Migration 049
--    already had to fix casing drift ("Shift A" vs "SHIFT A").
--    Adding a canonical lookup table gives every write path a
--    single source of truth to validate against. No foreign key
--    is added to fact tables (that would be a much bigger
--    refactor) but admin UIs and the bridge can now source the
--    canonical list from here.
--
-- B. Rename machines.active_shift -> machines.plc_shift_slot
--    The PLC hardware always reports 3 slots regardless of the
--    factory's configured shift system. The current name reads
--    like "the currently active business shift" which is
--    misleading. The rename makes the meaning explicit: this is
--    the PLC's 1/2/3 slot, not a business concept.
--    The PLC MQTT contract is unchanged: the payload still uses
--    `Shift`. Only this DB column and the bridge/frontend code
--    that reads it are renamed.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- Section 1: Crews lookup table
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crews (
  name          VARCHAR(50)   PRIMARY KEY,      -- canonical value, e.g. 'SHIFT A'
  display_name  VARCHAR(100),                   -- optional UI-friendly label
  color         VARCHAR(7),                     -- optional hex color for dashboard badges
  active        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Seed from the crew names that already exist in the fact tables.
-- Migration 049 normalised casing, so these values are the canonical
-- ones in use today.
INSERT INTO crews (name)
SELECT DISTINCT shift_crew
FROM shift_readings
WHERE shift_crew IS NOT NULL
  AND shift_crew <> ''
  AND shift_crew <> 'Unassigned'
ON CONFLICT (name) DO NOTHING;

INSERT INTO crews (name)
SELECT DISTINCT shift_crew
FROM saved_shift_logs
WHERE shift_crew IS NOT NULL
  AND shift_crew <> ''
  AND shift_crew <> 'Unassigned'
ON CONFLICT (name) DO NOTHING;

-- 'Unassigned' is a sentinel used by the bridge when no crew is
-- resolvable. Include it so UIs can show it as a real option.
INSERT INTO crews (name, display_name)
VALUES ('Unassigned', 'Unassigned')
ON CONFLICT (name) DO NOTHING;

-- Row level security: readable by anyone who can read the rest
-- of the schema, writable by authenticated admins and the
-- service role (bridge).
ALTER TABLE crews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read crews"
    ON crews FOR SELECT TO anon USING (true);

CREATE POLICY "Allow authenticated full access crews"
    ON crews FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow service_role full access crews"
    ON crews FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at trigger using the existing shared function
CREATE TRIGGER crews_updated_at
    BEFORE UPDATE ON crews
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();


-- ────────────────────────────────────────────────────────────
-- Section 2: Rename machines.active_shift -> plc_shift_slot
-- ────────────────────────────────────────────────────────────
-- The CHECK constraint (originally "BETWEEN 1 AND 3") is
-- automatically updated by Postgres to reference the new column
-- name. The constraint's own name stays as machines_active_shift_check;
-- that's cosmetic, not worth renaming.

ALTER TABLE machines RENAME COLUMN active_shift TO plc_shift_slot;

COMMIT;
