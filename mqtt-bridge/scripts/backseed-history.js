#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Backseed 9 months of synthetic shift history.
 *
 * What it writes:
 *   * shift_assignments  — crew rotation for every day in the window that
 *                          doesn't already have a row (reuses the UI's
 *                          epoch-day rotation so existing rows aren't touched).
 *   * saved_shift_logs   — one row per (machine, shift) with realistic counters
 *                          derived from the simulator's distributions.
 *   * error_events       — individual error occurrences with start/end and crew,
 *                          sampled from ERROR_PROB_TICK + ERROR_DURATIONS.
 *   * error_shift_summary — aggregated per (machine, date, plc_shift, code).
 *
 * What it intentionally does NOT write:
 *   * shift_readings — 56M rows over 9 months, and the analytics overview
 *                      reads from the daily/hourly aggregates, not per-tick.
 *
 * After source rows are inserted, the script calls aggregate_daily_summary()
 * for every date in the window to populate daily_machine_summary and
 * daily_fleet_summary (which is what the analytics overview ultimately reads).
 *
 * Reuses the simulator's distributions (personalityFor, drawShiftP,
 * ERROR_WEIGHTS, ERROR_DURATIONS, BREAKS, …) so the seeded fleet has the same
 * star/normal/problematic mix and per-crew tempo as the live simulator will.
 *
 * Usage:
 *   node scripts/backseed-history.js --dry-run                     # plan only
 *   node scripts/backseed-history.js --from 2025-08-17 --to 2026-05-16
 *   node scripts/backseed-history.js --machine CB-37               # one machine
 *
 * Defaults: --from = today minus 9 months, --to = yesterday, --dry-run = false
 * (the script prints the first-day plan regardless before any writes happen,
 *  so you can ctrl-C if it looks wrong).
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const DRY  = !!args["dry-run"];
const ONLY_MACHINE = args.machine || null;
const ONLY_DATE    = args.date    || null;   // single-day mode for spot-checking

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayLocal() { return new Date(); }
function subtractMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() - n);
  return r;
}
function subtractDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() - n);
  return r;
}

const FROM_STR = ONLY_DATE || args.from || isoDate(subtractMonths(todayLocal(), 9));
const TO_STR   = ONLY_DATE || args.to   || isoDate(subtractDays(todayLocal(), 1));

// ─── DB ───────────────────────────────────────────────────────────────────────

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ─── Simulator constants (ported from src/simulator.js) ───────────────────────
// Speed targets and ranges per machine type, used as fallback when the machine
// row in the DB has no speed_target.
const SPEED_TARGET_FALLBACK = { CB: 2800, CT: 2600 };

const PERSONALITY = {
  star:        { bucket: "star",        speedMod: 1.03, errorMod: 0.25, scrapBump: -0.005 },
  normal:      { bucket: "normal",      speedMod: 1.00, errorMod: 1.00, scrapBump:  0.000 },
  problematic: { bucket: "problematic", speedMod: 0.92, errorMod: 2.00, scrapBump:  0.005 },
};
function personalityFor(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = ((h << 5) - h + uid.charCodeAt(i)) | 0;
  const r = (Math.abs(h) % 10000) / 10000;
  if (r < 0.15) return PERSONALITY.star;
  if (r < 0.85) return PERSONALITY.normal;
  return PERSONALITY.problematic;
}

const CREW_MODS = {
  "SHIFT A": { speedMod: 1.04, errorDurationMod: 0.70, scrapMod: -0.002 },
  "SHIFT B": { speedMod: 1.00, errorDurationMod: 1.00, scrapMod:  0.000 },
  "SHIFT C": { speedMod: 0.98, errorDurationMod: 1.10, scrapMod:  0.000 },
  "SHIFT D": { speedMod: 0.94, errorDurationMod: 1.40, scrapMod:  0.003 },
};
const DEFAULT_CREW_MOD = { speedMod: 1.0, errorDurationMod: 1.0, scrapMod: 0 };
function crewModFor(crew) { return CREW_MODS[crew] || DEFAULT_CREW_MOD; }

