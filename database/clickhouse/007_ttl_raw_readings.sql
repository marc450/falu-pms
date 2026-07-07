-- ============================================================
-- ClickHouse — retention TTL on raw shift_readings
-- ============================================================
-- Bounds disk growth on the self-hosted Railway ClickHouse. Raw 5s readings
-- are the bulky part (each keeps a full raw_payload JSON copy) and exist only
-- for debugging / replay. The KPI rollups the dashboards actually read live in
-- the incremental MV agg_bucket_5m (5m/1h/1d tiers) and are kept FOREVER, so
-- expiring raw rows changes no KPI value. Only 5-second-grain zoom (short-
-- window only) on data older than the TTL is affected — nothing queries that.
--
-- TTL keys on ingested_at (server arrival: always present + reliable; the PLC
-- clock is hand-set/nullable). It aligns with PARTITION BY toYYYYMM(ingested_at),
-- so expiry drops whole monthly partitions cheaply.
--
-- error_events is deliberately NOT given a TTL — it is the long-term downtime
-- history store (see 005).
--
-- Retention: 6 months of raw. Change the INTERVAL below to adjust.
-- ============================================================

-- toDateTime() cast is required: TTL expressions must resolve to Date/DateTime,
-- and ingested_at is DateTime64(3) (millisecond precision). Seconds precision is
-- plenty for a 6-month retention boundary.
ALTER TABLE shift_readings
    MODIFY TTL toDateTime(ingested_at) + INTERVAL 6 MONTH;
