/**
 * FALU PMS - Machine Simulator v3 (combined topic)
 *
 * Publishes a single combined Status/CB message every 5 seconds per machine,
 * containing both status fields and production data.
 *
 * Realistic simulation featuring:
 *  - Real-clock shift tracking (Shift 1 starts 06:00, 12h each, cycle 1→2→3→1)
 *  - Synchronized breaks: 15 min @ 3h, 60 min @ 6h, 15 min @ 9h
 *  - Per-machine random 30-min cleaning cycle per shift
 *  - Random errors (1%/min) with configurable durations; error > idle priority
 *  - Speed tiers with 45-min lock periods and ±150 pcs/min tick variance
 *  - Layer+ boxes: 5% chance per box, consumes 541 swabs instead of 500
 *  - Efficiency = productionTime / (productionTime + idleTime + errorTime)
 *  - Offline state not simulated
 */

require("dotenv").config();
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");

// ============================================
// SUPABASE STATE PERSISTENCE
// ============================================
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const SAVE_EVERY_TICKS = 12; // save every ~60 s at 5 s/tick
let tickCount = 0;

async function saveState() {
  if (!supabase) return;
  const { shiftStartMs } = getShiftInfo();
  const rows = Object.values(machines).map(m => ({
    machine_name:           m.name,
    active_shift:           m.activeShift,
    shift_started_at:       shiftStartMs,
    status:                 m.status,
    error_end_min:          m.errorEndMin,
    error_start_time:       m.errorStartTime || null,
    idle_start_time:        m.idleStartTime  || null,
    cleaning_start_min:     m.cleaningStartMin,
    // Per-shift random draws (so a restart mid-shift keeps the same "personality" for the shift)
    shift_p:                m.shiftP,
    shift_baseline_scrap:   m.shiftBaselineScrap,
    bad_batch:              m.badBatch ?? null,
    last_error_end_min:     m.lastErrorEndMin,
    shift_1_data:           m.shifts[1],
    shift_2_data:           m.shifts[2],
    shift_3_data:           m.shifts[3],
    updated_at:             new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("simulator_state")
    .upsert(rows, { onConflict: "machine_name" });
  if (error) console.error("[STATE] Save failed:", error.message);
  else console.log(`[STATE] Saved ${rows.length} machines at ${new Date().toLocaleTimeString()}`);
}

async function loadState() {
  if (!supabase) { console.log("[STATE] No Supabase config — skipping restore."); return false; }
  const { data, error } = await supabase.from("simulator_state").select("*");
  if (error || !data || data.length === 0) {
    console.log("[STATE] No saved state found — starting fresh.");
    return false;
  }
  const { shiftNumber, shiftStartMs } = getShiftInfo();
  // Allow up to 10 minutes of clock drift between save and restore
  const EPOCH_TOLERANCE_MS = 10 * 60 * 1000;
  let restored = 0;
  for (const row of data) {
    const m = machines[row.machine_name];
    if (!m) continue;
    if (row.active_shift !== shiftNumber) {
      console.log(`[STATE] ${row.machine_name}: saved shift ${row.active_shift} ≠ current ${shiftNumber} — fresh init`);
      continue;
    }
    // Guard against stale data from a previous occurrence of the same shift number
    // (shifts cycle 1→2→3 every 36 hours, so the same number recurs every 36h).
    // Rows without a saved epoch (pre-migration) are also treated as stale.
    const savedEpoch = row.shift_started_at || 0;
    if (savedEpoch === 0 || Math.abs(savedEpoch - shiftStartMs) > EPOCH_TOLERANCE_MS) {
      console.log(`[STATE] ${row.machine_name}: shift ${shiftNumber} epoch mismatch (saved ${savedEpoch ? new Date(savedEpoch).toISOString() : "none"} vs current ${new Date(shiftStartMs).toISOString()}) — fresh init`);
      continue;
    }
    m.activeShift        = row.active_shift;
    m.status             = row.status;
    m.errorEndMin        = row.error_end_min;
    m.errorStartTime     = row.error_start_time || null;
    m.idleStartTime      = row.idle_start_time  || null;
    m.cleaningStartMin   = row.cleaning_start_min;
    // Restore per-shift draws; fall back to a fresh roll if the row pre-dates the migration.
    m.shiftP             = row.shift_p             ?? drawShiftP();
    m.shiftBaselineScrap = row.shift_baseline_scrap ?? drawShiftBaselineScrap();
    m.badBatch           = row.bad_batch           ?? null;
    m.lastErrorEndMin    = row.last_error_end_min  ?? null;
    m.shifts[1]          = row.shift_1_data || createShiftData();
    m.shifts[2]          = row.shift_2_data || createShiftData();
    m.shifts[3]          = row.shift_3_data || createShiftData();
    restored++;
    console.log(`[STATE] Restored ${row.machine_name} (${m.displayName}) — ${m.shifts[m.activeShift].producedSwabs.toLocaleString()} swabs`);
  }
  console.log(`[STATE] Restored ${restored}/${data.length} machines.`);
  return restored > 0;
}

// ============================================
// BROKER CONFIG
// ============================================
const BROKER_HOST      = process.env.MQTT_HOST      || "e21df7393cc24e69b198158d3af2b3d6.s1.eu.hivemq.cloud";
const BROKER_PORT      = parseInt(process.env.MQTT_PORT || "8883");
const BROKER_USER      = process.env.MQTT_USERNAME   || "mqtt-user";
const BROKER_PASS      = process.env.MQTT_PASSWORD   || "Admin123";
const IS_LOCAL         = process.env.MQTT_IS_LOCAL   === "true";
const TICK_MS          = parseInt(process.env.SIM_FREQUENCY_MS || "5000");
const TICK_MIN         = TICK_MS / 60000;
// Numeric UIDs — the exact IDs the real PLC hardware publishes as the "Machine" field.
// Display names here are for simulator logging only; users set their own display
// names in the dashboard settings via the rename feature.
const MACHINE_UID_MAP = {
  // CB machines (first 8) — speed range 2689–2850 pcs/min
  "11552": "CB-30", "11559": "CB-31", "11560": "CB-32", "11557": "CB-33",
  "11562": "CB-34", "11550": "CB-35", "11553": "CB-36", "11556": "CB-37",
  // CT machines (last 10) — speed range 2389–2650 pcs/min
  "11579": "CT-1",  "11574": "CT-2",  "11564": "CT-3",  "11554": "CT-4",
  "11551": "CT-5",  "11563": "CT-6",  "11555": "CT-7",  "11575": "CT-8",
  "11576": "CT-9",  "11580": "CT-10",
};
const MACHINE_NAMES = Object.keys(MACHINE_UID_MAP);

const topicPrefix = IS_LOCAL ? "local" : "Status";
const errorTopicPrefix = IS_LOCAL ? "local" : "Error";

// ============================================
// SHIFT CONFIG (loaded from DB at startup)
// ============================================
let SHIFT_DURATION_HOURS = 12;        // default, overridden by DB
let FIRST_SHIFT_START_HOUR = 7;       // default, overridden by DB
let FACTORY_TIMEZONE = "Europe/Zurich"; // default, overridden by DB

// Derived values (recalculated after loading config from DB)
let SHIFT_MIN  = SHIFT_DURATION_HOURS * 60;
let SHIFT_MS   = SHIFT_MIN * 60000;
let NUM_SHIFTS = Math.round(24 / SHIFT_DURATION_HOURS);  // 2 for 12h, 3 for 8h, 4 for 6h
let CYCLE_MS   = NUM_SHIFTS * SHIFT_MS;

function recalcShiftConstants() {
  SHIFT_MIN  = SHIFT_DURATION_HOURS * 60;
  SHIFT_MS   = SHIFT_MIN * 60000;
  NUM_SHIFTS = Math.round(24 / SHIFT_DURATION_HOURS);
  CYCLE_MS   = NUM_SHIFTS * SHIFT_MS;
}

async function loadShiftConfigFromDB() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["shift_config", "factory_timezone"]);
  if (error) {
    console.warn("[CONFIG] Failed to load shift config from DB:", error.message);
    return;
  }
  for (const row of data || []) {
    if (row.key === "shift_config" && row.value) {
      if (row.value.shiftDurationHours) SHIFT_DURATION_HOURS = row.value.shiftDurationHours;
      if (row.value.firstShiftStartHour !== undefined) FIRST_SHIFT_START_HOUR = row.value.firstShiftStartHour;
      console.log(`[CONFIG] Shift config: ${SHIFT_DURATION_HOURS}h shifts, first at ${FIRST_SHIFT_START_HOUR}:00`);
    }
    if (row.key === "factory_timezone" && row.value) {
      FACTORY_TIMEZONE = row.value;
      console.log(`[CONFIG] Factory timezone: ${FACTORY_TIMEZONE}`);
    }
  }
  recalcShiftConstants();
}

// Breaks: synchronized for all machines (minutes into shift)
const BREAKS = [
  { startMin: 180, durationMin: 15 },  // after quarter 1 (3 h)
  { startMin: 360, durationMin: 60 },  // after quarter 2 (6 h)
  { startMin: 540, durationMin: 15 },  // after quarter 3 (9 h)
];

// ============================================
// ERROR CONFIG
// ============================================
// 1% chance per minute → converted to per-tick probability
const ERROR_PROB_TICK = 0.01 * TICK_MIN;

// Duration distribution (cumulative probabilities)
const ERROR_DURATIONS = [
  { min:  2, cumProb: 0.10 },
  { min:  5, cumProb: 0.60 },
  { min: 20, cumProb: 0.80 },
  { min: 30, cumProb: 1.00 },
];

// ============================================
// SPEED CONFIG
// ============================================
// Per-tick speed = speed_target (from DB) × shift_P × personality × crew + ±SPEED_VARIATION.
// shift_P is drawn once per shift per machine (see SHIFT_P_* config below) and is the
// dominant lever for "how well this shift performs". The hard floor/ceiling on output
// comes from clamping the product of P × personality × crew, not from speed tiers.
const SPEED_VARIATION = 150;  // ±pcs/min tick-level noise (natural-looking)

// Fallback speed targets when machines.speed_target is unset (per machine type).
const SPEED_TARGET_FALLBACK = { CB: 2800, CT: 2600 };

// ============================================
// FORCED-CYCLE OVERRIDE
// ============================================
// Prototype/demo machines whose status follows a deterministic
// error-then-production loop instead of the normal stochastic model.
// Cycle math: e.g. errorMin = 2, runMin = 1 → 3-min loop, 33% uptime.
const FORCED_CYCLE = {
  "11562": { errorMin: 2, runMin: 1 },
};

// ============================================
// MACHINE PERSONALITY
// ============================================
// Deterministic per-UID: hash → bucket. Stable across restarts without a DB column.
const PERSONALITY = {
  star:        { bucket: "star",        speedMod: 1.03, errorMod: 0.25, scrapBump: -0.005 },
  normal:      { bucket: "normal",      speedMod: 1.00, errorMod: 1.00, scrapBump:  0.000 },
  problematic: { bucket: "problematic", speedMod: 0.92, errorMod: 2.00, scrapBump:  0.005 },
};

function personalityFor(uid) {
  // Cheap deterministic hash → [0,1)
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = ((h << 5) - h + uid.charCodeAt(i)) | 0;
  const r = (Math.abs(h) % 10000) / 10000;
  if (r < 0.15) return PERSONALITY.star;
  if (r < 0.85) return PERSONALITY.normal;
  return PERSONALITY.problematic;
}

// ============================================
// CREW MODIFIERS
// ============================================
// Looked up by exact crew name from shift_assignments. Anything else → DEFAULT_CREW_MOD.
const CREW_MODS = {
  "SHIFT A": { speedMod: 1.04, errorDurationMod: 0.70, scrapMod: -0.002 },
  "SHIFT B": { speedMod: 1.00, errorDurationMod: 1.00, scrapMod:  0.000 },
  "SHIFT C": { speedMod: 0.98, errorDurationMod: 1.10, scrapMod:  0.000 },
  "SHIFT D": { speedMod: 0.94, errorDurationMod: 1.40, scrapMod:  0.003 },
};
const DEFAULT_CREW_MOD = { speedMod: 1.0, errorDurationMod: 1.0, scrapMod: 0 };

// ============================================
// SHIFT PERFORMANCE MULTIPLIER (P)
// ============================================
// Drawn once per shift per machine. Drives whether the shift hits target.
// 90% of shifts land in [1.00, 1.10]; 10% underperform in [0.70, 1.00).
// After multiplying by personality × crew, the final value is clamped to [P_FLOOR, P_CEIL].
const P_UNDERPERFORM_PROB = 0.10;
const P_HIT_MIN  = 1.00;
const P_HIT_MAX  = 1.10;
const P_MISS_MIN = 0.70;
const P_MISS_MAX = 1.00;
const P_FLOOR    = 0.70;
const P_CEIL     = 1.10;

function drawShiftP() {
  return Math.random() < P_UNDERPERFORM_PROB
    ? P_MISS_MIN + Math.random() * (P_MISS_MAX - P_MISS_MIN)   // [0.70, 1.00)
    : P_HIT_MIN  + Math.random() * (P_HIT_MAX  - P_HIT_MIN);    // [1.00, 1.10]
}

// ============================================
// SCRAP RATE
// ============================================
// Layered model: per-shift baseline + per-tick noise + occasional bad-batch event.
// Tuned so the fleet average hovers around 4% scrap with a 5% hard ceiling.
const SCRAP_BASELINE_MIN    = 0.032;  // 3.2%
const SCRAP_BASELINE_MAX    = 0.048;  // 4.8%
const SCRAP_TICK_VARIANCE   = 0.003;  // ±0.3pp per tick
const SCRAP_CEILING         = 0.050;  // 5% hard cap
const BAD_BATCH_PROB        = 0.08;   // 8% of shifts have a bad batch event
const BAD_BATCH_DUR_MIN     = 30;     // minutes
const BAD_BATCH_DUR_MAX     = 90;
const BAD_BATCH_ADDER_MIN   = 0.005;  // +0.5pp
const BAD_BATCH_ADDER_MAX   = 0.008;  // +0.8pp

function drawShiftBaselineScrap() {
  // Triangular-ish: avg of two uniforms peaks at the midpoint (1.5%)
  return SCRAP_BASELINE_MIN +
    (Math.random() + Math.random()) / 2 *
    (SCRAP_BASELINE_MAX - SCRAP_BASELINE_MIN);
}

function maybeScheduleBadBatch() {
  if (Math.random() >= BAD_BATCH_PROB) return null;
  const dur = BAD_BATCH_DUR_MIN + Math.random() * (BAD_BATCH_DUR_MAX - BAD_BATCH_DUR_MIN);
  const start = Math.random() * Math.max(1, SHIFT_MIN - dur);
  const adder = BAD_BATCH_ADDER_MIN + Math.random() * (BAD_BATCH_ADDER_MAX - BAD_BATCH_ADDER_MIN);
  return { startMin: start, endMin: start + dur, adder };
}

// ============================================
// CASCADING ERRORS
// ============================================
// After an error resolves, the same machine is more error-prone for the next
// CASCADE_WINDOW_MIN minutes. Multiplier decays linearly from CASCADE_PEAK to 1.
const CASCADE_WINDOW_MIN = 15;
const CASCADE_PEAK       = 3;

function cascadeMultiplier(machine, elapsedMin) {
  if (machine.lastErrorEndMin === null || machine.lastErrorEndMin === undefined) return 1;
  const dt = elapsedMin - machine.lastErrorEndMin;
  if (dt < 0 || dt >= CASCADE_WINDOW_MIN) return 1;
  return 1 + (CASCADE_PEAK - 1) * (1 - dt / CASCADE_WINDOW_MIN);
}

// ============================================
// ERROR CODE CONFIG
// ============================================
// Error codes by machine type — sent as individual Error/CB messages when
// a machine enters the error state (2-3 codes per error event).
// Weighted error code distribution for realistic simulation.
// Weight tiers: very_common (40), common (15), moderate (5), rare (1).
// Codes not listed here default to weight 1 (rare).
const ERROR_WEIGHTS = {
  // Very common: production/material issues that happen frequently
  A172: 40,  // Internal wadding tear
  A173: 40,  // Cotton tear outside
  A073: 35,  // No rods on chain
  A074: 30,  // Rod magazine empty
  A190: 25,  // Too many sticks ejected
  A274: 25,  // Too many missing sticks on comb
  A275: 20,  // Too many missing rods in box 1
  A276: 15,  // Too many missing rods in box 2
  A176: 20,  // Cotton wool finished (track 1)
  A177: 15,  // Cotton wool finished (track 2)

  // Common: operational stops, doors, routine issues
  A010: 15,  // Emergency stop
  A011: 12,  // Safety door monitoring
  A012: 10,  // Magazine door open
  A040: 10,  // No compressed air
  A124: 10,  // Hot melt low temperature
  A113: 8,   // Heating does not close
  A180: 8,   // End position of dosing device
  A075: 8,   // Slider rod magazine not inserted
  A278: 7,   // Scraper end position error

  // Moderate: mechanical wear, adjustments needed
  A035: 5,   // Chain tension max
  A041: 5,   // Belt max tension
  A244: 5,   // Spring tension too low
  A245: 5,   // Spring tension too high
  A246: 4,   // Dryer outlet temperature outside range
  A236: 4,   // Max temperature drying system
  A109: 3,   // Max temperature rod heater
  A127: 3,   // No connection to hot melt device
  A171: 3,   // Thermo suction dosing device

  // Rare: electrical faults, encoder errors, system issues (weight 1 = default)
};

// Weighted pool built at startup from DB codes + weight table
let WEIGHTED_POOL = [];

async function loadErrorCodesFromDB() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("plc_error_codes")
    .select("code")
    .eq("severity", "alarm");

  let codes;
  if (!error && data && data.length > 0) {
    codes = data.map(r => r.code);
    console.log(`Loaded ${codes.length} alarm codes from plc_error_codes table`);
  } else {
    codes = Object.keys(ERROR_WEIGHTS);
    console.warn("Could not load alarm codes from DB, using weighted fallback");
  }

  // Build weighted pool: each code appears N times based on its weight
  WEIGHTED_POOL = [];
  for (const code of codes) {
    const w = ERROR_WEIGHTS[code] || 1;
    for (let i = 0; i < w; i++) WEIGHTED_POOL.push(code);
  }
  console.log(`Built weighted error pool: ${WEIGHTED_POOL.length} entries from ${codes.length} unique codes`);
}

