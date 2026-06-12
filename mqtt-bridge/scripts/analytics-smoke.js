#!/usr/bin/env node
/**
 * Analytics endpoint smoke test.
 *
 * Hits /api/analytics/fleet-trend for EVERY granularity tier (5s/5m/1h/1d) and
 * asserts HTTP 200 + a sane payload (non-empty, required fields, plausible
 * values, returned in time). Run it after any deploy that touches the bridge,
 * the ClickHouse views, or the data volume — so a broken tier (SQL error,
 * timeout, empty result) is caught here instead of by a user staring at a 500.
 *
 *   node scripts/analytics-smoke.js [bridgeBaseUrl]
 *   npm run smoke
 *
 * Exits non-zero if any tier fails (CI / post-deploy friendly).
 */
const BASE = process.argv[2] || process.env.SMOKE_BRIDGE_URL || "https://falu-pms-production.up.railway.app";

const H = 3_600_000, D = 24 * H;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// One representative window per tier — matches how the frontend maps windows.
const CASES = [
  { name: "Last hour  (5s)", gran: "5s", start: now - H,       end: now },
  { name: "Last 24h   (5m)", gran: "5m", start: now - 24 * H,  end: now },
  { name: "Last 7 days (1h)", gran: "1h", start: now - 8 * D,  end: now },
  { name: "Last 12 mo  (1d)", gran: "1d", start: now - 365 * D, end: now },
];

const REQUIRED = ["bucket", "avg_uptime", "avg_scrap", "total_swabs", "machine_count", "production_seconds"];
const MAX_MS = 15_000;   // a healthy tier answers well under this

async function check(c) {
  const url = `${BASE}/api/analytics/fleet-trend`
    + `?start=${encodeURIComponent(iso(c.start))}`
    + `&end=${encodeURIComponent(iso(c.end))}`
    + `&granularity=${c.gran}`;
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url);
    text = await res.text();
  } catch (e) {
    return { ok: false, msg: `network error: ${e.message}` };
  }
  const ms = Date.now() - t0;
  if (!res.ok)            return { ok: false, ms, msg: `HTTP ${res.status}: ${text.slice(0, 140)}` };
  let rows;
  try { rows = JSON.parse(text); } catch { return { ok: false, ms, msg: `bad JSON: ${text.slice(0, 140)}` }; }
  if (!Array.isArray(rows)) return { ok: false, ms, msg: "response is not an array" };
  if (rows.length === 0)    return { ok: false, ms, msg: "empty result" };
  const miss = REQUIRED.filter((k) => !(k in rows[0]));
  if (miss.length)          return { ok: false, ms, msg: `missing fields: ${miss.join(", ")}` };
  const u = Number(rows[0].avg_uptime);
  if (!(u >= 0 && u <= 110)) return { ok: false, ms, msg: `implausible uptime: ${u}` };
  if (ms > MAX_MS)          return { ok: false, ms, msg: `too slow (${ms}ms > ${MAX_MS}ms)` };
  return { ok: true, ms, msg: `${rows.length} buckets` };
}

// Crew Comparison reconstruction endpoint (different shape: per-shift rows).
const CREW_REQUIRED = ["machine_code", "shift_crew", "produced_swabs", "production_time_seconds", "efficiency", "saved_at"];
async function checkCrew() {
  const url = `${BASE}/api/analytics/crew-shifts`
    + `?start=${encodeURIComponent(iso(now - 8 * D))}`
    + `&end=${encodeURIComponent(iso(now))}`;
  const t0 = Date.now();
  let res, text;
  try { res = await fetch(url); text = await res.text(); }
  catch (e) { return { ok: false, msg: `network error: ${e.message}` }; }
  const ms = Date.now() - t0;
  if (!res.ok)              return { ok: false, ms, msg: `HTTP ${res.status}: ${text.slice(0, 140)}` };
  let rows;
  try { rows = JSON.parse(text); } catch { return { ok: false, ms, msg: `bad JSON: ${text.slice(0, 140)}` }; }
  if (!Array.isArray(rows)) return { ok: false, ms, msg: "response is not an array" };
  if (rows.length === 0)    return { ok: false, ms, msg: "empty result" };
  const miss = CREW_REQUIRED.filter((k) => !(k in rows[0]));
  if (miss.length)          return { ok: false, ms, msg: `missing fields: ${miss.join(", ")}` };
  const e = Number(rows[0].efficiency);
  if (!(e >= 0 && e <= 200)) return { ok: false, ms, msg: `implausible efficiency: ${e}` };
  if (ms > MAX_MS)          return { ok: false, ms, msg: `too slow (${ms}ms > ${MAX_MS}ms)` };
  return { ok: true, ms, msg: `${rows.length} shifts` };
}

(async () => {
  console.log(`Analytics smoke test -> ${BASE}\n`);
  let failed = 0;
  for (const c of CASES) {
    const r = await check(c);
    console.log(`[${r.ok ? "PASS" : "FAIL"}] ${c.name}  ${r.msg}${r.ms != null ? `  (${r.ms}ms)` : ""}`);
    if (!r.ok) failed++;
  }
  const cr = await checkCrew();
  console.log(`[${cr.ok ? "PASS" : "FAIL"}] Crew shifts (7d)  ${cr.msg}${cr.ms != null ? `  (${cr.ms}ms)` : ""}`);
  if (!cr.ok) failed++;

  console.log(failed ? `\n❌ ${failed} check(s) FAILED` : `\n✅ all checks OK`);
  process.exit(failed ? 1 : 0);
})();
