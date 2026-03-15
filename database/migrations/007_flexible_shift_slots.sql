-- ============================================
-- Flexible shift slots
-- Replace fixed day_team / night_team with a JSONB array
-- that supports 2, 3, or more slots per day.
-- ============================================

-- Add the flexible column
ALTER TABLE shift_assignments
    ADD COLUMN IF NOT EXISTS slot_teams JSONB DEFAULT '[]';

-- Migrate existing data (day_team → index 0, night_team → index 1)
UPDATE shift_assignments
SET slot_teams = jsonb_build_array(day_team, night_team)
WHERE (day_team IS NOT NULL OR night_team IS NOT NULL)
  AND (slot_teams IS NULL OR slot_teams = '[]'::jsonb);

-- Update shift_config default to use slots array
UPDATE app_settings
SET value = jsonb_set(
    jsonb_set(
        value,
        '{slots}',
        '[{"name": "Day", "startHour": 6}, {"name": "Night", "startHour": 18}]'::jsonb
    ),
    '{plannedDowntimeMinutes}',
    '0'::jsonb
)
WHERE key = 'shift_config'
  AND NOT (value ? 'slots');