function pickErrorCodes() {
  const pool = WEIGHTED_POOL.length > 0 ? WEIGHTED_POOL : ["A172", "A073", "A010"];
  const count = 1 + Math.floor(Math.random() * 2);  // 1 or 2 codes (3 simultaneous is rare)
  const picked = new Set();
  while (picked.size < count) {
    picked.add(pool[Math.floor(Math.random() * pool.length)]);
  }
  return Array.from(picked);
}

// ============================================
// MACHINE TARGETS (loaded from DB)
// ============================================
let MACHINE_TARGETS = {};  // numeric UID → speed_target

async function loadMachineTargetsFromDB() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("machines")
    .select("machine_code, speed_target");
  if (error) {
    console.warn("[CONFIG] Failed to load machine targets:", error.message);
    return;
  }
  MACHINE_TARGETS = {};
  for (const row of data || []) {
    if (row.speed_target) MACHINE_TARGETS[row.machine_code] = row.speed_target;
  }
  console.log(`[CONFIG] Loaded speed targets for ${Object.keys(MACHINE_TARGETS).length} machines`);
}

function targetFor(uid, type) {
  return MACHINE_TARGETS[uid] || SPEED_TARGET_FALLBACK[type] || 2600;
}

// ============================================
// SHIFT ASSIGNMENTS (for crew resolution)
// ============================================
let shiftAssignmentsCache = {};  // "YYYY-MM-DD" → ["SHIFT A", "SHIFT B", ...]