const P_UNDERPERFORM_PROB = 0.10;
const P_HIT_MIN = 1.00, P_HIT_MAX = 1.10;
const P_MISS_MIN = 0.70, P_MISS_MAX = 1.00;
const P_FLOOR = 0.70, P_CEIL = 1.10;
function drawShiftP() {
  return Math.random() < P_UNDERPERFORM_PROB
    ? P_MISS_MIN + Math.random() * (P_MISS_MAX - P_MISS_MIN)
    : P_HIT_MIN  + Math.random() * (P_HIT_MAX  - P_HIT_MIN);
}
function clampP(v) { return Math.max(P_FLOOR, Math.min(P_CEIL, v)); }

const SCRAP_BASELINE_MIN = 0.032;
const SCRAP_BASELINE_MAX = 0.048;
const SCRAP_TICK_VARIANCE = 0.003;
const SCRAP_CEILING = 0.050;
const BAD_BATCH_PROB = 0.08;
const BAD_BATCH_DUR_MIN = 30, BAD_BATCH_DUR_MAX = 90;
const BAD_BATCH_ADDER_MIN = 0.005, BAD_BATCH_ADDER_MAX = 0.008;
function drawShiftBaselineScrap() {
  return SCRAP_BASELINE_MIN + (Math.random() + Math.random()) / 2 * (SCRAP_BASELINE_MAX - SCRAP_BASELINE_MIN);
}
function maybeBadBatch(shiftMin) {
  if (Math.random() >= BAD_BATCH_PROB) return null;
  const dur = BAD_BATCH_DUR_MIN + Math.random() * (BAD_BATCH_DUR_MAX - BAD_BATCH_DUR_MIN);
  const start = Math.random() * Math.max(1, shiftMin - dur);
  const adder = BAD_BATCH_ADDER_MIN + Math.random() * (BAD_BATCH_ADDER_MAX - BAD_BATCH_ADDER_MIN);
  return { startMin: start, endMin: start + dur, adder };
}

const ERROR_PROB_PER_MIN = 0.01; // matches ERROR_PROB_TICK / TICK_MIN
const ERROR_DURATIONS = [
  { min:  2, cumProb: 0.10 },
  { min:  5, cumProb: 0.60 },
  { min: 20, cumProb: 0.80 },
  { min: 30, cumProb: 1.00 },
];
function pickErrorDuration() {
  const r = Math.random();
  return (ERROR_DURATIONS.find(e => r < e.cumProb) || ERROR_DURATIONS.at(-1)).min;
}

const CASCADE_WINDOW_MIN = 15;
const CASCADE_PEAK = 3;
function cascadeMultiplier(lastErrorEndMin, elapsedMin) {
  if (lastErrorEndMin === null) return 1;
  const dt = elapsedMin - lastErrorEndMin;
  if (dt < 0 || dt >= CASCADE_WINDOW_MIN) return 1;
  return 1 + (CASCADE_PEAK - 1) * (1 - dt / CASCADE_WINDOW_MIN);
}

// Breaks: 3 fixed breaks for 12h shifts. Scaled for shorter shifts by ratio.
function breaksFor(shiftMin) {
  if (shiftMin <= 6 * 60) {
    return [{ startMin: Math.floor(shiftMin / 2) - 8, durationMin: 15 }];
  }
  if (shiftMin <= 8 * 60) {
    return [
      { startMin: 120, durationMin: 15 },
      { startMin: 240, durationMin: 30 },
    ];
  }
  // 12 h default
  return [
    { startMin: 180, durationMin: 15 },
    { startMin: 360, durationMin: 60 },
    { startMin: 540, durationMin: 15 },
  ];
}

