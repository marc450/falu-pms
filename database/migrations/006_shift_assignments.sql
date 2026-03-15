-- ============================================
-- SHIFT ASSIGNMENTS
-- Manual per-day assignment of shift teams (A, B, C, D) to time slots.
-- Two 12-hour slots per day: "day" and "night".
-- ============================================

CREATE TABLE IF NOT EXISTS shift_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_date DATE NOT NULL,
    day_team   VARCHAR(20),        -- e.g. 'A', 'B', 'C', 'D' or NULL (unassigned)
    night_team VARCHAR(20),        -- e.g. 'A', 'B', 'C', 'D' or NULL (unassigned)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (shift_date)
);

CREATE INDEX IF NOT EXISTS idx_shift_assignments_date
    ON shift_assignments (shift_date);

-- RLS
ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read shift_assignments"
    ON shift_assignments FOR SELECT TO anon USING (true);

CREATE POLICY "Allow authenticated full access shift_assignments"
    ON shift_assignments FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow service_role full access shift_assignments"
    ON shift_assignments FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Trigger for updated_at
CREATE TRIGGER set_shift_assignments_updated_at
    BEFORE UPDATE ON shift_assignments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Seed default shift config into app_settings
-- Teams: A, B, C, D.  Day shift starts at 06:00.
INSERT INTO app_settings (key, value)
VALUES ('shift_config', '{"teams": ["A", "B", "C", "D"], "dayShiftStartHour": 6}')
ON CONFLICT (key) DO NOTHING;