async function loadShiftAssignmentsFromDB() {
  if (!supabase) return;
  const today = new Date();
  const from = new Date(today); from.setDate(today.getDate() - 2);
  const to   = new Date(today); to.setDate(today.getDate() + 1);
  const { data, error } = await supabase
    .from("shift_assignments")
    .select("shift_date, slot_teams, day_team, night_team")
    .gte("shift_date", from.toISOString().slice(0, 10))
    .lte("shift_date", to.toISOString().slice(0, 10));
  if (error) {
    console.warn("[CONFIG] Failed to load shift assignments:", error.message);
    return;
  }
  shiftAssignmentsCache = {};
  for (const row of data || []) {
    const teams = Array.isArray(row.slot_teams) && row.slot_teams.length > 0
      ? row.slot_teams
      : [row.day_team || null, row.night_team || null];
    shiftAssignmentsCache[row.shift_date] = teams;
  }
  console.log(`[CONFIG] Cached shift assignments for ${Object.keys(shiftAssignmentsCache).length} days`);
}

// Resolve the crew currently on duty in factory-local time. Mirrors the bridge's
// resolveCurrentCrew so we apply the same crew name the bridge will write to the row.
function resolveCurrentCrew() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: FACTORY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) parts[type] = parseInt(value, 10);

  const localHour = parts.hour + parts.minute / 60;
  const slotIdx   = Math.floor(((localHour - FIRST_SHIFT_START_HOUR + 24) % 24) / SHIFT_DURATION_HOURS);

  let y = parts.year, mo = parts.month, d = parts.day;
  if (localHour < FIRST_SHIFT_START_HOUR) {
    const yesterday = new Date(y, mo - 1, d - 1);
    y = yesterday.getFullYear(); mo = yesterday.getMonth() + 1; d = yesterday.getDate();
  }
  const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return shiftAssignmentsCache[dateStr]?.[slotIdx] ?? null;
}

