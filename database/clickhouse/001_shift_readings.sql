-- ============================================================
-- ClickHouse PoC — raw landing table for 5s machine readings
-- ============================================================
-- This is the ClickHouse mirror of Supabase's public.shift_readings.
-- It is a RAW landing table only: every reading lands here as-is.
-- Daily/shift rollups (which carry the reset-aware delta / KPI math)
-- are NOT defined here — those come in Phase 2 after explicit sign-off.
--
-- Run this in the ClickHouse Cloud SQL console once, before enabling
-- CLICKHOUSE_ENABLED=true in the bridge .env.
--
-- Notes on design choices:
--   * Physical ordering and partitioning use ingested_at (server arrival
--     time), which is ALWAYS present and reliable. The PLC clock is
--     hand-set and may be null or drift by minutes/hours, so it must NOT
--     drive the table layout.
--   * plc_timestamp is kept as a nullable column for production-time
--     analysis (durations, shift bucketing) in Phase 2.
--   * ClickHouse Cloud automatically makes MergeTree replicated/durable.
-- ============================================================

CREATE TABLE IF NOT EXISTS shift_readings
(
    machine_id                 String,
    machine_code               LowCardinality(String),
    shift_crew                 LowCardinality(String),
    status                     LowCardinality(String),

    speed                      Float64,

    production_time_seconds    Float64,            -- seconds, from PLC
    idle_time_seconds          Float64,            -- seconds, from PLC
    error_time_seconds         Float64,            -- seconds, from PLC

    cotton_tears               UInt32,
    missing_sticks             UInt32,
    faulty_pickups             UInt32,             -- maps to PLC field FaultyPickups
    other_errors               UInt32,

    produced_swabs             UInt64,
    packaged_swabs             UInt64,
    produced_boxes             UInt64,
    produced_boxes_layer_plus  UInt64,
    discarded_swabs            UInt64,             -- maps to PLC field DiscardedSwabs

    efficiency                 Float64,
    scrap_rate                 Float64,            -- PLC field: Reject

    save_flag                  UInt8,              -- end-of-shift flag

    raw_payload                String,             -- full PLC JSON payload, verbatim

    plc_timestamp              Nullable(DateTime64(3, 'UTC')),   -- hand-set PLC clock; may be null/drift
    ingested_at                DateTime64(3, 'UTC')              -- server arrival time; reliable
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (machine_id, ingested_at);

-- Live "latest reading per machine" check (used by the dashboard live view):
--   SELECT machine_code, argMax(status, ingested_at) AS status,
--          max(ingested_at) AS last_seen
--   FROM shift_readings
--   WHERE ingested_at > now() - INTERVAL 5 MINUTE
--   GROUP BY machine_code;