// Same weighted error pool the simulator builds at runtime.
const ERROR_WEIGHTS = {
  A172: 40, A173: 40, A073: 35, A074: 30, A190: 25, A274: 25, A275: 20, A276: 15,
  A176: 20, A177: 15,
  A010: 15, A011: 12, A012: 10, A040: 10, A124: 10, A113: 8, A180: 8, A075: 8, A278: 7,
  A035: 5, A041: 5, A244: 5, A245: 5, A246: 4, A236: 4, A109: 3, A127: 3, A171: 3,
};
let WEIGHTED_POOL = null;
async function buildWeightedPool() {
  const { data, error } = await sb.from("plc_error_codes").select("code").eq("severity", "alarm");
  if (error || !data) throw new Error("plc_error_codes load failed: " + (error?.message || "no data"));
  const codes = data.map(r => r.code);
  WEIGHTED_POOL = [];
  for (const c of codes) {
    const w = ERROR_WEIGHTS[c] || 1;
    for (let i = 0; i < w; i++) WEIGHTED_POOL.push(c);
  }
}
function pickErrorCode(machineCode) {
  // CB-37 (machine_code 11562) is pinned to A190-only by the FORCED_ERROR_CODES
  // map in simulator.js; mirror that here so the seeded history is consistent
  // with what the live machine will report going forward.
  if (machineCode === "11562") return "A190";
  return WEIGHTED_POOL[Math.floor(Math.random() * WEIGHTED_POOL.length)];
}

// ─── Time / shift math ────────────────────────────────────────────────────────

function epochDay(dateStr) {
  // dateStr is YYYY-MM-DD; treat as UTC midnight for the rotation index
  return Math.floor(Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
  ) / 86400000);
}

/**
 * Walk over every date in [from, to] inclusive. Both are YYYY-MM-DD.
 */
function* eachDate(from, to) {
  const start = new Date(from + "T00:00:00Z");
  const end   = new Date(to   + "T00:00:00Z");
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield isoDate(new Date(d));
  }
}

/**
 * Convert a local wall-clock (date in YYYY-MM-DD form + hour-of-day) in the
 * factory timezone into a UTC instant. DST-aware: spring-forward and
 * fall-back are handled correctly because the named-zone offset is probed
 * for each call.
 */
function localClockToUtcMs(dateStr, hour, tzName) {
  const baseUtc = Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10)),
    hour,
  );
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tzName, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(baseUtc));
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const localAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offsetMs = localAsUtc - baseUtc;
  return baseUtc - offsetMs;
}

/**
 * Given a YYYY-MM-DD shift_date in factory TZ, return the start/end UTC
 * timestamps for the n-th slot of that day (n = 0..NUM_SHIFTS-1).
 *
 * Start AND end are computed independently via localClockToUtcMs so that a
 * shift spanning a DST transition has the correct UTC end time — naively
 * adding `shiftDurationHours * 3600 * 1000` to startUtcMs would be ±1 h off
 * on the two transition days per year and shove saved_at into the wrong
 * shift label.
 */
function shiftWindowUTC(dateStr, slotIdx, firstStartHour, shiftDurationHours, tzName) {
  const startHour     = (firstStartHour + slotIdx       * shiftDurationHours) % 24;
  const endHourTotal  =  firstStartHour + (slotIdx + 1) * shiftDurationHours;
  const endHour       = endHourTotal % 24;
  const endDateStr    = endHourTotal >= 24
    ? isoDate(new Date(new Date(dateStr + "T00:00:00Z").getTime() + 86400000))
    : dateStr;

  const startUtcMs = localClockToUtcMs(dateStr,    startHour, tzName);
  const endUtcMs   = localClockToUtcMs(endDateStr, endHour,   tzName);
  return { startUtcMs, endUtcMs };
}

// ─── Shift simulation ─────────────────────────────────────────────────────────

/**
 * Simulate one shift for one machine. Returns the aggregate counters and the
 * list of (errorCode, startUtcMs, durationSec) tuples.
 *
 * Walks minute-by-minute so the cascading-error window and bad-batch overlaps
 * line up with what the live simulator would produce — same statistical model,
 * just stepped at TICK_MIN = 1 instead of 5s.
 */
