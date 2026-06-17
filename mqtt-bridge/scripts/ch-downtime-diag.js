#!/usr/bin/env node
/**
 * Localize the downtime parity gap (read-only).
 * Day-by-day: Supabase get_error_shift_summary vs CH /api/analytics/downtime-summary,
 * plus the raw Supabase sources (error_events 48h + error_shift_summary table) so we
 * can see whether the gap lives in the recent 48h (raw vs raw) or the older aggregate days.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const BASE = process.argv[2] || "https://falu-pms-production.up.railway.app";
const D = 86_400_000, now = Date.now(), iso = (ms) => new Date(ms).toISOString();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const n = (v) => Number(v) || 0;

function byDay(rows, dateField, occF, durF) {
  const m = {};
  for (const r of rows) {
    const day = String(r[dateField]).slice(0, 10);
    m[day] ||= { occ: 0, dur: 0 };
    m[day].occ += n(r[occF]);
    m[day].dur += n(r[durF]);
  }
  return m;
}

(async () => {
  const start = now - 7 * D, end = now;

  // Supabase combined RPC (what the UI shows today)
  const { data: sbRpc } = await sb.rpc("get_error_shift_summary", {
    start_date: iso(start).slice(0, 10), end_date: iso(end).slice(0, 10),
  });
  // Raw Supabase tables
  const { data: sbAgg } = await sb.from("error_shift_summary")
    .select("shift_date, occurrence_count, total_duration_secs")
    .gte("shift_date", iso(start).slice(0, 10));
  const { data: sbRaw } = await sb.from("error_events")
    .select("started_at, duration_secs, ended_at")
    .gte("started_at", iso(start));
  // CH endpoint
  const resp = await fetch(`${BASE}/api/analytics/downtime-summary?start=${iso(start)}&end=${iso(end)}`);
  const chRows = await resp.json();

  const rpcDay = byDay(sbRpc ?? [], "shift_date", "occurrence_count", "total_duration_secs");
  const aggDay = byDay(sbAgg ?? [], "shift_date", "occurrence_count", "total_duration_secs");
  const chDay  = byDay(chRows ?? [], "shift_date", "occurrence_count", "total_duration_secs");
  const rawDay = {};
  let openCount = 0;
  for (const r of sbRaw ?? []) {
    const day = String(r.started_at).slice(0, 10);
    rawDay[day] ||= { occ: 0, dur: 0 };
    rawDay[day].occ += 1;
    rawDay[day].dur += n(r.duration_secs);
    if (!r.ended_at) openCount++;
  }

  const days = [...new Set([...Object.keys(rpcDay), ...Object.keys(chDay), ...Object.keys(aggDay)])].sort();
  console.log("\nday          RPC(occ/dur)        CH(occ/dur)         sbAGG(occ/dur)      sbRAW evt(occ/dur)");
  for (const d of days) {
    const f = (o) => o ? `${String(o.occ).padStart(5)}/${String(Math.round(o.dur)).padStart(8)}` : "    -/       -";
    console.log(`${d}  ${f(rpcDay[d])}   ${f(chDay[d])}   ${f(aggDay[d])}   ${f(rawDay[d])}`);
  }
  console.log(`\nSupabase open (uncleared) error_events in window: ${openCount}`);
  const sum = (m) => Object.values(m).reduce((a, b) => ({ occ: a.occ + b.occ, dur: a.dur + b.dur }), { occ: 0, dur: 0 });
  const sr = sum(rpcDay), sc = sum(chDay);
  console.log(`TOTAL  RPC occ=${sr.occ} dur=${Math.round(sr.dur)}   CH occ=${sc.occ} dur=${Math.round(sc.dur)}`);
})().catch((e) => { console.error(e); process.exit(2); });
