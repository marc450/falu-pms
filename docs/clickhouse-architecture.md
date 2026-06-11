# ClickHouse Architecture and Long-Term Target

Status: evaluation (PoC). This document records the intended architecture so we
do not have to re-derive it. Nothing here changes KPI calculation logic — the
rollup/KPI work is gated on explicit sign-off (see "Phases").

## Why ClickHouse at all

Today we maintain hand-built aggregate tables to make historical analytics fast
over the 5-second machine readings. ClickHouse is a columnar OLAP engine built
for exactly this: it can scan 12 months of raw readings and roll them up to
daily/shift granularity interactively, and it maintains rollups automatically
via materialized views instead of cron-built aggregate tables.

## ClickHouse is NOT a full Supabase replacement

ClickHouse replaces the **analytics** half only. It is a poor fit for the
**transactional** half, by design:

- No app auth / users / row-level security (Supabase Auth provides this).
- Single-row UPDATEs/DELETEs are heavy async "mutations", not transactions.
  Our `machines` (updated in place), `error_events` (opened then closed),
  upserts, and settings are classic OLTP and belong in Postgres.
- No foreign keys / unique constraints / point-lookup transactional guarantees.
- Not an app CRUD backend (Supabase auto-generates a REST API with auth/RLS).

Even ClickHouse sells "Postgres managed by ClickHouse" alongside ClickHouse,
because the standard pattern is: Postgres for transactions, ClickHouse for
analytics. We follow that pattern.

## What goes where

| Concern                                          | Store                |
|--------------------------------------------------|----------------------|
| Auth, users, profiles                            | Postgres (Supabase)  |
| Machine config + current/live state              | Postgres (Supabase)  |
| Error event lifecycle, settings, shift assignments | Postgres (Supabase) |
| The 5-second readings firehose                   | **ClickHouse**       |
| Historical analytics, rollups, KPI tiles/charts  | **ClickHouse**       |

The transactional side stays small and cheap (the heavy data moved out), so
Supabase shrinks to a low-tier transactional core. It does not disappear.

## Data flow

There is NO replication between the two databases. The bridge has two
independent write paths:

```
PLC --> MQTT Bridge --+--> ClickHouse   (shift_readings + analytics)
                      +--> Supabase     (machine state, errors, auth, settings)
```

- We do **not** mirror Supabase into ClickHouse (no CDC / ClickPipe needed).
  The readings are written directly to ClickHouse as their final home.
- Analytics queries display transactional context (machine name, crew,
  error-code labels) WITHOUT a mirror, via:
  - Denormalization at write time — each reading row already carries
    `machine_code`, `shift_crew`, and the full `raw_payload`.
  - Optionally syncing a few tiny reference/lookup tables into ClickHouse
    (e.g. error-code descriptions). This is copying small dimension tables,
    not mirroring the database.

## Timestamps (carried over from existing system constraints)

- PLC clocks are hand-set and may be null or drift by minutes/hours.
- `ingested_at` (server arrival time) is reliable: used for ClickHouse physical
  ordering/partitioning and for "is this machine live / stale" on the dashboard.
- `plc_timestamp` (nullable) is kept for production-time analysis (durations,
  shift bucketing) in the rollups.

## Cost / pricing alignment

- Cost is driven by ingest volume (machines x frequency) and heavy-query
  concurrency, NOT by user-account count. This aligns with per-machine pricing.
- Free/unlimited user accounts are safe as long as dashboards read from
  pre-aggregated materialized views (cheap, cached). Reserve raw full scans for
  rare ad-hoc/export use, and bound them with ClickHouse quotas / settings
  profiles per user.
- Self-host (~$30-50/mo VM) while small; managed Basic single replica ~$160/mo;
  multi-tenant on one cluster to amortize the fixed floor as customers grow.

## Phases

- **Phase 1 (done, additive):** dual-write readings into ClickHouse alongside
  Supabase, behind `CLICKHOUSE_ENABLED`. Fully reversible. Raw landing table:
  `database/clickhouse/001_shift_readings.sql`.
- **Phase 2 (gated on sign-off):** daily/shift rollup materialized views with
  the reset-aware delta math. This IS KPI calculation logic and must not be
  changed without explicit approval. Validate ClickHouse numbers against
  Supabase before relying on them.
- **Phase 3 (later):** switch dashboard reads behind a `source` flag; once
  validated, switch the bridge to write readings ONLY to ClickHouse and retire
  the Supabase readings path. Transactional tables remain in Supabase.

## Reverting

Phase 1 is config-only to disable: set `CLICKHOUSE_ENABLED=false`. To fully
remove: drop the `CLICKHOUSE_*` blocks from the bridge, delete the branch,
delete the ClickHouse service. Supabase schema/ingest were never modified.