function simulateShift({ shiftMin, speedTarget, personality, crew, shiftStartUtcMs, machineCode }) {
  const shiftP        = drawShiftP();
  const baselineScrap = drawShiftBaselineScrap();
  const badBatch      = maybeBadBatch(shiftMin);
  const breaks        = breaksFor(shiftMin);
  const isOnBreak     = (m) => breaks.some(b => m >= b.startMin && m < b.startMin + b.durationMin);
  // 30-min cleaning starts somewhere in the first half.
  const cleaningStart = Math.floor(Math.random() * Math.max(1, shiftMin / 2));
  const isCleaning    = (m) => m >= cleaningStart && m < cleaningStart + 30;

  let producedSwabs = 0;
  let discardedSwabs = 0;
  let productionMin = 0;
  let idleMin = 0;
  let errorMin = 0;
  let lastErrorEndMin = null;
  let errorEndMin = null;
  const events = [];

  // Cap effective P × personality × crew to keep output in [-30%, +10%] band.
  const effP = clampP(shiftP * personality.speedMod * crew.speedMod);

  for (let m = 0; m < shiftMin; m++) {
    let status;
    if (errorEndMin !== null && m < errorEndMin) {
      status = "error";
    } else {
      if (errorEndMin !== null && m >= errorEndMin) {
        lastErrorEndMin = errorEndMin;
        errorEndMin = null;
      }
      if (isOnBreak(m) || isCleaning(m)) {
        status = "idle";
      } else {
        status = "running";
        const effProb = ERROR_PROB_PER_MIN * personality.errorMod * cascadeMultiplier(lastErrorEndMin, m);
        if (Math.random() < effProb) {
          const baseDur = pickErrorDuration();
          const dur     = Math.max(1, Math.round(baseDur * crew.errorDurationMod));
          const startUtcMs = shiftStartUtcMs + m * 60_000;
          const endUtcMs   = shiftStartUtcMs + Math.min(shiftMin, m + dur) * 60_000;
          const code = pickErrorCode(machineCode);
          events.push({
            code,
            startedAt: new Date(startUtcMs).toISOString(),
            endedAt:   new Date(endUtcMs).toISOString(),
            durationSec: Math.round((endUtcMs - startUtcMs) / 1000),
          });
          errorEndMin = m + dur;
          status = "error";
        }
      }
    }

    if (status === "error") {
      errorMin += 1;
    } else if (status === "idle") {
      idleMin += 1;
    } else {
      productionMin += 1;
      // Production: speed_target × effP, then minute-level scrap.
      const pcsPerMin = Math.max(0, speedTarget * effP + (Math.random() * 2 - 1) * 150);
      producedSwabs += pcsPerMin;

      const batchAdder = badBatch && m >= badBatch.startMin && m < badBatch.endMin ? badBatch.adder : 0;
      const tickScrap = Math.min(SCRAP_CEILING,
        baselineScrap + personality.scrapBump + crew.scrapMod + batchAdder
        + (Math.random() * 2 - 1) * SCRAP_TICK_VARIANCE
      );
      discardedSwabs += pcsPerMin * Math.max(0, tickScrap);
    }
  }

  producedSwabs  = Math.round(producedSwabs);
  discardedSwabs = Math.round(discardedSwabs);

  // Roll up "stick problem" sub-counters from the discarded total, matching the
  // simulator's split (CottonTears / MissingSticks / FaultyPickups / OtherErrors).
  // The split is uniform-ish — analytics views aggregate them but the precise
  // distribution doesn't drive any chart.
  const cottonTears   = Math.round(discardedSwabs * 0.35);
  const missingSticks = Math.round(discardedSwabs * 0.25);
  const faultyPickups = Math.round(discardedSwabs * 0.20);
  const otherErrors   = Math.max(0, discardedSwabs - cottonTears - missingSticks - faultyPickups);

  const producedBoxes  = Math.floor(producedSwabs / 7200);
  const packagedSwabs  = producedBoxes * 7200;

  // Use the corrected-uptime formula so this row mirrors what the dashboard
  // would compute (seconds throughout; planned-downtime budget = sum of break
  // durations).
  const plannedDowntimeSec = breaks.reduce((acc, b) => acc + b.durationMin * 60, 0);
  const productionSec = productionMin * 60;
  const idleSec       = idleMin * 60;
  const errorSec      = errorMin * 60;
  const idleOnly      = Math.max(0, idleSec - errorSec);
  const unplannedIdle = Math.max(0, idleOnly - plannedDowntimeSec);
  const effective     = productionSec + unplannedIdle + errorSec;
  const efficiency    = effective > 0 ? (productionSec / effective) * 100 : 0;

  const scrapRate = producedSwabs > 0 ? (discardedSwabs / producedSwabs) * 100 : 0;

  return {
    production_time_seconds:   productionSec,
    idle_time_seconds:         idleSec,
    error_time_seconds:        errorSec,
    cotton_tears:              cottonTears,
    missing_sticks:            missingSticks,
    faulty_pickups:            faultyPickups,
    other_errors:              otherErrors,
    produced_swabs:            producedSwabs,
    packaged_swabs:            packagedSwabs,
    produced_boxes:            producedBoxes,
    produced_boxes_layer_plus: producedBoxes,
    discarded_swabs:           discardedSwabs,
    efficiency,
    scrap_rate:                scrapRate,
    events,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function loadShiftConfig() {
  const { data, error } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", ["shift_config", "factory_timezone"]);
  if (error) throw new Error("app_settings load failed: " + error.message);
  const sc = (data || []).find(r => r.key === "shift_config")?.value || {};
  const tz = (data || []).find(r => r.key === "factory_timezone")?.value;
  return {
    teams: sc.teams || ["SHIFT A", "SHIFT B", "SHIFT C", "SHIFT D"],
    shiftDurationHours:  sc.shiftDurationHours  ?? 12,
    firstShiftStartHour: sc.firstShiftStartHour ?? 7,
    plannedDowntimeMinutes: sc.plannedDowntimeMinutes ?? 0,
    tz: (typeof tz === "string" ? tz : tz?.value) || "Europe/Zurich",
  };
}

/**
 * Loads the same 18 UIDs the simulator owns. The simulator's MACHINE_UID_MAP
 * is the authoritative list of "machines we'll ever seed for"; we look those
 * UIDs up in the DB to get their UUID + speed_target (and skip any that
 * haven't been registered yet — the bridge auto-registers on first MQTT msg).
 */
async function loadMachines() {
  const SIM_UIDS = [
    "11552","11559","11560","11557","11562","11550","11553","11556",
    "11579","11574","11564","11554","11551","11563","11555","11575","11576","11580",
  ];
  const { data, error } = await sb
    .from("machines")
    .select("id, machine_code, name, speed_target, hidden")
    .in("machine_code", SIM_UIDS);
  if (error) throw new Error("machines load failed: " + error.message);
  return (data || []).filter(m => !m.hidden).map(m => ({
    id: m.id,
    machine_code: m.machine_code,
    name: m.name || m.machine_code,
    type: (m.name || "").startsWith("CT") ? "CT" : "CB",
    speed_target: m.speed_target || SPEED_TARGET_FALLBACK[(m.name || "").startsWith("CT") ? "CT" : "CB"],
  }));
}

async function loadExistingAssignments(from, to) {
  const { data, error } = await sb
    .from("shift_assignments")
    .select("shift_date, slot_teams, day_team, night_team")
    .gte("shift_date", from)
    .lte("shift_date", to);
  if (error) throw new Error("shift_assignments load failed: " + error.message);
  const map = new Map();
  for (const r of data || []) {
    const teams = Array.isArray(r.slot_teams) && r.slot_teams.length > 0
      ? r.slot_teams
      : [r.day_team, r.night_team];
    map.set(r.shift_date, teams);
  }
  return map;
}

async function chunkInsert(table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const { error } = await sb.from(table).insert(slice);
    if (error) throw new Error(`${table} insert failed at chunk ${i}: ${error.message}`);
  }
}
async function chunkUpsert(table, rows, conflict, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const { error } = await sb.from(table).upsert(slice, { onConflict: conflict });
    if (error) throw new Error(`${table} upsert failed at chunk ${i}: ${error.message}`);
  }
}

