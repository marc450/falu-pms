# FALU PMS — Go-Live Notes for US Deployment (Eastern Timezone)

Last updated: 2026-03-18

---

## Pre-Ship Checklist (complete before handing to customer)

### A. Infrastructure — stop simulation, start reality

| Step | Action | Where |
|---|---|---|
| A1 | Stop the Railway **simulator** service (the separate service running `npm run simulator`) | Railway dashboard |
| A2 | Keep the Railway **bridge** service running (`npm start` / `node src/index.js`) | Railway dashboard |
| A3 | Confirm Railway bridge env vars point to **production** Supabase (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) | Railway → Variables |
| A4 | Confirm GitHub Actions secrets match the same production Supabase project (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | GitHub → Settings → Secrets |
| A5 | Confirm `NEXT_PUBLIC_API_URL` GitHub Actions variable points to the Railway bridge URL (not localhost) | GitHub → Settings → Variables |

---

### B. Real PLC onboarding

| Step | Action |
|---|---|
| B1 | Configure each Raspberry Pi / PLC with the HiveMQ hostname, port 8883, and credentials (username + password from HiveMQ Cloud console) |
| B2 | Verify each PLC publishes to the `cloud/Shift` topic (not `local/Shift`) — the bridge subscribes to `cloud/#` |
| B3 | Confirm with the site engineer that the PLC shift clock boundaries are set to 07:00 / 19:00 **local Eastern time** on the factory floor |
| B4 | After the first real MQTT message from each machine arrives, verify a new row appears in the `machines` table in Supabase with the correct `machine_code` (PLC UID) |

---

### C. Machine configuration in Settings (first-run only)

| Step | Action |
|---|---|
| C1 | Open Settings → Machines tab; all 18 real machines should now appear with their PLC UIDs |
| C2 | Rename each machine to its human-readable label (CB-30 through CB-37, CT-1 through CT-10) using the pencil icon |
| C3 | Drag each machine into its correct production cell |
| C4 | Set speed targets, efficiency thresholds, and scrap thresholds to the agreed factory values (the bulk "Apply to all" and per-cell "Set all" controls in Settings → Targets make this faster) |

---

### D. Database cleanup (remove all demo / seed data)

Run the following SQL in the Supabase SQL editor **after** stopping the simulator and **before** any real shift begins:

```sql
-- 1. Remove all simulated shift readings
TRUNCATE shift_readings;

-- 2. Remove all downsampled analytics
TRUNCATE analytics_readings;

-- 3. Remove all saved shift log snapshots
TRUNCATE saved_shift_logs;

-- 4. Clear simulator state (no longer needed with real machines)
TRUNCATE simulator_state;

-- 5. Remove hidden / orphaned machines left over from simulator UIDs
--    (only run this AFTER real machines have connected and appear in the table)
DELETE FROM machines WHERE hidden = true;
```

> Do NOT truncate the `machines` table itself — the real machines will already be registered there after step B4.

---

### E. Verify the live dashboard

| Check | Expected result |
|---|---|
| Dashboard loads | 18 machines visible, all showing real-time status |
| Idle and error times | Numeric minutes visible (not "–") |
| BU output | Non-zero after first complete shift |
| Analytics — Fleet Trend | Data appears after the first hour of production |
| Analytics — Shift Summary | Data appears after the first complete shift |
| Settings — machine names | Human-readable names shown everywhere (dashboard, analytics, settings) |

---

## Factory Timezone

The US factory operates in **Eastern Time (ET)**.
- UTC offset in winter (EST): UTC-5
- UTC offset in summer (EDT): UTC-4

All timestamps in Supabase are stored in UTC. The adjustments below ensure
that analytics bucketing, shift boundaries, and chart labels reflect the
factory's actual local time.

---

## Required Changes Before Go-Live

### 1. Work-Day Bucketing Offset in `get_fleet_trend`

**File:** `database/migrations/` (new migration required at go-live)
**Function:** `get_fleet_trend` — currently deployed in Supabase

**Current code (migration 016, calibrated for USC 07:00 shift start):**
```sql
DATE_TRUNC('day', recorded_at - interval '7 hours')
```

**What it means now:**
USC runs 12-hour shifts starting at 07:00 / 19:00.
The offset `- 7 hours` puts the work-day boundary at 07:00 UTC, which is
correct as long as the simulator/bridge timestamps are stored in UTC and
the factory clock is also effectively UTC (Railway runs in UTC).

**For a US Eastern factory (UTC-5 winter / UTC-4 summer):**
Shift Night ends at 07:00 EST = 12:00 UTC (winter) / 11:00 UTC (summer).
A simple hardcoded offset would need to be `- 12 hours` (winter) or
`- 11 hours` (summer) — wrong for half the year.

**Recommended fix (DST-aware, using Postgres timezone support):**
```sql
DATE_TRUNC('day', (recorded_at AT TIME ZONE 'America/New_York') - interval '7 hours')
```
This localises the timestamp to Eastern time first, then applies the
`- 7 hours` shift-boundary offset in local time, so DST transitions are
handled automatically year-round.

`downsample_to_analytics` does NOT need this change — it stores UTC 5-minute
buckets and work-day attribution happens in `get_fleet_trend` when reading
from `analytics_readings`.

---

### 2. Hourly Chart Label Timezone

**File:** `frontend/src/app/analytics/page.tsx`

**Current behavior:**
The DB returns bucket keys like `"2026-03-18T14"` meaning 14:00 UTC.
The frontend displays this as `14:00`. A viewer in Ohio would see `14:00`
but the factory clock at that moment reads `09:00 EST`.

**Required change:**
When formatting hourly bucket labels, subtract the factory UTC offset before
displaying, or append the timezone abbreviation so the label reads `09:00 ET`.

**Relevant function (line ~80):**
```ts
function fmtBucket(key: string, granularity: "hour" | "day"): string {
  if (granularity === "hour") return format(parseISO(key + ":00:00"), "HH:mm");
  ...
}
```

**Fix:**
Parse the UTC hour, apply the factory offset, and display with label:
```ts
// Factory UTC offset in hours (negative = behind UTC)
const FACTORY_UTC_OFFSET_HOURS = -5; // EST winter; change to -4 for EDT or make dynamic

function fmtBucket(key: string, granularity: "hour" | "day"): string {
  if (granularity === "hour") {
    const utcDate = parseISO(key + ":00:00Z");
    const localDate = new Date(utcDate.getTime() + FACTORY_UTC_OFFSET_HOURS * 3_600_000);
    return format(localDate, "HH:mm") + " ET";
  }
  ...
}
```

Or, more robustly, use `date-fns-tz`:
```ts
import { utcToZonedTime, format as formatTz } from "date-fns-tz";
const FACTORY_TZ = "America/New_York";
const zonedDate = utcToZonedTime(parseISO(key + ":00:00Z"), FACTORY_TZ);
return formatTz(zonedDate, "HH:mm zzz", { timeZone: FACTORY_TZ });
```

---

### 3. `downsample_to_analytics` — 5-Minute Bucket Alignment

**File:** `database/functions/downsample_to_analytics.sql`

**Current code:**
```sql
date_trunc('hour', sr.recorded_at)
  + (FLOOR(EXTRACT(EPOCH FROM (sr.recorded_at - date_trunc('hour', sr.recorded_at))) / 300)
     * INTERVAL '5 minutes') AS bucket_start
```

This truncates to the hour in UTC, then computes the 5-minute slot within
that hour. For a US Eastern factory the hour boundaries are off by 5 hours
but the 5-minute buckets within each hour remain consistent. Impact is low
for intra-shift analytics, but for daily rollup this should also use:
```sql
date_trunc('hour', sr.recorded_at AT TIME ZONE 'America/New_York')
```

---

### 4. Shift Number Logic (MQTT Bridge)

**File:** `mqtt-bridge/src/index.js`

The bridge detects shift changes by comparing `data.Shift` in the MQTT payload.
Shift numbers come from the PLC/simulator. No timezone change needed here
since the PLC manages its own shift clock. Verify with the site engineer that
the PLC shift boundaries (06:00 / 18:00) are set to local Eastern time on the
factory floor.

---

### 5. pg_cron Schedule for `downsample_to_analytics`

**Current schedule:** `5 * * * *` (every hour at :05, UTC)

Supabase pg_cron always runs in UTC. No change needed. The function runs
hourly regardless of the factory timezone.

---

## Summary Table

| Area | Change needed | Priority |
|---|---|---|
| Stop simulator Railway service | Operational — stop before first real shift | Critical |
| PLC HiveMQ credentials | Configure each Pi/PLC before factory start | Critical |
| DB demo data cleanup | Truncate shift_readings, analytics_readings, saved_shift_logs, simulator_state | Critical |
| Application monitoring | Build monitoring system to detect and alert on service failures (see section below) | Critical |
| Independent MQTT logger service | Deploy a separate Railway service that subscribes directly to HiveMQ and writes every raw message to `mqtt_raw_log` in Supabase — independent of the bridge so data is never lost during bridge failures (see section below) | Critical |
| Machine naming + cell assignment | Settings UI after first real MQTT message | High |
| Production targets and thresholds | Settings → Targets after naming | High |
| `get_fleet_trend` — daily bucket | Replace `- interval '7 hours'` with `AT TIME ZONE 'America/New_York' - interval '7 hours'` | High — affects daily chart correctness |
| Hourly label display | Apply factory UTC offset in `fmtBucket` | Medium — cosmetic but confusing without it |
| `downsample_to_analytics` — bucket alignment | Apply `AT TIME ZONE` to hour truncation | Low — minor alignment only |
| MQTT bridge shift detection | No code change — verify PLC clock is in ET | Operational check |
| pg_cron schedule | No change needed | None |

---

## Application Monitoring

Before handing the system to the customer, a monitoring solution must be in place so that any failure in the data pipeline is detected and reported immediately rather than silently losing production data (as happened with the Railway redeploy incident on 2026-03-19).

### What needs to be monitored

| Component | Failure mode | Impact |
|---|---|---|
| Railway Bridge service | Crashes or is killed (SIGTERM on redeploy) | No data written to shift_readings |
| Railway Simulator service | Crashes with unhandled error | No MQTT messages published |
| HiveMQ MQTT broker | Connection dropped | Bridge receives no data |
| Supabase | Insert failures (missing column, RLS, quota) | Silent data gap |
| GitHub Pages / frontend | Failed deploy | Dashboard inaccessible |

### Recommended approach

**1. Uptime monitoring with alerting (e.g. Better Uptime, UptimeRobot, or Checkly)**
- Monitor the Railway Bridge health endpoint: `GET /api/health`
- Expected response: `{ "status": "ok", "mqttConnected": true }`
- Alert via email or SMS if the endpoint is unreachable or returns `mqttConnected: false`
- Check interval: every 1 minute

**2. Data freshness check**
- Set up a scheduled query (e.g. via Supabase pg_cron or an external cron) that checks whether a new `shift_readings` row has been inserted in the last 2 minutes during active shift hours
- If no new row exists, fire an alert — this catches silent insert failures even when the bridge appears healthy

**3. Railway deployment notifications**
- Enable Railway deployment webhooks or email notifications so any crash or redeploy is immediately visible

**4. Error log alerting**
- Configure Railway log drain to forward `[ERROR]` lines to a notification channel (Slack, email, or PagerDuty) so errors like `shift_readings insert failed` are surfaced in real time rather than discovered after the fact

---

## Independent MQTT Logger Service

The bridge is the only component that currently receives and persists MQTT data. If it crashes, restarts, or has a schema mismatch, production data is silently lost for the duration of the outage. An independent logger eliminates this single point of failure.

### Architecture

```
Raspberry Pi / PLC
      │
      ▼
   HiveMQ (cloud broker)
      │
      ├──► Bridge service (existing) ──► machines table + shift_readings
      │
      └──► Logger service (new)      ──► mqtt_raw_log table (raw backup)
```

The logger service has no knowledge of the bridge. It connects to HiveMQ independently and writes every message to `mqtt_raw_log`. If the bridge is down, the logger keeps running. Once the bridge is restored, any gap in `shift_readings` can be replayed from `mqtt_raw_log`.

### What needs to be built

**1. Supabase table `mqtt_raw_log`**
```sql
CREATE TABLE IF NOT EXISTS mqtt_raw_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  topic       text        NOT NULL,
  payload     jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS mqtt_raw_log_recorded_at_idx
  ON mqtt_raw_log (recorded_at DESC);

SELECT cron.schedule(
  'purge-mqtt-raw-log',
  '0 3 * * *',
  $$DELETE FROM mqtt_raw_log WHERE recorded_at < now() - interval '7 days';$$
);
```

**2. New Railway service `mqtt-logger/`**
- Separate folder in the repo (`mqtt-logger/src/index.js`)
- Connects to HiveMQ using the same credentials as the bridge
- Subscribes to `cloud/#`
- On every message: inserts `{ topic, payload, recorded_at }` into `mqtt_raw_log`
- No shift detection, no machine state, no REST API — single responsibility
- Deployed as a second Railway service pointing at the same repo

**3. Replay script**
- A one-off Node.js script (`mqtt-logger/scripts/replay.js`) that reads rows from `mqtt_raw_log` within a given time range and re-inserts them into `shift_readings` via the same logic as the bridge
- Run manually after any bridge outage to fill gaps in `shift_readings`

---

## Engineering Hardening Before Corporate Rollout

The items below are platform-level — they apply to any factory deployment, not just the US Cotton site. Most are inexpensive to add now and become very expensive to retrofit once a corporate customer is live.

### Tier 1 — block on these before a corporate signs

| Area | Why it matters | What "done" looks like |
|---|---|---|
| Error monitoring on every runtime (Next app + mqtt-bridge) | Today a crash or silent exception reaches us only when a user calls. Sentry (or equivalent) surfaces the stack trace within seconds. This is distinct from the uptime checks above — that catches "the process is down", this catches "the process is up but throwing for one user". | Sentry DSN configured in both apps, source maps uploaded on each deploy, alert rules going to a real channel (email or Slack). |
| Automated tests for KPI math | 75 migrations plus known quirks (run_hours stored as minutes, bu_normalized depending on it) means one careless refactor ships wrong numbers to a paying customer. Coverage doesn't need to be broad, just precise around the math. | Vitest set up. ~15 tests covering `calcBuRunRate`, `calcCorrectedEfficiency`, scrap-rate weighting, idle/error attribution. CI runs them on every PR. |
| RLS narrative or RLS hardening | Every policy today is `USING (true)`. With per-project isolation that's defensible, but corporate IT will read the schema and ask. | Either tighten policies to meaningful predicates, or write a one-page security architecture note explaining physical isolation, key handling, and threat model. |
| Staging environment | Every push to main deploys to production. The first regression in front of a paying customer hurts. | A staging frontend (e.g. `staging-pms.app`) pointing at a separate staging Supabase project. Deploys on push to a `staging` branch. |
| Migration runner | 75 SQL files applied by hand. Three customer projects equals guaranteed drift within a quarter. | A script that applies `database/migrations/*.sql` to a target Supabase project in order, idempotently, tracking applied migrations in a `schema_migrations` table. |

### Tier 2 — first three months after first corporate customer

| Area | Why it matters |
|---|---|
| Verified backup and recovery procedure | Supabase Pro takes daily backups. Has anyone restored one? Document the RTO/RPO we commit to and rehearse it. |
| Audit trail | Who changed the KPI thresholds yesterday? Who removed user X? Add an `audit_log` table populated for high-stakes mutations (threshold changes, role changes, machine removals). |
| MQTT over TLS plus per-machine credentials | Plant network to bridge to Supabase should be end-to-end encrypted. Each PLC ideally has its own broker credentials so a single compromised Pi can be rotated without redeploying. |
| CI checks before deploy | Right now `git push main` deploys. Typecheck, lint, and (once they exist) tests should run and fail the build before any artifact uploads. |
| Repo housekeeping | The `Dashboard/` folder is a stack of `README_*.md` notes-to-self. To a corporate reviewer it reads as sloppy. Move under `docs/` with real titles, or delete. |

### Tier 3 — defer until a customer asks

| Area | Why we wait |
|---|---|
| SSO / SAML | Real ask eventually, but expensive. Build when a paying customer requires it. Supabase supports SAML on Team tier. |
| Multi-tenancy in one project | Already decided against. Don't revisit without a specific commercial reason. |
| Status page and SLA wording | Build when we sign an SLA, not before. |
| Privacy policy, ToS, DPA | Start with a template; have a lawyer review the GDPR DPA wording before the first signed corporate contract. |

### Recommended sequencing

Roughly two weeks of focused work to clear Tier 1:

1. Sentry on both apps. Half a day each.
2. Staging environment. One day. New Supabase project, new Pages deploy on a branch, env separation.
3. KPI test suite. Two to three days. Fixtures plus ~15 tests around the math.
4. Migration runner. One day. Wraps `psql` (or `supabase db push`) with applied-migrations tracking per project.
5. CI: typecheck plus lint plus tests on PRs to main. Half a day.
6. Audit log table plus wrapper for the five highest-stakes mutations. One day.
7. Clean up `Dashboard/` and write a real top-level README. Half a day.

Sentry is the cheapest win and the absence that will hurt most in week one of a live customer — start there.

---

## One-Command Migration Template

When ready, create `database/migrations/016_us_eastern_timezone.sql` with:

```sql
-- Migration 016: US Eastern timezone support for work-day bucketing
-- Apply when deploying to a US factory running on Eastern Time.
-- Replaces the hardcoded UTC-offset with proper IANA timezone support.

CREATE OR REPLACE FUNCTION get_fleet_trend(
  range_start        timestamptz,
  range_end          timestamptz,
  bucket_granularity text
)
-- (full function body here — copy from database/functions/get_fleet_trend.sql
--  and replace every occurrence of:
--    DATE_TRUNC('day', <expr> - interval '7 hours')
--  with:
--    DATE_TRUNC('day', (<expr> AT TIME ZONE 'America/New_York') - interval '7 hours')
-- )
RETURNS TABLE ( ... )
...;

-- Also update downsample_to_analytics if bucket_start alignment matters:
CREATE OR REPLACE FUNCTION downsample_to_analytics()
-- (replace date_trunc('hour', sr.recorded_at) with
--  date_trunc('hour', sr.recorded_at AT TIME ZONE 'America/New_York'))
...;
```

---

## Notes

- The Supabase project timezone is UTC and should stay UTC. Never change it.
  All timezone conversion happens in query expressions, not in storage.
- If the factory ever operates across a DST boundary mid-shift, the
  `AT TIME ZONE 'America/New_York'` approach handles it automatically.
  A hardcoded offset like `- interval '11 hours'` would be wrong for half the year.
- The Ohio customer viewing the dashboard does not need to set any timezone.
  Once migration 016 is applied, all labels reflect factory local time
  regardless of where the browser is.
