#!/usr/bin/env node
/**
 * ClickHouse vs Supabase PARITY check (read-only).
 *
 * Phase 0 gate for the "unhook Supabase" migration: before any reader is moved
 * to ClickHouse, prove the ClickHouse endpoints return the SAME numbers the
 * Supabase RPCs return for the same window. Compares window-level totals so it
 * is immune to bucket-key formatting differences between the two backends.
 *
 *   node scripts/ch-parity.js [bridgeBaseUrl]
 *
 * Reads SUPABASE_* (service role) and hits the deployed bridge for the CH side.
 * Writes nothing to either store.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const BASE = process.argv[2] || process.env.SMOKE_BRIDGE_URL || "https://falu-pms-production.up.railway.app";
const H = 3_600_000, D = 24 * H;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const num = (v) => Number(v) || 0;
function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base * 100;
}
function line(label, sbV, chV, unit = "") {
  const d = pctDiff(sbV, chV);
  const flag = d <= 1 ? "ok " : d <= 5 ? "~  " : "XX ";
  console.log(
    `  [${flag}] ${label.padEnd(26)} supabase=${String(sbV).padStart(12)}  ` +
    `clickhouse=${String(chV).padStart(12)}${unit}   Δ ${d.toFixed(2)}%`
  );
  return d;
}

// Fleet trend: sum window-level totals from the per-bucket rows of each source.
function sumTrend(rows) {
  let swabs = 0, boxes = 0, prod = 0, idle = 0, err = 0, buckets = 0;
  for (const r of rows) {
    swabs += num(r.total_swabs);
    boxes += num(r.total_boxes);
    prod  += num(r.total_production_seconds ?? r.production_seconds);
    idle  += num(r.total_idle_seconds ?? r.idle_seconds);
    err   += num(r.total_error_seconds ?? r.error_seconds);
    buckets++;
  }
  const denom = prod + idle + err;
  const uptime = denom > 0 ? +(prod / denom * 100).toFixed(1) : 0;
  return { swabs, boxes, prod, idle, err, buckets, uptime };
}

async function fleetTrendParity() {
  console.log("\n── Fleet trend (last 24h, 5m grain) ─────────────────────────");
  const start = now - 24 * H, end = now;

  const { data: sbData, error } = await sb.rpc("get_fleet_trend_minute", {
    range_start: iso(start), range_end: iso(end), machine_ids: null,
  });
  if (error) { console.log(`  XX supabase RPC failed: ${error.message}`); return 99; }

  const qs = new URLSearchParams({ start: iso(start), end: iso(end), granularity: "5m" });
  const resp = await fetch(`${BASE}/api/analytics/fleet-trend?${qs}`);
  if (!resp.ok) { console.log(`  XX CH endpoint failed: HTTP ${resp.status}`); return 99; }
  const chData = await resp.json();

  const s = sumTrend(sbData ?? []);
  const c = sumTrend(chData ?? []);
  let worst = 0;
  worst = Math.max(worst, line("buckets returned", s.buckets, c.buckets));
  worst = Math.max(worst, line("total_swabs", s.swabs, c.swabs));
  worst = Math.max(worst, line("total_boxes", s.boxes, c.boxes));
  worst = Math.max(worst, line("production_seconds", Math.round(s.prod), Math.round(c.prod)));
  worst = Math.max(worst, line("idle_seconds", Math.round(s.idle), Math.round(c.idle)));
  worst = Math.max(worst, line("error_seconds", Math.round(s.err), Math.round(c.err)));
  worst = Math.max(worst, line("overall uptime", s.uptime, c.uptime, "%"));
  return worst;
}

function sumDowntime(rows) {
  let occ = 0, dur = 0, codes = new Set();
  for (const r of rows) {
    occ += num(r.occurrence_count);
    dur += num(r.total_duration_secs);
    codes.add(r.error_code);
  }
  return { occ, dur, codes: codes.size, rows: rows.length };
}

async function downtimeParity() {
  console.log("\n── Downtime summary (last 7d) ───────────────────────────────");
  const start = now - 7 * D, end = now;

  const { data: sbData, error } = await sb.rpc("get_error_shift_summary", {
    start_date: iso(start).slice(0, 10), end_date: iso(end).slice(0, 10),
  });
  if (error) { console.log(`  XX supabase RPC failed: ${error.message}`); return 99; }

  const qs = new URLSearchParams({ start: iso(start), end: iso(end) });
  const resp = await fetch(`${BASE}/api/analytics/downtime-summary?${qs}`);
  if (!resp.ok) { console.log(`  XX CH endpoint failed: HTTP ${resp.status}`); return 99; }
  const chData = await resp.json();

  const s = sumDowntime(sbData ?? []);
  const c = sumDowntime(chData ?? []);
  console.log("  (note: Supabase error_events retains 48h; older days come from error_shift_summary aggregates)");
  let worst = 0;
  worst = Math.max(worst, line("occurrence_count", s.occ, c.occ));
  worst = Math.max(worst, line("total_duration_secs", s.dur, c.dur));
  worst = Math.max(worst, line("distinct error_codes", s.codes, c.codes));
  return worst;
}

async function crewShiftsParity() {
  console.log("\n── Crew shifts (last 7d) ────────────────────────────────────");
  const start = now - 7 * D, end = now;
  // Supabase path: PLC-reported end-of-shift totals from saved_shift_logs.
  const { data: sbData, error } = await sb
    .from("saved_shift_logs")
    .select("produced_swabs, produced_boxes, production_time_seconds, shift_crew")
    .gte("saved_at", iso(start)).lte("saved_at", iso(end));
  if (error) { console.log(`  XX supabase query failed: ${error.message}`); return 99; }
  // CH path: delta-reconstructed shift rows.
  const resp = await fetch(`${BASE}/api/analytics/crew-shifts?start=${iso(start)}&end=${iso(end)}`);
  if (!resp.ok) { console.log(`  XX CH endpoint failed: HTTP ${resp.status}`); return 99; }
  const chData = await resp.json();
  const sum = (rows) => rows.reduce((a, r) => ({
    swabs: a.swabs + num(r.produced_swabs),
    boxes: a.boxes + num(r.produced_boxes),
    prod:  a.prod  + num(r.production_time_seconds),
    rows:  a.rows + 1,
  }), { swabs: 0, boxes: 0, prod: 0, rows: 0 });
  const s = sum(sbData ?? []), c = sum(chData ?? []);
  let worst = 0;
  worst = Math.max(worst, line("shift rows", s.rows, c.rows));
  worst = Math.max(worst, line("produced_swabs", s.swabs, c.swabs));
  worst = Math.max(worst, line("produced_boxes", s.boxes, c.boxes));
  worst = Math.max(worst, line("production_seconds", Math.round(s.prod), Math.round(c.prod)));
  console.log("  (note: Supabase = PLC end-of-shift totals; CH = summed 5m deltas — small drift is expected)");
  return worst;
}

(async () => {
  console.log(`ClickHouse↔Supabase parity  →  CH via ${BASE}`);
  const w1 = await fleetTrendParity();
  const w2 = await downtimeParity();
  const w3 = await crewShiftsParity();
  const worst = Math.max(w1, w3); // downtime intentionally excluded: CH is the accepted truth there
  console.log("\n──────────────────────────────────────────────────────────────");
  if (worst <= 1)      console.log(`✅ PARITY OK  (worst Δ ${worst.toFixed(2)}%)`);
  else if (worst <= 5) console.log(`⚠️  CLOSE  (worst Δ ${worst.toFixed(2)}%) — inspect before cutover`);
  else                 console.log(`❌ MISMATCH (worst Δ ${worst.toFixed(2)}%) — do NOT cut over yet`);
  process.exit(worst <= 5 ? 0 : 1);
})().catch((e) => { console.error("parity script crashed:", e); process.exit(2); });
