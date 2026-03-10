-- ============================================
-- FALU PMS - Production Monitoring System
-- Initial Database Schema
-- ============================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- MACHINES TABLE
-- Stores metadata about each production machine
-- ============================================
CREATE TABLE machines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_code VARCHAR(50) UNIQUE NOT NULL,       -- e.g., "MACHINE-01"
    name VARCHAR(255) NOT NULL,                      -- Human-readable name
    location VARCHAR(255),                           -- Factory floor location
    line VARCHAR(100),                               -- Production line identifier
    mqtt_topic VARCHAR(255),                         -- MQTT topic this machine publishes to
    status VARCHAR(20) DEFAULT 'offline'             -- online, offline, maintenance
        CHECK (status IN ('online', 'offline', 'maintenance')),
    metadata JSONB DEFAULT '{}',                     -- Flexible field for extra machine info
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PRODUCTION_READINGS TABLE
-- Time-series data from each machine
-- ============================================
CREATE TABLE production_readings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When the reading was taken

    -- Time metrics (in seconds or minutes — define unit in your MQTT payload)
    production_time NUMERIC,
    downtime NUMERIC,

    -- Speed
    machine_speed NUMERIC,

    -- Production counts
    cotton_tears INTEGER DEFAULT 0,
    produced_swabs INTEGER DEFAULT 0,
    packed_swabs INTEGER DEFAULT 0,
    produced_boxes INTEGER DEFAULT 0,
    produced_boxes_extra_layer INTEGER DEFAULT 0,
    rejected_swabs INTEGER DEFAULT 0,

    -- Error counts
    faulty_pickups INTEGER DEFAULT 0,
    error_stops INTEGER DEFAULT 0,

    -- Calculated ratios (0.0 to 1.0 or percentage)
    efficiency NUMERIC,
    scrap_rate NUMERIC,

    -- Raw JSON payload for reference/debugging
    raw_payload JSONB,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast time-range queries per machine
CREATE INDEX idx_readings_machine_time
    ON production_readings (machine_id, recorded_at DESC);

-- Index for dashboard queries (latest readings)
CREATE INDEX idx_readings_recorded_at
    ON production_readings (recorded_at DESC);

-- ============================================
-- ALERTS TABLE
-- Threshold-based alerts for monitoring
-- ============================================
CREATE TABLE alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    alert_type VARCHAR(50) NOT NULL,                 -- e.g., "high_scrap_rate", "machine_down"
    severity VARCHAR(20) DEFAULT 'warning'
        CHECK (severity IN ('info', 'warning', 'critical')),
    message TEXT,
    reading_id UUID REFERENCES production_readings(id),
    acknowledged BOOLEAN DEFAULT FALSE,
    acknowledged_by VARCHAR(255),
    acknowledged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_machine ON alerts (machine_id, created_at DESC);
CREATE INDEX idx_alerts_unacknowledged ON alerts (acknowledged, created_at DESC)
    WHERE acknowledged = FALSE;

-- ============================================
-- SHIFT_SUMMARIES TABLE
-- Aggregated data per shift for reporting
-- ============================================
CREATE TABLE shift_summaries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    machine_id UUID NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    shift_date DATE NOT NULL,
    shift_name VARCHAR(50) NOT NULL,                 -- e.g., "morning", "afternoon", "night"
    shift_start TIMESTAMPTZ NOT NULL,
    shift_end TIMESTAMPTZ NOT NULL,

    -- Aggregated metrics
    total_production_time NUMERIC,
    total_downtime NUMERIC,
    avg_speed NUMERIC,
    total_cotton_tears INTEGER DEFAULT 0,
    total_produced_swabs INTEGER DEFAULT 0,
    total_packed_swabs INTEGER DEFAULT 0,
    total_produced_boxes INTEGER DEFAULT 0,
    total_produced_boxes_extra_layer INTEGER DEFAULT 0,
    total_rejected_swabs INTEGER DEFAULT 0,
    total_faulty_pickups INTEGER DEFAULT 0,
    total_error_stops INTEGER DEFAULT 0,
    avg_efficiency NUMERIC,
    avg_scrap_rate NUMERIC,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(machine_id, shift_date, shift_name)
);

-- ============================================
-- ROW LEVEL SECURITY POLICIES
-- ============================================
ALTER TABLE machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_summaries ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read all data
CREATE POLICY "Authenticated users can view machines"
    ON machines FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can view readings"
    ON production_readings FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can view alerts"
    ON alerts FOR SELECT
    TO authenticated
    USING (true);

CREATE POLICY "Authenticated users can view shift summaries"
    ON shift_summaries FOR SELECT
    TO authenticated
    USING (true);

-- Allow service role (MQTT bridge) to insert data
CREATE POLICY "Service role can insert readings"
    ON production_readings FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "Service role can manage machines"
    ON machines FOR ALL
    TO service_role
    USING (true);

CREATE POLICY "Service role can insert alerts"
    ON alerts FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "Service role can insert shift summaries"
    ON shift_summaries FOR ALL
    TO service_role
    USING (true);

-- Allow authenticated users to acknowledge alerts
CREATE POLICY "Authenticated users can update alerts"
    ON alerts FOR UPDATE
    TO authenticated
    USING (true)
    WITH CHECK (true);

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