async function main() {
  console.log(`Backseed window: ${FROM_STR} → ${TO_STR}`);
  console.log(`Mode: ${DRY ? "DRY-RUN (no DB writes)" : "LIVE"}${ONLY_MACHINE ? ` | machine=${ONLY_MACHINE}` : ""}`);

  const config = await loadShiftConfig();
  const slotsPerDay = Math.round(24 / config.shiftDurationHours);
  console.log(`Config: shiftDuration=${config.shiftDurationHours}h slots/day=${slotsPerDay} firstStart=${config.firstShiftStartHour}:00 tz=${config.tz} teams=[${config.teams.join(", ")}]`);

  const machines = await loadMachines();
  if (machines.length === 0) {
    console.error("No simulator machines found in the machines table. Has the bridge run at least once?");
    process.exit(1);
  }
  const targeted = ONLY_MACHINE
    ? machines.filter(m => m.name === ONLY_MACHINE || m.machine_code === ONLY_MACHINE)
    : machines;
  if (targeted.length === 0) {
    console.error(`No match for --machine ${ONLY_MACHINE}`);
    process.exit(1);
  }
  console.log(`Machines: ${targeted.length} (${targeted.map(m => m.name).join(", ")})`);

  await buildWeightedPool();

  const existingAssignments = await loadExistingAssignments(FROM_STR, TO_STR);
  console.log(`Existing shift_assignments rows in window: ${existingAssignments.size}`);

  // ── Plan ────────────────────────────────────────────────────────────────
  const newAssignments = [];           // { shift_date, slot_teams }
  const savedLogs       = [];          // saved_shift_logs rows
  const errorEvents     = [];          // error_events rows
  const summaryAgg      = new Map();   // key → { machine_id, machine_code, shift_date, plc_shift, error_code, shift_crew, occurrence_count, total_duration_secs }

  let firstDayPreview = null;

  for (const dateStr of eachDate(FROM_STR, TO_STR)) {
    let slotTeams = existingAssignments.get(dateStr);
    if (!slotTeams) {
      const ed = epochDay(dateStr);
      slotTeams = Array.from({ length: slotsPerDay }, (_, i) => config.teams[(ed + i) % config.teams.length]);
      newAssignments.push({ shift_date: dateStr, slot_teams: slotTeams });
    } else if (slotTeams.length < slotsPerDay) {
      const ed = epochDay(dateStr);
      const filled = Array.from({ length: slotsPerDay }, (_, i) => slotTeams[i] ?? config.teams[(ed + i) % config.teams.length]);
      slotTeams = filled;
    }

    for (let slot = 0; slot < slotsPerDay; slot++) {
      const crew = slotTeams[slot];
      if (!crew) continue;
      const crewMod = crewModFor(crew);

      const { startUtcMs, endUtcMs } = shiftWindowUTC(
        dateStr, slot, config.firstShiftStartHour, config.shiftDurationHours, config.tz,
      );
      // Derive shiftMin from the actual UTC window rather than a constant
      // `shiftDurationHours * 60`. On DST-spring days a 12 h wall-clock shift
      // is really 11 h of UTC, on DST-fall days it's 13 h. Using the wall-
      // clock duration keeps production_time_seconds and the error-roll loop
      // physically accurate on those two days per year.
      const shiftMin = Math.round((endUtcMs - startUtcMs) / 60000);

      for (const m of targeted) {
        const pers   = personalityFor(m.machine_code);
        const result = simulateShift({
          shiftMin,
          speedTarget: m.speed_target,
          personality: pers,
          crew: crewMod,
          shiftStartUtcMs: startUtcMs,
          machineCode: m.machine_code,
        });

        savedLogs.push({
          machine_id:                m.id,
          machine_code:              m.machine_code,
          shift_crew:                crew,
          production_time_seconds:   result.production_time_seconds,
          idle_time_seconds:         result.idle_time_seconds,
          error_time_seconds:        result.error_time_seconds,
          cotton_tears:              result.cotton_tears,
          missing_sticks:            result.missing_sticks,
          faulty_pickups:            result.faulty_pickups,
          other_errors:              result.other_errors,
          produced_swabs:            result.produced_swabs,
          packaged_swabs:            result.packaged_swabs,
          produced_boxes:            result.produced_boxes,
          produced_boxes_layer_plus: result.produced_boxes_layer_plus,
          discarded_swabs:           result.discarded_swabs,
          efficiency:                result.efficiency,
          scrap_rate:                result.scrap_rate,
          saved_at:                  new Date(endUtcMs).toISOString(),
        });

        for (const ev of result.events) {
          errorEvents.push({
            machine_id:    m.id,
            machine_code:  m.machine_code,
            error_code:    ev.code,
            started_at:    ev.startedAt,
            ended_at:      ev.endedAt,
            duration_secs: ev.durationSec,
            shift_crew:    crew,
          });
          const key = `${m.id}|${dateStr}|${crew}|${ev.code}`;
          const agg = summaryAgg.get(key) || {
            machine_id: m.id, machine_code: m.machine_code,
            shift_date: dateStr, shift_crew: crew, error_code: ev.code,
            occurrence_count: 0, total_duration_secs: 0,
          };
          agg.occurrence_count   += 1;
          agg.total_duration_secs += ev.durationSec;
          summaryAgg.set(key, agg);
        }
      }
    }

    if (!firstDayPreview) firstDayPreview = dateStr;
  }

  console.log("\n── Plan ───────────────────────────────────");
  console.log(`shift_assignments to insert: ${newAssignments.length}`);
  console.log(`saved_shift_logs rows:       ${savedLogs.length}`);
  console.log(`error_events rows:           ${errorEvents.length}`);
  console.log(`error_shift_summary rows:    ${summaryAgg.size}`);

  // Preview the first day so you can sanity-check before writes happen.
  if (firstDayPreview) {
    console.log(`\n── Sample (${firstDayPreview}, first machine, first slot) ──`);
    const sampleLog = savedLogs.find(r => r.saved_at.startsWith(firstDayPreview));
    if (sampleLog) {
      console.log(JSON.stringify({
        machine_code: sampleLog.machine_code,
        shift_crew:   sampleLog.shift_crew,
        production_min: Math.round(sampleLog.production_time_seconds / 60),
        idle_min:       Math.round(sampleLog.idle_time_seconds / 60),
        error_min:      Math.round(sampleLog.error_time_seconds / 60),
        swabs:        sampleLog.produced_swabs,
        scrap_pct:    +sampleLog.scrap_rate.toFixed(2),
        uptime_pct:   +sampleLog.efficiency.toFixed(2),
      }, null, 2));
    }
  }

  if (DRY) {
    console.log("\n--dry-run was set; no writes performed.");
    return;
  }

  // ── Write ──────────────────────────────────────────────────────────────
  console.log("\nWriting…");
  if (newAssignments.length > 0) {
    await chunkUpsert("shift_assignments",
      newAssignments.map(a => ({ shift_date: a.shift_date, slot_teams: a.slot_teams, day_team: a.slot_teams[0] ?? null, night_team: a.slot_teams[1] ?? null })),
      "shift_date");
    console.log(`  ✓ ${newAssignments.length} shift_assignments`);
  }

  await chunkInsert("saved_shift_logs", savedLogs);
  console.log(`  ✓ ${savedLogs.length} saved_shift_logs`);

  await chunkInsert("error_events", errorEvents);
  console.log(`  ✓ ${errorEvents.length} error_events`);

  await chunkUpsert("error_shift_summary",
    [...summaryAgg.values()],
    "machine_id,shift_date,shift_crew,error_code");
  console.log(`  ✓ ${summaryAgg.size} error_shift_summary`);

  // ── Roll up daily summaries ───────────────────────────────────────────
  // aggregate_daily_summary buckets by UTC date of saved_at. Night-slot
  // saved_at values land on UTC date+1 (the shift ends in the morning of
  // the next day), so the rollup loop needs to include TO+1 to pick those up.
  // The function is idempotent (delete-then-upsert per machine/date/label)
  // so extending into today is safe even if real data already exists there.
  console.log("\nRolling up daily_machine_summary / daily_fleet_summary…");
  const rollupTo = isoDate(new Date(new Date(TO_STR + "T00:00:00Z").getTime() + 86400000));
  let rolledDays = 0;
  for (const dateStr of eachDate(FROM_STR, rollupTo)) {
    const { error } = await sb.rpc("aggregate_daily_summary", { p_date: dateStr });
    if (error) {
      console.error(`  aggregate_daily_summary(${dateStr}) failed: ${error.message}`);
      break;
    }
    rolledDays += 1;
    if (rolledDays % 30 === 0) console.log(`  …${rolledDays} days`);
  }
  console.log(`  ✓ ${rolledDays} day(s) aggregated`);

  console.log("\nDone.");
}

main().catch(err => {
  console.error("\n✗ FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