function crewModFor(crewName) {
  return CREW_MODS[crewName] || DEFAULT_CREW_MOD;
}

// ============================================
// HELPERS
// ============================================
function getShiftInfo() {
  const now = Date.now();

  // Get current time in factory timezone
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: FACTORY_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(new Date(now))) {
    parts[type] = parseInt(value, 10);
  }
  const localHour   = parts.hour;
  const localMinute = parts.minute;
  const localSecond = parts.second;
  const currentTimeInDay = localHour * 60 + localMinute + localSecond / 60; // minutes since midnight

  // How far into the 24h shift cycle are we? (minutes since first shift start)
  const minutesSinceFirst = ((currentTimeInDay - FIRST_SHIFT_START_HOUR * 60) + 1440) % 1440;
  const shiftIndex = Math.floor(minutesSinceFirst / SHIFT_MIN);
  const elapsedInShiftMin = minutesSinceFirst - shiftIndex * SHIFT_MIN;

  return {
    shiftNumber:    shiftIndex + 1,                          // 1-based
    elapsedMinutes: elapsedInShiftMin,
    shiftStartMs:   now - elapsedInShiftMin * 60000,         // absolute timestamp when this shift began
  };
}

function inBreakAt(elapsedMin) {
  return BREAKS.some(b => elapsedMin >= b.startMin && elapsedMin < b.startMin + b.durationMin);
}

