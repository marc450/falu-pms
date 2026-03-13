-- ============================================
-- Migration 002: Fix app_settings RLS + seed threshold rows
-- ============================================
-- The initial schema only granted authenticated users UPDATE on app_settings.
-- Supabase upsert uses INSERT ... ON CONFLICT DO UPDATE, so INSERT permission
-- is also required. Without it, saving thresholds the first time (when no row
-- exists yet) silently fails, causing values to revert to defaults on reload.
-- ============================================

-- Grant INSERT permission to authenticated users on app_settings
CREATE POLICY "auth_insert_settings" ON app_settings
    FOR INSERT TO authenticated WITH CHECK (true);

-- Seed default threshold rows so upsert only ever needs UPDATE going forward.
-- ON CONFLICT DO NOTHING means this is safe to re-run.
INSERT INTO app_settings (key, value) VALUES
    ('threshold_efficiency', '{"good": 85, "mediocre": 70}'::jsonb),
    ('threshold_scrap',      '{"good": 2,  "mediocre": 5}'::jsonb),
    ('threshold_bu',         '{"good": 1400, "mediocre": 800, "shiftLengthMinutes": 480, "plannedDowntimeMinutes": 0}'::jsonb)
ON CONFLICT (key) DO NOTHING;
