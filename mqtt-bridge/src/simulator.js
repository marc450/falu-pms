/**
 * FALU PMS - Machine Simulator v3 (combined topic)
 *
 * Publishes a single combined cloud/Shift message every 5 seconds per machine,
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
    m.speedTierIdx       = row.speed_tier_idx;
    m.baseSpeed          = row.base_speed;
    m.tierLockedUntil    = row.tier_locked_until;
    m.cleaningStartMin   = row.cleaning_start_min;
    m.shifts[1]          = row.shift_1_data || createShiftData();
    m.shifts[2]          = row.shift_2_data || createShiftData();
    m.shifts[3]          = row.shift_3_data || createShiftData();
    restored++;
    console.log(`[STATE] Restored ${row.machine_name} — ${m.shifts[m.activeShift].producedSwabs.toLocaleString()} swabs`);
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
const MACHINE_NAMES    = (
  process.env.SIM_MACHINES ||
  "CB-30,CB-31,CB-32,CB-33,CB-34,CB-35,CB-36,CB-37," +
  "CT-1,CT-2,CT-3,CT-4,CT-5,CT-6,CT-7,CT-8,CT-9,CT-10"
).split(",").map(s => s.trim());

const topicPrefix = IS_LOCAL ? "local" : "cloud";

// ============================================
// SHIFT CONFIG
// ============================================
const SHIFT_MIN  = 720;               // 12 hours in minutes
const SHIFT_MS   = SHIFT_MIN * 60000;
const CYCLE_MS   = 3 * SHIFT_MS;      // 36-hour cycle

// Reference: a known Shift 1 start — 2026-01-01 06:00:00 local time
const REFERENCE_MS = new Date(2026, 0, 1, 6, 0, 0, 0).getTime();

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
// HELPERS
// ============================================
function getShiftInfo() {
  const now     = Date.now();
  const elapsed = now - REFERENCE_MS;
  const cyclePos = ((elapsed % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  const idx      = Math.floor(cyclePos / SHIFT_MS);
  const elapsedInShiftMs = cyclePos - idx * SHIFT_MS;
  return {
    shiftNumber:    idx + 1,
    elapsedMinutes: elapsedInShiftMs / 60000,
    shiftStartMs:   now - elapsedInShiftMs,  // absolute timestamp when this shift began
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
function initMachine(name) {
  const type    = name.startsWith("CB") ? "CB" : "CT";
  const { shiftNumber, elapsedMinutes } = getShiftInfo();
  const tierIdx = pickTierIdx(type);
  return {
    name,
    type,
    status:           "run",
    activeShift:      shiftNumber,
    errorEndMin:      null,
    cleaningStartMin: assignCleaningStart(),
    speedTierIdx:     tierIdx,
    baseSpeed:        speedInTier(type, tierIdx),
    currentSpeed:     0,
    tierLockedUntil:  elapsedMinutes + TIER_LOCK_MIN,
    efficiency:       0,
    reject:           0,
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
    status = "run";
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
  if (status === "run") {

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
// PUBLISH — single combined cloud/Shift message
// ============================================
function publishCombinedShift(client, machine, shiftNum, save = false) {
  const shift = machine.shifts[shiftNum];
  if (!shift) return;
  const isRunning = machine.status === "run";
  const msg = {
    Machine:        machine.name,
    Status:         machine.status,
    Speed:          isRunning ? machine.currentSpeed : 0,
    Shift:          shiftNum,
    ProductionTime: parseFloat(shift.productionTime.toFixed(2)),
    IdleTime:       parseFloat(shift.idleTime.toFixed(2)),
    ProducedSwabs:  shift.producedSwabs,
    PackagedSwabs:  shift.packagedSwabs,
    DiscardedSwabs: shift.discardedSwabs,
    ProducedBoxes:  shift.producedBoxes,
    Efficiency:     parseFloat(shift.efficiency.toFixed(2)),
    Reject:         parseFloat(shift.reject.toFixed(2)),
    Save:           save,
  };
  client.publish(`${topicPrefix}/Shift`, JSON.stringify(msg), { qos: 1 });
}

// ============================================
// MAIN
// ============================================
const url = IS_LOCAL
  ? `mqtt://${BROKER_HOST}:${BROKER_PORT}`
  : `mqtts://${BROKER_HOST}:${BROKER_PORT}`;

console.log(`\n=== FALU PMS Machine Simulator v3 (combined topic) ===`);
console.log(`Broker:     ${url}`);
console.log(`Machines:   ${MACHINE_NAMES.join(", ")}`);
console.log(`Tick:       ${TICK_MS}ms`);
console.log(`Shift ref:  Shift 1 at ${new Date(REFERENCE_MS).toLocaleString()}`);
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
      simulateTick(machine, elapsedMinutes);
      publishCombinedShift(client, machine, machine.activeShift, false);
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