function pickErrorDuration() {
  const r = Math.random();
  return (ERROR_DURATIONS.find(e => r < e.cumProb) || ERROR_DURATIONS.at(-1)).min;
}

function assignCleaningStart() {
  // 30-min window, avoids break periods (±5 min buffer), must end by minute 690
  for (let attempt = 0; attempt < 100; attempt++) {
    const start = Math.floor(Math.random() * 661); // 0–660
    const end   = start + 30;
    const clash = BREAKS.some(
      b => start < b.startMin + b.durationMin + 5 && end > b.startMin - 5
    );
    if (!clash) return start;
  }
  return 30; // safe fallback
}

// ============================================
// SHIFT DATA
// ============================================
function createShiftData() {
  return {
    productionTime:         0,
    idleTime:               0,
    errorTime:              0,   // internal — used for efficiency, not sent over MQTT
    cottonTears:            0,
    missingSticks:          0,
    faultyPickups:          0,
    otherErrors:            0,
    producedSwabs:          0,
    packagedSwabs:          0,
    producedBoxes:          0,
    producedBoxesLayerPlus: 0,
    discardedSwabs:         0,
    efficiency:             0,
    reject:                 0,
    // Layer+ box tracking (internal)
    swabsInCurrentBox:      0,
    nextBoxIsLayerPlus:     Math.random() < 0.05,
  };
}

