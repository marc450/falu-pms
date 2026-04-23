-- ============================================================
-- Migration 013b: Backfill schema drift
-- ============================================================
-- RETROACTIVE. This migration captures schema that existed in
-- the live database but was never added through a migration file
-- (most likely created via the Supabase UI over time). It lives
-- at 013b so that it runs BEFORE migration 014, which is where
-- some of these columns are first referenced (e.g. sr.speed).
--
-- Everything below uses IF NOT EXISTS / ON CONFLICT DO NOTHING:
--   - On the existing production database: this migration is a
--     complete no-op. The drift columns and tables already exist.
--   - On a fresh build (e.g. new customer deployment): this
--     migration creates the structures that migrations 014-070
--     assume are already present.
--
-- Drift captured
-- --------------
-- 1. Table production_cells (entire table). Referenced implicitly
--    by migration 041 (INSERT INTO production_cells) and by
--    cell_id FK references in hourly_analytics and
--    daily_machine_summary. Never had a CREATE TABLE statement.
--
-- 2. machines drift columns:
--      cell_id             uuid  (FK -> production_cells.id)
--      cell_position       integer DEFAULT 0
--      display_name        text
--      packing_format      text
--      efficiency_good     numeric
--      efficiency_mediocre numeric
--      scrap_good          numeric
--      scrap_mediocre      numeric
--      bu_target           numeric DEFAULT 0
--      bu_mediocre         numeric
--
-- 3. shift_readings drift columns:
--      status       VARCHAR(20) DEFAULT 'offline'
--      speed        bigint DEFAULT 0
--      machine_code text
--
-- Not captured here (handled elsewhere / separate concern)
-- --------------------------------------------------------
--   - RLS policies on production_cells. A separate audit pass
--     will capture those. In the meantime Supabase's default
--     behavior (RLS off = authenticated can read/write) suffices
--     for a fresh build; prod already has whatever policies it
--     has and this migration does not alter them.
--   - Indexes on the drift columns. Same: separate pass.
--
-- Going forward
-- -------------
-- No schema changes via the Supabase UI. Every CREATE TABLE,
-- ADD COLUMN, constraint change, RLS policy, or function update
-- lands as a migration file in database/migrations/ before being
-- applied.
-- ============================================================

BEGIN;

-- ── 1. production_cells table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS production_cells (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  position   integer     NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Seed the sentinel row that aggregate_cell_hour (migration 041
-- onwards) uses to group machines without a real cell assignment.
INSERT INTO production_cells (id, name, position)
VALUES ('00000000-0000-0000-0000-000000000000', '__NO_CELL__', -1)
ON CONFLICT (id) DO NOTHING;


-- ── 2. machines drift columns ───────────────────────────────────
-- cell_id uses ADD COLUMN IF NOT EXISTS with an inline REFERENCES
-- clause so a fresh build gets both the column and the FK in one
-- statement. On prod the column already exists with the FK;
-- IF NOT EXISTS makes the whole statement a no-op.
ALTER TABLE machines ADD COLUMN IF NOT EXISTS cell_id             uuid REFERENCES production_cells(id);
ALTER TABLE machines ADD COLUMN IF NOT EXISTS cell_position       integer DEFAULT 0;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS display_name        text;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS packing_format      text;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS efficiency_good     numeric;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS efficiency_mediocre numeric;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS scrap_good          numeric;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS scrap_mediocre      numeric;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS bu_target           numeric DEFAULT 0;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS bu_mediocre         numeric;


-- ── 3. shift_readings drift columns ─────────────────────────────
-- status, speed, and machine_code are written by the bridge on
-- every tick and read by downsample/analytics RPCs starting at
-- migration 014.
ALTER TABLE shift_readings ADD COLUMN IF NOT EXISTS status       VARCHAR(20) DEFAULT 'offline';
ALTER TABLE shift_readings ADD COLUMN IF NOT EXISTS speed        bigint DEFAULT 0;
ALTER TABLE shift_readings ADD COLUMN IF NOT EXISTS machine_code text;

COMMIT;
