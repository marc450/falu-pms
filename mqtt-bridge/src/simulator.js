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
    machine_name:       m.name,
    active_shift:       m.activeShift,
    shift_started_at:   shiftStartMs,
    status:             m.status,
    error_end_min:      m.errorEndMin,
    error_start_time:   m.errorStartTime || null,
    idle_start_time:    m.idleStartTime  || null,
    speed_tier_idx:     m.speedTierIdx,
    base_speed:         m.baseSpeed,
    tier_locked_until:  m.tierLockedUntil,
    cleaning_start_min: m.cleaningStartMin,
    shift_1_data:       m.shifts[1],
    shift_2_data:       m.shifts[2],
    shift_3_data:       m.shifts[3],
    updated_at:         new Date().toISOString(),
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
    m.speedTierIdx       = row.speed_tier_idx;
    m.baseSpeed          = row.base_speed;
    m.tierLockedUntil    = row.tier_locked_until;
    m.cleaningStartMin   = row.cleaning_start_min;
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
const BROKER_USER      = process.env.MQTT_USERNAME   || "USCotton";
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
const SPEED_CONFIG = {
  CB: {
    tiers: [
      { cumProb: 0.90, min: 2689, max: 2850 },
      { cumProb: 0.95, min: 2300, max: 2688 },
      { cumProb: 1.00, min: 1800, max: 2299 },
    ],
  },
  CT: {
    tiers: [
      { cumProb: 0.90, min: 2389, max: 2650 },
      { cumProb: 0.95, min: 2300, max: 2388 },
      { cumProb: 1.00, min: 1500, max: 2299 },
    ],
  },
};

const SPEED_VARIATION = 150;  // ±pcs/min applied each tick within tier bounds
const TIER_LOCK_MIN   = 45;   // minutes a machine stays in the same speed tier

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

function pickTierIdx(type) {
  const r = Math.random();
  return SPEED_CONFIG[type].tiers.findIndex(t => r < t.cumProb);
}

function speedInTier(type, idx) {
  const t = SPEED_CONFIG[type].tiers[idx];
  return t.min + Math.floor(Math.random() * (t.max - t.min + 1));
}

function clampToTier(speed, type, idx) {
  const t = SPEED_CONFIG[type].tiers[idx];
  return Math.max(t.min, Math.min(t.max, speed));
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
  // Determine machine type from display name in the UID map
  const displayName = MACHINE_UID_MAP[uid] || uid;
  const type        = displayName.startsWith("CB") ? "CB" : "CT";
  const { shiftNumber, elapsedMinutes } = getShiftInfo();
  const tierIdx = pickTierIdx(type);
  return {
    name:             uid,         // numeric UID — what the PLC sends as "Machine"
    displayName,                   // human-readable name (for local logging only)
    type,
    status:           "running",
    activeShift:      shiftNumber,
    errorEndMin:      null,
    cleaningStartMin: assignCleaningStart(),
    speedTierIdx:     tierIdx,
    baseSpeed:        speedInTier(type, tierIdx),
    currentSpeed:     0,
    tierLockedUntil:  elapsedMinutes + TIER_LOCK_MIN,
    efficiency:       0,
    reject:           0,
    // Active error codes — set on transition into error, cleared on transition out.
    activeErrorCodes: null,
    // Authoritative timestamps for the current status episode, published with
    // every MQTT tick so the bridge can correct statusSince even after a reconnect.
    errorStartTime: null,
    idleStartTime:  null,
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

  // ── Determine state ──────────────────────────────────────────────────
  const inBreak    = inBreakAt(elapsedMin);
  const inCleaning = elapsedMin >= machine.cleaningStartMin &&
                     elapsedMin <  machine.cleaningStartMin + 30;
  const isIdle     = inBreak || inCleaning;
  const inError    = machine.errorEndMin !== null && elapsedMin < machine.errorEndMin;

  let status;
  if (inError) {
    // Error takes priority over idle.
    // Idle period counts down in parallel but machine shows as error.
    status = "error";
  } else if (isIdle) {
    status = "idle";
  } else {
    status = "running";
    // Only roll for a new error when freely running (not during idle)
    if (Math.random() < ERROR_PROB_TICK) {
      machine.errorEndMin = elapsedMin + pickErrorDuration();
    }
  }
  machine.status = status;

  // ── Time accounting ──────────────────────────────────────────────────
  if      (status === "error") shift.errorTime      += TICK_MIN;
  else if (status === "idle")  shift.idleTime       += TICK_MIN;
  else                         shift.productionTime += TICK_MIN;

  // ── Speed and production (running only) ──────────────────────────────
  if (status === "running") {

    // Speed tier management
    if (elapsedMin >= machine.tierLockedUntil) {
      machine.speedTierIdx   = pickTierIdx(machine.type);
      machine.baseSpeed      = speedInTier(machine.type, machine.speedTierIdx);
      machine.tierLockedUntil = elapsedMin + TIER_LOCK_MIN;
    }
    const raw = machine.baseSpeed +
                Math.floor(Math.random() * (2 * SPEED_VARIATION + 1)) - SPEED_VARIATION;
    machine.currentSpeed = clampToTier(raw, machine.type, machine.speedTierIdx);

    // Swab production
    const swabsThisTick = Math.floor(machine.currentSpeed / 60 * (TICK_MS / 1000));
    const discarded     = Math.floor(swabsThisTick * (0.03 + Math.random() * 0.02));
    const packaged      = swabsThisTick - discarded;

    shift.producedSwabs  += swabsThisTick;
    shift.discardedSwabs += discarded;
    shift.packagedSwabs  += packaged;

    // Box counting with Layer+ logic
    // Layer+ box requires 541 swabs (500 standard + 41 extra layer)
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

    // Random minor error counters (equipment events, not machine-down errors)
    if (Math.random() < 0.03) shift.cottonTears++;
    if (Math.random() < 0.02) shift.missingSticks++;
    if (Math.random() < 0.01) shift.faultyPickups++;
    if (Math.random() < 0.01) shift.otherErrors++;
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

  // Load shift config + timezone + error codes from DB before starting simulation
  await loadShiftConfigFromDB();
  await loadErrorCodesFromDB();

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
        machine.speedTierIdx        = pickTierIdx(machine.type);
        machine.baseSpeed           = speedInTier(machine.type, machine.speedTierIdx);
        machine.tierLockedUntil     = elapsedMinutes + TIER_LOCK_MIN;

        console.log(`[SHIFT START] ${machine.name} now on Shift ${machine.activeShift}`);
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