// ============================================
// MACHINE INIT
// ============================================
function initMachine(uid) {
  const displayName = MACHINE_UID_MAP[uid] || uid;
  const type        = displayName.startsWith("CB") ? "CB" : "CT";
  const personality = personalityFor(uid);
  const { shiftNumber } = getShiftInfo();
  return {
    name:             uid,
    displayName,
    type,
    personality,
    status:           "running",
    activeShift:      shiftNumber,
    errorEndMin:      null,
    cleaningStartMin: assignCleaningStart(),
    currentSpeed:     0,
    efficiency:       0,
    reject:           0,
    activeErrorCodes: null,
    errorStartTime:   null,
    idleStartTime:    null,
    // Per-shift random draws — re-rolled at every shift transition.
    shiftP:             drawShiftP(),
    shiftBaselineScrap: drawShiftBaselineScrap(),
    badBatch:           maybeScheduleBadBatch(),
    // Cascading-error window: tracks when the most recent error ended.
    lastErrorEndMin:    null,
    shifts: {
      1: createShiftData(),
      2: createShiftData(),
      3: createShiftData(),
    },
  };
}

// ============================================
// TICK LOGIC
// ============================================
function simulateTick(machine, elapsedMin) {
  const shift = machine.shifts[machine.activeShift];
  const crew  = crewModFor(resolveCurrentCrew());
  const pers  = machine.personality;

  // ── Determine state ──────────────────────────────────────────────────
  let status;
  const forced = FORCED_CYCLE[machine.name];
  if (forced) {
    // Deterministic loop: `errorMin` minutes of error, then `runMin` minutes running.
    const period   = forced.errorMin + forced.runMin;
    const cyclePos = ((elapsedMin % period) + period) % period;
    if (cyclePos < forced.errorMin) {
      status = "error";
      machine.errorEndMin = Math.floor(elapsedMin / period) * period + forced.errorMin;
    } else {
      if (machine.errorEndMin !== null) {
        machine.lastErrorEndMin = machine.errorEndMin;
        machine.errorEndMin = null;
      }
      status = "running";
    }
  } else {
    const inBreak    = inBreakAt(elapsedMin);
    const inCleaning = elapsedMin >= machine.cleaningStartMin &&
                       elapsedMin <  machine.cleaningStartMin + 30;
    const wasInError = machine.errorEndMin !== null && elapsedMin < machine.errorEndMin;

    if (wasInError) {
      status = "error";
    } else if (inBreak || inCleaning) {
      status = "idle";
    } else {
      status = "running";
      // Roll for a new error. Probability is modulated by personality and by the
      // cascading-window multiplier (more likely shortly after a recent error).
      const effProb = ERROR_PROB_TICK * pers.errorMod * cascadeMultiplier(machine, elapsedMin);
      if (Math.random() < effProb) {
        const baseDuration = pickErrorDuration();
        const duration     = Math.max(1, Math.round(baseDuration * crew.errorDurationMod));
        machine.errorEndMin = elapsedMin + duration;
      }
    }

    // Capture the moment an error has just resolved this tick — needed so the
    // cascading window starts at the right elapsedMin for the next roll.
    if (machine.errorEndMin !== null && elapsedMin >= machine.errorEndMin) {
      machine.lastErrorEndMin = machine.errorEndMin;
      machine.errorEndMin = null;
    }
  }
  machine.status = status;

  // ── Time accounting ──────────────────────────────────────────────────
  if      (status === "error") shift.errorTime      += TICK_MIN;
  else if (status === "idle")  shift.idleTime       += TICK_MIN;
  else                         shift.productionTime += TICK_MIN;

  // ── Speed and production (running only) ──────────────────────────────
  if (status === "running") {
    // Base speed = target × shift_P × personality × crew, clamped to [P_FLOOR, P_CEIL]
    // multiplier band on the target so the dashboard's per-shift output respects
    // the −30%/+10% bounds regardless of crew/personality combinations.
    const target  = targetFor(machine.name, machine.type);
    const rawMult = machine.shiftP * pers.speedMod * crew.speedMod;
    const mult    = Math.max(P_FLOOR, Math.min(P_CEIL, rawMult));
    const noise   = Math.floor(Math.random() * (2 * SPEED_VARIATION + 1)) - SPEED_VARIATION;
    machine.currentSpeed = Math.max(0, Math.round(target * mult + noise));

    // Swab production
    const swabsThisTick = Math.floor(machine.currentSpeed / 60 * (TICK_MS / 1000));

    // Layered scrap rate: shift baseline + tick noise + bad batch + personality + crew.
    // Clamped to [0, SCRAP_CEILING] so the chart never shows above 4%.
    const inBadBatch = machine.badBatch &&
                       elapsedMin >= machine.badBatch.startMin &&
                       elapsedMin <  machine.badBatch.endMin;
    const tickNoise  = (Math.random() * 2 - 1) * SCRAP_TICK_VARIANCE;
    let scrapRate    = machine.shiftBaselineScrap + tickNoise + pers.scrapBump + crew.scrapMod;
    if (inBadBatch) scrapRate += machine.badBatch.adder;
    scrapRate = Math.max(0, Math.min(SCRAP_CEILING, scrapRate));

    const discarded = Math.floor(swabsThisTick * scrapRate);
    const packaged  = swabsThisTick - discarded;

    shift.producedSwabs  += swabsThisTick;
    shift.discardedSwabs += discarded;
    shift.packagedSwabs  += packaged;

    // Box counting with Layer+ logic
    shift.swabsInCurrentBox += packaged;
    while (true) {
      const threshold = shift.nextBoxIsLayerPlus ? 541 : 500;
      if (shift.swabsInCurrentBox >= threshold) {
        shift.swabsInCurrentBox -= threshold;
        shift.producedBoxes++;
        if (shift.nextBoxIsLayerPlus) shift.producedBoxesLayerPlus++;
        shift.nextBoxIsLayerPlus = Math.random() < 0.05;
      } else break;
    }

    // Per-tick minor equipment-event counters. Tied to scrap so a bad batch
    // also reads as more cotton tears on the cell-level breakdown.
    const minorScale = 1 + (scrapRate - machine.shiftBaselineScrap) * 20;
    if (Math.random() < 0.03 * minorScale) shift.cottonTears++;
    if (Math.random() < 0.02)             shift.missingSticks++;
    if (Math.random() < 0.01)             shift.faultyPickups++;
    if (Math.random() < 0.01)             shift.otherErrors++;
  }

  // ── Efficiency & reject ──────────────────────────────────────────────
  const totalTime     = shift.productionTime + shift.idleTime + shift.errorTime;
  shift.efficiency    = totalTime > 0 ? (shift.productionTime / totalTime) * 100 : 0;
  shift.reject        = shift.producedSwabs > 0
                      ? (shift.discardedSwabs / shift.producedSwabs) * 100 : 0;
  machine.efficiency  = shift.efficiency;
  machine.reject      = shift.reject;
}

