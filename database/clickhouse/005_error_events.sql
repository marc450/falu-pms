-- ============================================================
-- ClickHouse — error events landing table for Downtime Analytics
-- ============================================================
-- ClickHouse mirror of Supabase's public.error_events, but kept
-- INDEFINITELY (no TTL) so ClickHouse is the long-term downtime
-- history store. Supabase only retains error_events for 48h and
-- only persists aggregates into error_shift_summary at end-of-shift,
-- so multi-month Pareto / trend analysis is only possible here.
--
-- One row per COMPLETED error event: the bridge writes a single
-- finished fact row when the error clears (ErrorStatus=false), at
-- which point started_at, ended_at and duration_secs are all known.
-- Still-open events are not written until they close.
--
-- Bucketing mirrors the Supabase RPC get_error_shift_summary, which
-- groups by started_at::DATE — here that is toDate(started_at) in UTC.
--
-- Run this in the ClickHouse Cloud SQL console once, before relying
-- on the /api/analytics/downtime-summary endpoint.
-- ============================================================

CREATE TABLE IF NOT EXISTS error_events
(
    machine_id     String,
    machine_code   LowCardinality(String),
    error_code     LowCardinality(String),
    shift_crew     LowCardinality(String),

    started_at     DateTime64(3, 'UTC'),               -- PLC event start (hand-set clock)
    ended_at       DateTime64(3, 'UTC'),               -- PLC event clear
    duration_secs  UInt32,                             -- ended_at - started_at, from the bridge

    ingested_at    DateTime64(3, 'UTC')                -- server arrival time; reliable
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(started_at)
ORDER BY (machine_id, error_code, started_at);

-- Downtime summary (mirrors get_error_shift_summary row shape):
--   SELECT machine_id, any(machine_code) AS machine_code,
--          toString(toDate(started_at))  AS shift_date,
--          shift_crew, error_code,
--          toInt32(count())              AS occurrence_count,
--          toInt32(sum(duration_secs))   AS total_duration_secs
--   FROM error_events
--   WHERE started_at >= {start} AND started_at < {end}
--   GROUP BY machine_id, shift_date, shift_crew, error_code;
