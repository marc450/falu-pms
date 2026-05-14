-- ============================================
-- FALU PMS - Production Monitoring System
-- Database Schema (aligned with MQTT payload)
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- MACHINES
-- ============================================
CREATE TABLE machines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255),
    line VARCHAR(100),
    status VARCHAR(20) DEFAULT 'offline'
        CHECK (status IN ('run', 'idle', 'error', 'offline')),
    error_message TEXT,
    active_shift INTEGER DEFAULT 1 CHECK (active_shift BETWEEN 1 AND 3),
    speed BIGINT DEFAULT 0,
    current_swaps BIGINT DEFAULT 0,
    current_boxes BIGINT DEFAULT 0,
    current_efficiency DOUBLE PRECISION DEFAULT 0,
    current_reject DOUBLE PRECISION DEFAULT 0,
    last_sync_status TIMESTAMPTZ,
    last_sync_shift TIMESTAMPTZ,
    mqtt_topic VARCHAR(255),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SHIFT_READINGS
-- Per-shift production data (Shift 1, 2, 3, Total=4)
-- ============================================
CREATE TABLE shift_readings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    shift_number INTEGER NOT NULL CHECK (shift_number BETWEEN 1 AND 4),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Time metrics (in minutes)
    production_time BIGINT DEFAULT 0,
    idle_time BIGINT DEFAULT 0,

    -- Error counts
    cotton_tears BIGINT DEFAULT 0,
    missing_sticks BIGINT DEFAULT 0,
    faulty_pickups BIGINT DEFAULT 0,
    other_errors BIGINT DEFAULT 0,

    -- Production counts
    produced_swabs BIGINT DEFAULT 0,
    packaged_swabs BIGINT DEFAULT 0,
    produced_boxes BIGINT DEFAULT 0,
    produced_boxes_layer_plus BIGINT DEFAULT 0,
    discarded_swabs BIGINT DEFAULT 0,

    -- Calculated ratios (percentage, e.g. 95.5)
    efficiency DOUBLE PRECISION DEFAULT 0,
    reject_rate DOUBLE PRECISION DEFAULT 0,

    -- Save flag from PLC
    save_flag BOOLEAN DEFAULT FALSE,

    -- Raw MQTT payload
    raw_payload JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shift_readings_machine_shift
    ON shift_readings (machine_id, shift_number, recorded_at DESC);

CREATE INDEX idx_shift_readings_recorded
    ON shift_readings (recorded_at DESC);

CREATE INDEX idx_shift_readings_saved
    ON shift_readings (save_flag, recorded_at DESC)
    WHERE save_flag = TRUE;

-- ============================================
-- SAVED_SHIFT_LOGS
-- Only rows where Save=true (PLC-triggered persistence)
-- This is the Supabase equivalent of the CSV logs
-- ============================================
CREATE TABLE saved_shift_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    machine_code VARCHAR(50) NOT NULL,
    shift_number INTEGER NOT NULL,
    production_time BIGINT DEFAULT 0,
    idle_time BIGINT DEFAULT 0,
    cotton_tears BIGINT DEFAULT 0,
    missing_sticks BIGINT DEFAULT 0,
    faulty_pickups BIGINT DEFAULT 0,
    other_errors BIGINT DEFAULT 0,
    produced_swabs BIGINT DEFAULT 0,
    packaged_swabs BIGINT DEFAULT 0,
    produced_boxes BIGINT DEFAULT 0,
    produced_boxes_layer_plus BIGINT DEFAULT 0,
    discarded_swabs BIGINT DEFAULT 0,
    efficiency DOUBLE PRECISION DEFAULT 0,
    reject_rate DOUBLE PRECISION DEFAULT 0,
    saved_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_saved_logs_machine ON saved_shift_logs (machine_code, saved_at DESC);

-- ============================================
-- APP SETTINGS (broker config, persisted in DB)
-- ============================================
CREATE TABLE app_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default broker settings
INSERT INTO app_settings (key, value) VALUES
('broker', '{
    "host": "e21df7393cc24e69b198158d3af2b3d6.s1.eu.hivemq.cloud",
    "port": 8883,
    "username": "mqtt-user",
    "password": "Admin123",
    "isLocal": false
}'::jsonb),
('enabled_machines', '[]'::jsonb);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_shift_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Read access for authenticated users
CREATE POLICY "auth_read_machines" ON machines FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_readings" ON shift_readings FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_logs" ON saved_shift_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_read_settings" ON app_settings FOR SELECT TO authenticated USING (true);

-- Write access for service role (MQTT bridge)
CREATE POLICY "service_write_machines" ON machines FOR ALL TO service_role USING (true);
CREATE POLICY "service_write_readings" ON shift_readings FOR ALL TO service_role USING (true);
CREATE POLICY "service_write_logs" ON saved_shift_logs FOR ALL TO service_role USING (true);
CREATE POLICY "service_write_settings" ON app_settings FOR ALL TO service_role USING (true);

-- Allow authenticated users to update settings (for admin UI)
CREATE POLICY "auth_write_settings" ON app_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ============================================
-- UPDATED_AT TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER machines_updated_at
    BEFORE UPDATE ON machines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER settings_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