// ============================================
// PUBLISH — single combined Status/CB message
// ============================================
function publishCombinedShift(client, machine, shiftNum, save = false) {
  const shift = machine.shifts[shiftNum];
  if (!shift) return;
  const isRunning = machine.status === "running";
  const msg = {
    Machine:                machine.name,   // numeric UID
    Status:                 machine.status,
    Speed:                  isRunning ? machine.currentSpeed : 0,
    Shift:                  shiftNum,
    ProductionTime:         Math.round(shift.productionTime * 60),  // seconds, matching real PLC spec
    IdleTime:               Math.round(shift.idleTime       * 60),  // seconds, matching real PLC spec
    ErrorTime:              Math.round(shift.errorTime      * 60),  // seconds, matching real PLC spec
    CottonTears:            shift.cottonTears            || 0,
    MissingSticks:          shift.missingSticks          || 0,
    FoultyPickups:          shift.faultyPickups          || 0,  // PLC field name has typo
    OtherErrors:            shift.otherErrors            || 0,
    ProducedSwabs:          shift.producedSwabs,
    PackagedSwabs:          shift.packagedSwabs,
    DisgardedSwabs:         shift.discardedSwabs,               // PLC field name has typo
    ProducedBoxes:          shift.producedBoxes,
    ProducedBoxesLayerPlus: shift.producedBoxesLayerPlus || 0,
    Efficiency:             parseFloat(shift.efficiency.toFixed(2)),
    Reject:                 parseFloat(shift.reject.toFixed(2)),
    // Authoritative episode-start timestamps — the bridge uses these to keep
    // statusSince accurate even after missing a status-change message.
    ErrorSince:             machine.status === "error" ? machine.errorStartTime : null,
    IdleSince:              machine.status === "idle"  ? machine.idleStartTime  : null,
    Save:                   save,
    Timestamp:              new Date().toISOString(),
  };
  client.publish(`${topicPrefix}/CB`, JSON.stringify(msg), { qos: 1 });
}

// ============================================
// MAIN
// ============================================
const url = IS_LOCAL
  ? `mqtt://${BROKER_HOST}:${BROKER_PORT}`
  : `mqtts://${BROKER_HOST}:${BROKER_PORT}`;

console.log(`\n=== FALU PMS Machine Simulator v4 (full PLC spec) ===`);
console.log(`Broker:     ${url}`);
console.log(`Machines:   ${MACHINE_NAMES.map(uid => `${uid} (${MACHINE_UID_MAP[uid]})`).join(", ")}`);
console.log(`Tick:       ${TICK_MS}ms`);
console.log(`Shift ref:  ${SHIFT_DURATION_HOURS}h shifts, first at ${FIRST_SHIFT_START_HOUR}:00 ${FACTORY_TIMEZONE}`);
console.log(`=====================================\n`);

