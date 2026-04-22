-- ============================================================
-- Migration 070: Remove stray columns from app_settings
-- ============================================================
-- Schema drift cleanup. The columns bu_warning_threshold and
-- bu_target_threshold were added to the live database outside
-- the migration history (most likely via the Supabase UI). They
-- are not referenced by any code in the repository (frontend,
-- bridge, migrations, or RPCs) and have been sitting unused with
-- their defaults (50 and 100).
--
-- app_settings is meant to be a pure key/value config store. The
-- threshold rows that ARE in use live as JSONB values under the
-- keys 'threshold_efficiency', 'threshold_scrap', 'threshold_bu'
-- (seeded in migration 002). The two stray columns duplicate no
-- functionality and confuse the table's intent.
--
-- Run the precheck query first:
--   SELECT key, bu_warning_threshold, bu_target_threshold
--   FROM app_settings
--   WHERE bu_warning_threshold IS DISTINCT FROM 50
--      OR bu_target_threshold  IS DISTINCT FROM 100;
-- If it returns zero rows, the drop below is fully lossless. If
-- it returns anything, stop and migrate those values into a
-- key-value row before proceeding.
--
-- Lesson for the project going forward: all schema changes must
-- land via a migration file in database/migrations/, never via
-- the Supabase UI. This migration fixes this one instance but
-- a broader audit is warranted to find any other drift.
-- ============================================================

BEGIN;

ALTER TABLE app_settings DROP COLUMN IF EXISTS bu_warning_threshold;
ALTER TABLE app_settings DROP COLUMN IF EXISTS bu_target_threshold;

COMMIT;