const client = mqtt.connect(url, {
  username:           BROKER_USER,
  password:           BROKER_PASS,
  clientId:           `falu-simulator-${Date.now()}`,
  clean:              true,
  keepalive:          30,
  connectTimeout:     15000,
  reconnectPeriod:    5000,
  rejectUnauthorized: !IS_LOCAL,
});

const machines = {};
let simulationStarted = false;

client.on("connect", async () => {
  console.log("Connected to MQTT broker");

  // Load shift config + timezone + error codes + machine targets + assignments
  await loadShiftConfigFromDB();
  await loadErrorCodesFromDB();
  await loadMachineTargetsFromDB();
  await loadShiftAssignmentsFromDB();

  MACHINE_NAMES.forEach(name => { if (!machines[name]) machines[name] = initMachine(name); });

  // Guard: only start the tick loop once — reconnects must not spawn a second interval
  if (simulationStarted) {
    console.log("Reconnected — reusing existing simulation loop.\n");
    return;
  }
  simulationStarted = true;

  // Restore persisted state (overwrites fresh init for matching shifts)
  await loadState();

  const { shiftNumber, elapsedMinutes } = getShiftInfo();
  console.log(`Starting at Shift ${shiftNumber}, ${elapsedMinutes.toFixed(1)} min elapsed\n`);

  setInterval(async () => {
    const { shiftNumber, elapsedMinutes } = getShiftInfo();

    for (const machine of Object.values(machines)) {

      // ── Shift change detection ────────────────────────────────────────
      if (shiftNumber !== machine.activeShift) {
        publishCombinedShift(client, machine, machine.activeShift, true);
        console.log(`[SHIFT END]   ${machine.name} Shift ${machine.activeShift} saved`);

        machine.shifts[shiftNumber] = createShiftData();
        machine.activeShift         = shiftNumber;
        machine.cleaningStartMin    = assignCleaningStart();
        machine.errorEndMin         = null;
        machine.lastErrorEndMin     = null;
        // Re-roll per-shift random draws so each shift has its own "feel".
        machine.shiftP              = drawShiftP();
        machine.shiftBaselineScrap  = drawShiftBaselineScrap();
        machine.badBatch            = maybeScheduleBadBatch();

        console.log(`[SHIFT START] ${machine.name} now on Shift ${machine.activeShift} (P=${machine.shiftP.toFixed(3)}, baselineScrap=${(machine.shiftBaselineScrap*100).toFixed(2)}%${machine.badBatch ? `, badBatch@${Math.round(machine.badBatch.startMin)}min` : ""})`);
      }

      // ── Tick & publish combined message ────────────────────────────────
      const prevStatus = machine.status;
      simulateTick(machine, elapsedMinutes);
      const newStatus = machine.status;

      // Determine error code transitions (before publishing Status/CB)
      let codesToActivate = null;
      let codesToClear    = null;
      if (prevStatus !== newStatus) {
        const now = new Date().toISOString();
        if (newStatus === "error") {
          machine.errorStartTime = now;
          machine.idleStartTime  = null;
        } else if (newStatus === "idle") {
          machine.idleStartTime  = now;
          machine.errorStartTime = null;
        } else {
          machine.errorStartTime = null;
          machine.idleStartTime  = null;
        }
      }
      if (prevStatus !== "error" && newStatus === "error") {
        // Assign error codes for this error event
        machine.activeErrorCodes = pickErrorCodes();
        codesToActivate = machine.activeErrorCodes;
      } else if (prevStatus === "error" && newStatus !== "error") {
        // Error resolved — record codes to clear, then reset
        codesToClear = machine.activeErrorCodes;
        machine.activeErrorCodes = null;
      }

      // Status/CB is always sent first (PLC spec: Status/CB with Status:"Error"
      // arrives before any Error/CB code messages)
      publishCombinedShift(client, machine, machine.activeShift, false);

      // Publish error code activations after Status/CB
      if (codesToActivate) {
        for (const code of codesToActivate) {
          client.publish(`${errorTopicPrefix}/CB`, JSON.stringify({
            Machine:     machine.name,
            ErrorCode:   code,
            ErrorStatus: true,
            Timestamp:   new Date().toISOString(),
          }), { qos: 1 });
        }
      }
      // Publish error code clearances when returning to running
      if (codesToClear) {
        for (const code of codesToClear) {
          client.publish(`${errorTopicPrefix}/CB`, JSON.stringify({
            Machine:     machine.name,
            ErrorCode:   code,
            ErrorStatus: false,
            Timestamp:   new Date().toISOString(),
          }), { qos: 1 });
        }
      }
    }

    // ── Persist state periodically ───────────────────────────────────
    tickCount++;
    if (tickCount % SAVE_EVERY_TICKS === 0) await saveState();

  }, TICK_MS);

  console.log("Simulation running. Press Ctrl+C to stop.\n");
});

client.on("error", err => console.error(`MQTT Error: ${err.message}`));

process.on("SIGINT", async () => {
  console.log("\nShutting down simulator — saving state...");
  await saveState();
  client.end(true);
  process.exit(0);
});
