/**
 * FALU PMS - MQTT Bridge + REST API (v3 — full PLC message spec)
 *
 * Subscribes to two topics from cotton swab machines:
 *   - cloud/Shift  → Combined status + production data (every 5 s normally;
 *                    immediately on status change, e.g. when error occurs)
 *                    Fields: Machine, Status, Shift, Speed, ProductionTime,
 *                    IdleTime, ErrorTime, CottonTears, MissingSticks,
 *                    FoultyPickups, OtherErrors, ProducedSwabs, PackagedSwabs,
 *                    ProducedBoxes, ProducedBoxesLayerPlus, DisgardedSwabs,
 *                    Efficiency, Reject, Save, Timestamp
 *   - cloud/Error  → Individual error code per message (many may arrive in
 *                    quick succession for one error event; cloud/Shift with
 *                    Status:"Error" always arrives FIRST)
 *                    Fields: Machine, ErrorCode, ErrorStatus, Timestamp
 *
 * IdleTime and ErrorTime are authoritative PLC values (seconds) — the bridge
 * no longer accumulates these per-tick; it simply converts to minutes and
 * stores them. Values reset automatically when the PLC reports a shift change.
 *
 * Historical shift data is stored in Supabase; the bridge no longer
 * publishes RequestShift — the dashboard reads past shifts from the DB.
 */

require("dotenv").config();
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");
const express = require("express");
const cors = require("cors");
const winston = require("winston");
const fs = require("fs");
const path = require("path");

// ============================================
// LOGGER
// ============================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

// Ensure log directory exists
fs.mkdirSync("logs", { recursive: true });

// ============================================
// SUPABASE
// ============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// IN-MEMORY STATE
// ============================================
const allMachines = {};
// Structure per machine:
// {
//   machine: "CB-30",
//   machineStatus: { Machine, Status, Speed, Shift, Efficiency, Reject,
//                    ProducedSwabs, PackagedSwabs, DiscardedSwabs, ProducedBoxes,
//                    ProductionTime, IdleTime },
//   lastSync: Date,
//   openErrorEvents: { "A172": eventId, ... },  // error_events.id for currently open events
//   shiftErrorCounts: { "1": { "A172": { count: 3, totalSecs: 120 }, ... }, ... },  // in-memory aggregation
// }

let mqttConnected = false;
let currentShiftNumber = 1;
let shiftStartedAt = Date.now();

// Machine cache: machine_code -> UUID
const machineIdCache = {};

// ============================================
// DOWNTIME ALERT STATE
// ============================================
let alertConfig = { enabled: false, threshold_minutes: 10 };
let shiftConfig = null;   // loaded from app_settings
let shiftMechanics = {};  // crew name -> user UUID

// Twilio credentials from environment
const TWILIO_SID          = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN        = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM         = process.env.TWILIO_WHATSAPP_FROM || "";  // e.g. "whatsapp:+14405863762"
const TWILIO_TEMPLATE_SID = process.env.TWILIO_TEMPLATE_SID || "";   // e.g. "HXe7a2d8e64c4305f014148976f37dc85c"

// ============================================
// BROKER SETTINGS (loaded from env or defaults)
// ============================================
const brokerSettings = {
  host: process.env.MQTT_HOST || "e21df7393cc24e69b198158d3af2b3d6.s1.eu.hivemq.cloud",
  port: parseInt(process.env.MQTT_PORT || "8883"),
  username: process.env.MQTT_USERNAME || "USCotton",
  password: process.env.MQTT_PASSWORD || "Admin123",
  isLocal: process.env.MQTT_IS_LOCAL === "true",
};

function getSubscribeTopic() {
  return brokerSettings.isLocal ? "local/#" : "cloud/#";
}

// ============================================
// STARTUP: LOAD ALL REGISTERED MACHINES
// Ensures every machine in the DB appears on the dashboard,
// even if it hasn't sent MQTT data yet this session.
// ============================================
async function loadRegisteredMachines() {
  const { data, error } = await supabase
    .from("machines")
    .select("id, machine_code, status, error_message, active_shift, speed, current_swaps, current_boxes, current_efficiency, current_reject, last_sync_status, last_sync_shift, status_since, idle_time_calc, error_time_calc, active_error_codes")
    .eq("hidden", false)
    .order("machine_code");

  if (error) {
    logger.error(`Failed to load registered machines: ${error.message}`);
    return;
  }

  for (const row of data) {
    const code = row.machine_code;
    machineIdCache[code] = row.id;

    if (!allMachines[code]) {
      allMachines[code] = {
        machine: code,
        machineStatus: {
          Machine: code,
          Status: row.status || "offline",
          Speed: row.speed || 0,
          Shift: row.active_shift || 0,
          ProducedSwabs: row.current_swaps || 0,
          ProducedBoxes: row.current_boxes || 0,
          Efficiency: row.current_efficiency || 0,
          Reject: row.current_reject || 0,
        },
        lastSync: row.last_sync_status || row.last_sync_shift || null,
        // Restore the actual transition time so the status badge shows correctly.
        statusSince: row.status_since || new Date().toISOString(),
        // Restore idle/error time so the REST API exposes them before the first MQTT tick.
        idleTimeCalc:  row.idle_time_calc  || 0,
        errorTimeCalc: row.error_time_calc || 0,
        // Restore active error codes so the dashboard continues showing them after restart.
        activeErrors: Array.isArray(row.active_error_codes) ? row.active_error_codes : [],
        // Timestamp of last downtime alert sent for this machine (null = never)
        lastNotifiedAt: null,
      };
    }
  }

  const statusCounts = data.reduce((acc, r) => {
    acc[r.status || "null"] = (acc[r.status || "null"] || 0) + 1;
    return acc;
  }, {});
  logger.info(`Loaded ${data.length} registered machines from Supabase | statuses: ${JSON.stringify(statusCounts)}`);
}

// ============================================
// RESTORE NOTIFICATION TIMESTAMPS
// Reads notification_log on startup so lastNotifiedAt survives bridge restarts.
// Without this, every restart would trigger a flood for machines already in error.
// ============================================
async function restoreNotificationTimestamps() {
  const { data, error } = await supabase
    .from("notification_log")
    .select("machine_code, created_at")
    .eq("status", "sent")
    .order("created_at", { ascending: false });

  if (error) {
    logger.warn(`Could not restore notification timestamps: ${error.message}`);
    return;
  }

  // Keep only the most recent entry per machine_code
  const latest = {};
  for (const row of data) {
    if (!latest[row.machine_code]) {
      latest[row.machine_code] = row.created_at;
    }
  }

  let restored = 0;
  for (const [code, ts] of Object.entries(latest)) {
    if (allMachines[code]) {
      allMachines[code].lastNotifiedAt = ts;
      restored++;
    }
  }
  logger.info(`Restored lastNotifiedAt for ${restored} machine(s) from notification_log`);
}

// ============================================
// MACHINE ID RESOLUTION
// ============================================
async function getMachineId(machineCode) {
  if (machineIdCache[machineCode]) return machineIdCache[machineCode];

  const { data, error } = await supabase
    .from("machines")
    .select("id")
    .eq("machine_code", machineCode)
    .single();

  if (error || !data) {
    // Auto-register
    const { data: newMachine, error: insertErr } = await supabase
      .from("machines")
      .insert({ machine_code: machineCode, name: machineCode })
      .select("id")
      .single();

    if (insertErr) {
      logger.error(`Failed to register machine ${machineCode}: ${insertErr.message}`);
      return null;
    }
    machineIdCache[machineCode] = newMachine.id;
    logger.info(`Auto-registered new machine: ${machineCode}`);
    return newMachine.id;
  }

  machineIdCache[machineCode] = data.id;
  return data.id;
}

// ============================================
// COMBINED SHIFT MESSAGE HANDLER
// ============================================
// cloud/Shift now carries everything: status fields + production data.
// Confirmed field list:
//   Machine, Status, Speed, Shift, ProductionTime, IdleTime,
//   ProducedSwabs, PackagedSwabs, DiscardedSwabs, ProducedBoxes,
//   Efficiency, Reject, Save
async function handleShiftMessage(payload) {
  const data = JSON.parse(payload);
  const machineCode = data.Machine;
  if (!machineCode) return;

  // ── Update in-memory state ──
  if (!allMachines[machineCode]) {
    allMachines[machineCode] = { machine: machineCode, activeErrors: [], lastNotifiedAt: null };
  }
  const m = allMachines[machineCode];

  // Shift change detection — track globally for BU run rate
  const prevShift = m.machineStatus?.Shift;
  const incomingShift = data.Shift || currentShiftNumber;
  if (prevShift !== undefined && incomingShift && prevShift !== incomingShift) {
    logger.info(`Machine ${machineCode} shift ${prevShift}→${incomingShift} — PLC resets idle/error counters`);
  }
  if (incomingShift !== currentShiftNumber) {
    currentShiftNumber = incomingShift;
    shiftStartedAt = Date.now();
    logger.info(`Global shift changed to ${currentShiftNumber} at ${new Date(shiftStartedAt).toISOString()}`);
  }

  // ── Status transition detection — update statusSince for the badge timer ──
  const prevStatus = (m.machineStatus?.Status || "").toLowerCase();
  const nextStatus = (data.Status || "offline").toLowerCase();
  if (prevStatus !== nextStatus) {
    m.statusSince = new Date().toISOString();
    logger.info(`Status change for ${machineCode}: ${prevStatus || "(none)"}→${nextStatus} at ${m.statusSince}`);
  }
  // Trust the authoritative episode-start timestamps from the simulator when
  // present.  This corrects a stale statusSince caused by the bridge missing a
  // status-change message while it was offline or reconnecting.
  if (nextStatus === "error" && data.ErrorSince) {
    m.statusSince = data.ErrorSince;
  } else if (nextStatus === "idle" && data.IdleSince) {
    m.statusSince = data.IdleSince;
  } else if (nextStatus === "error") {
    // Real PLCs do not send ErrorSince, so apply a hard-constraint correction:
    // the current error episode cannot be longer than the total accumulated
    // ErrorTime for the shift.  If the badge would exceed that, statusSince is
    // stale (bridge missed a recovery while offline) and we reset it so the
    // badge shows at most the accumulated error time.
    const errorMins  = (data.ErrorTime || 0) / 60;   // ErrorTime is seconds from PLC
    const badgeMins  = (Date.now() - new Date(m.statusSince).getTime()) / 60000;
    if (badgeMins > errorMins + 1) {                  // +1 min rounding tolerance
      m.statusSince = new Date(Date.now() - errorMins * 60000).toISOString();
      logger.warn(`Corrected stale statusSince for ${machineCode}: badge was ${badgeMins.toFixed(1)} min but ErrorTime is ${errorMins.toFixed(1)} min`);
    }
  }
  if (!m.statusSince) {
    m.statusSince = new Date().toISOString();
  }

  // ── Clear active error codes when machine returns to running ──────────────
  // The PLC sends cloud/Shift Status:"Error" before sending cloud/Error codes.
  // When the machine recovers, it sends cloud/Shift Status:"Running" — at that
  // point all error codes are resolved.
  if (nextStatus === "running" || nextStatus === "run") {
    // Close all open error_event rows for this machine
    if (m.openErrorEvents && Object.keys(m.openErrorEvents).length > 0) {
      const now = new Date();
      const mId = machineIdCache[machineCode];
      const currentShift = String(data.Shift || currentShiftNumber);
      for (const [errCode, eventId] of Object.entries(m.openErrorEvents)) {
        const { data: ev } = await supabase.from("error_events").select("started_at").eq("id", eventId).single();
        const durationSecs = ev ? Math.round((now.getTime() - new Date(ev.started_at).getTime()) / 1000) : 0;
        await supabase.from("error_events").update({
          ended_at: now.toISOString(),
          duration_secs: durationSecs,
        }).eq("id", eventId);
        // Add to shift aggregation
        if (!m.shiftErrorCounts) m.shiftErrorCounts = {};
        if (!m.shiftErrorCounts[currentShift]) m.shiftErrorCounts[currentShift] = {};
        if (!m.shiftErrorCounts[currentShift][errCode]) m.shiftErrorCounts[currentShift][errCode] = { count: 0, totalSecs: 0 };
        m.shiftErrorCounts[currentShift][errCode].totalSecs += durationSecs;
      }
      m.openErrorEvents = {};
      logger.info(`Closed all open error events for ${machineCode} on transition to running`);
    }
    m.activeErrors = [];
  }

  // Store as machineStatus, adding backward-compatible aliases so the frontend
  // keeps working with both old (Status-only) and new (combined) payloads.
  m.machineStatus = {
    ...data,
    // Aliases for the frontend which still reads .ActShift, .Swabs, .Boxes, .Error
    ActShift: data.Shift || data.ActShift || 1,
    Swabs:    data.ProducedSwabs ?? data.Swabs ?? 0,
    Boxes:    data.ProducedBoxes ?? data.Boxes ?? 0,
    Error:    data.Error || "",
  };

  m.lastSync = new Date();
  m.lastSyncShift = m.lastSync;
  // Also keep legacy lastSyncStatus for the REST API
  m.lastSyncStatus = m.lastSync;

  // ── Persist to Supabase ──
  const machineId = await getMachineId(machineCode);
  if (!machineId) return;

  // Always update the machines table (status, speed, live counters)
  const now = new Date().toISOString();

  const updatePayload = {
    status: nextStatus,
    error_message: null, // errors come via cloud/Error; active codes tracked in active_error_codes
    active_shift: data.Shift || 1,
    speed: data.Speed || 0,
    current_swaps: data.ProducedSwabs || 0,
    current_boxes: data.ProducedBoxes || 0,
    current_efficiency: data.Efficiency || 0,
    current_reject: data.Reject || 0,
    last_sync_status: now,
    hidden: false,
    // PLC is the authoritative source for idle/error time (seconds, converted to minutes).
    // These reset automatically when the PLC reports a shift change.
    status_since:    m.statusSince || now,
    idle_time_calc:  Math.round((data.IdleTime  || 0) / 60),
    error_time_calc: Math.round((data.ErrorTime || 0) / 60),
    // Persist active error codes so they survive a bridge restart.
    active_error_codes: m.activeErrors || [],
  };

  // Mirror the derived minute values onto the in-memory object so the REST
  // API (/api/machines) exposes them and the dashboard can read them directly.
  m.idleTimeCalc  = Math.round((data.IdleTime  || 0) / 60);
  m.errorTimeCalc = Math.round((data.ErrorTime || 0) / 60);
  await supabase
    .from("machines")
    .update(updatePayload)
    .eq("id", machineId);

  // Insert a shift_readings row if there's meaningful production data
  const hasData = (data.ProductionTime || 0) > 0 ||
                  (data.IdleTime || 0) > 0 ||
                  (data.ProducedSwabs || 0) > 0 ||
                  (data.ProducedBoxes || 0) > 0;

  if (hasData) {
    const { error: insertError } = await supabase.from("shift_readings").insert({
      machine_id: machineId,
      machine_code: machineCode,
      shift_number: data.Shift,
      status: (data.Status || "run").toLowerCase(),
      speed: data.Speed || 0,
      production_time:           data.ProductionTime          || 0,
      idle_time:                 data.IdleTime                || 0,  // seconds, from PLC
      error_time:                data.ErrorTime               || 0,  // seconds, from PLC
      cotton_tears:              data.CottonTears             || 0,
      missing_sticks:            data.MissingSticks           || 0,
      faulty_pickups:            data.FoultyPickups           || 0,  // PLC typo preserved
      other_errors:              data.OtherErrors             || 0,
      produced_swabs:            data.ProducedSwabs           || 0,
      packaged_swabs:            data.PackagedSwabs           || 0,
      produced_boxes:            data.ProducedBoxes           || 0,
      produced_boxes_layer_plus: data.ProducedBoxesLayerPlus  || 0,
      discarded_swabs:           data.DisgardedSwabs          || 0,  // PLC typo preserved
      efficiency:                data.Efficiency              || 0,
      reject_rate:               data.Reject                  || 0,
      save_flag:                 data.Save                    || false,
      raw_payload: data,
      plc_timestamp: data.Timestamp ? new Date(data.Timestamp).toISOString() : null,
    });
    if (insertError) {
      logger.error(`shift_readings insert failed for ${machineCode} (Shift ${data.Shift}): ${insertError.message} | code: ${insertError.code}`);
    }

    await supabase
      .from("machines")
      .update({ last_sync_shift: now })
      .eq("id", machineId);
  }

  if (data.Save) {
    logger.info(`Save flag (end of shift) received for ${machineCode}, Shift ${data.Shift}`);

    // ── Flush in-memory error counts to error_shift_summary ──
    const shiftKey = String(data.Shift || currentShiftNumber);
    const shiftCounts = m.shiftErrorCounts?.[shiftKey];
    if (shiftCounts && Object.keys(shiftCounts).length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      for (const [errCode, agg] of Object.entries(shiftCounts)) {
        if (agg.count === 0 && agg.totalSecs === 0) continue;
        await supabase.from("error_shift_summary").upsert({
          machine_id: machineId,
          machine_code: machineCode,
          shift_date: today,
          plc_shift: parseInt(shiftKey),
          error_code: errCode,
          occurrence_count: agg.count,
          total_duration_secs: agg.totalSecs,
        }, { onConflict: "machine_id,shift_date,plc_shift,error_code" });
      }
      logger.info(`Flushed error_shift_summary for ${machineCode} shift ${shiftKey}: ${Object.keys(shiftCounts).length} codes`);
      delete m.shiftErrorCounts[shiftKey];
    }

    await supabase.from("saved_shift_logs").insert({
      machine_id:               machineId,
      machine_code:             machineCode,
      shift_number:             data.Shift,
      production_time:          Math.round(data.ProductionTime  || 0),
      idle_time:                Math.round(data.IdleTime        || 0),
      error_time:               Math.round(data.ErrorTime        || 0),  // seconds, from PLC
      cotton_tears:             data.CottonTears               || 0,
      missing_sticks:           data.MissingSticks             || 0,
      faulty_pickups:           data.FoultyPickups             || 0,
      other_errors:             data.OtherErrors               || 0,
      produced_swabs:           data.ProducedSwabs             || 0,
      packaged_swabs:           data.PackagedSwabs             || 0,
      produced_boxes:           data.ProducedBoxes             || 0,
      produced_boxes_layer_plus: data.ProducedBoxesLayerPlus   || 0,
      discarded_swabs:          data.DisgardedSwabs            || 0,  // PLC typo preserved
      efficiency:               data.Efficiency                || 0,
      reject_rate:              data.Reject                    || 0,
    });
  }

  logger.debug(`Shift updated: ${machineCode} - ${data.Status} | Shift ${data.Shift} | Speed: ${data.Speed} | Eff: ${data.Efficiency}%`);

  // ── Check downtime alert ──
  await checkDowntimeAlert(m);
}

// ============================================
// ERROR MESSAGE HANDLER — cloud/Error
// ============================================
// PLC sends one message per error code. Many codes may arrive in quick
// succession for a single error event. The cloud/Shift message with
// Status:"Error" ALWAYS arrives before any cloud/Error messages, so the
// machine is already registered in allMachines when these arrive.
// Payload: { Machine: "11564", ErrorCode: 232, ErrorStatus: true, Timestamp: "..." }
async function handleErrorMessage(payload) {
  const data = JSON.parse(payload);
  const machineCode = data.Machine;
  if (!machineCode) return;

  // Do NOT auto-register from error messages — cloud/Shift always arrives first.
  const m = allMachines[machineCode];
  if (!m) {
    logger.warn(`cloud/Error for unknown machine ${machineCode} — ignoring`);
    return;
  }

  const code = String(data.ErrorCode);
  if (!code) return;

  if (!m.activeErrors) m.activeErrors = [];
  if (!m.openErrorEvents) m.openErrorEvents = {};
  if (!m.shiftErrorCounts) m.shiftErrorCounts = {};

  const machineId = machineIdCache[machineCode];
  const currentShift = String(m.machineStatus?.Shift || currentShiftNumber);

  if (data.ErrorStatus) {
    // Error activated
    if (!m.activeErrors.includes(code)) m.activeErrors.push(code);

    // Log to error_events (detailed, 48h retention)
    if (machineId && !m.openErrorEvents[code]) {
      const { data: row } = await supabase.from("error_events").insert({
        machine_id: machineId,
        machine_code: machineCode,
        error_code: code,
        plc_shift: Number(currentShift) || null,
        started_at: data.Timestamp ? new Date(data.Timestamp).toISOString() : new Date().toISOString(),
      }).select("id").single();
      if (row) m.openErrorEvents[code] = row.id;
    }

    // Increment in-memory shift aggregation count
    if (!m.shiftErrorCounts[currentShift]) m.shiftErrorCounts[currentShift] = {};
    if (!m.shiftErrorCounts[currentShift][code]) m.shiftErrorCounts[currentShift][code] = { count: 0, totalSecs: 0 };
    m.shiftErrorCounts[currentShift][code].count++;

  } else {
    // Error cleared
    m.activeErrors = m.activeErrors.filter(c => c !== code);

    // Close the error_event row
    if (machineId && m.openErrorEvents[code]) {
      const eventId = m.openErrorEvents[code];
      const now = data.Timestamp ? new Date(data.Timestamp) : new Date();
      // Fetch started_at to compute duration
      const { data: ev } = await supabase.from("error_events").select("started_at").eq("id", eventId).single();
      const durationSecs = ev ? Math.round((now.getTime() - new Date(ev.started_at).getTime()) / 1000) : 0;

      await supabase.from("error_events").update({
        ended_at: now.toISOString(),
        duration_secs: durationSecs,
      }).eq("id", eventId);

      // Add duration to in-memory shift aggregation
      if (m.shiftErrorCounts[currentShift]?.[code]) {
        m.shiftErrorCounts[currentShift][code].totalSecs += durationSecs;
      }
      delete m.openErrorEvents[code];
    }
  }

  logger.info(`Active error codes for ${machineCode}: [${m.activeErrors.join(", ")}]`);

  // Persist to DB so error codes survive a bridge restart
  if (machineId) {
    supabase.from("machines")
      .update({ active_error_codes: m.activeErrors })
      .eq("id", machineId)
      .then(() => {});
  }
}

// ============================================
// DOWNTIME ALERT CONFIG + NOTIFICATION
// ============================================

async function loadAlertConfig() {
  try {
    const keys = ["downtime_alert_config", "shift_config", "shift_mechanics"];
    const { data, error } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", keys);
    if (error) {
      logger.error(`Failed to load alert config: ${error.message}`);
      return;
    }
    for (const row of data || []) {
      if (row.key === "downtime_alert_config") alertConfig = row.value;
      if (row.key === "shift_config") shiftConfig = row.value;
      if (row.key === "shift_mechanics") shiftMechanics = row.value;
    }
    logger.debug(`Alert config loaded: enabled=${alertConfig.enabled}, threshold=${alertConfig.threshold_minutes}min`);
  } catch (err) {
    logger.error(`loadAlertConfig error: ${err.message}`);
  }
}

/**
 * Resolve which shift crew is currently active, then find the assigned mechanic.
 * Returns { mechanicId, phone, crewName } or null.
 */
async function resolveCurrentMechanic() {
  if (!shiftConfig || !shiftConfig.slots || shiftConfig.slots.length === 0) {
    logger.warn("No shift config available, cannot resolve mechanic");
    return null;
  }

  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const firstStart = shiftConfig.firstShiftStartHour || 0;
  const duration = shiftConfig.shiftDurationHours || 12;

  // Determine slot index
  const hoursSinceFirst = ((currentHour - firstStart) + 24) % 24;
  const slotIndex = Math.floor(hoursSinceFirst / duration);

  // Determine work date (if before first shift start, use yesterday)
  const workDate = new Date(now);
  if (currentHour < firstStart) {
    workDate.setDate(workDate.getDate() - 1);
  }
  const dateStr = workDate.toISOString().slice(0, 10); // YYYY-MM-DD

  // Look up shift_assignments for this date
  const { data: assignment, error } = await supabase
    .from("shift_assignments")
    .select("slot_teams")
    .eq("shift_date", dateStr)
    .maybeSingle();

  if (error) {
    logger.error(`Failed to fetch shift assignment for ${dateStr}: ${error.message}`);
    return null;
  }
  if (!assignment || !assignment.slot_teams || !assignment.slot_teams[slotIndex]) {
    logger.warn(`No shift assignment for ${dateStr} slot ${slotIndex}`);
    return null;
  }

  const crewName = assignment.slot_teams[slotIndex]; // e.g. "SHIFT A"
  const mechanicId = shiftMechanics[crewName] || null;
  if (!mechanicId) {
    logger.warn(`No mechanic assigned to crew ${crewName}`);
    return null;
  }

  // Look up mechanic's WhatsApp phone
  const { data: profile, error: profErr } = await supabase
    .from("user_profiles")
    .select("first_name, last_name, whatsapp_phone")
    .eq("id", mechanicId)
    .single();

  if (profErr || !profile || !profile.whatsapp_phone) {
    logger.warn(`Mechanic ${mechanicId} has no WhatsApp phone`);
    return null;
  }

  return {
    mechanicId,
    phone: profile.whatsapp_phone,
    name: `${profile.first_name} ${profile.last_name}`.trim(),
    crewName,
  };
}

/**
 * Send a WhatsApp downtime alert via Twilio and log to notification_log.
 */
async function sendDowntimeAlert(machine, errorMinutes) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    logger.warn(`Twilio credentials not configured, skipping alert for ${machine.machine}`);
    return;
  }

  const mechanic = await resolveCurrentMechanic();
  const machineId = machineIdCache[machine.machine] || null;
  const roundedMin = Math.round(errorMinutes);

  // Fetch machine name and cell name from DB
  let machineName = machine.machine;
  let cellName = "Unknown";
  try {
    const { data: machineRow } = await supabase
      .from("machines")
      .select("name, cell_id, production_cells(name)")
      .eq("machine_code", machine.machine)
      .single();
    if (machineRow) {
      machineName = machineRow.name || machine.machine;
      cellName = machineRow.production_cells?.name || "Unassigned";
    }
  } catch (e) {
    logger.warn(`Could not fetch machine details for ${machine.machine}: ${e.message}`);
  }

  // Human-readable fallback for logs
  const messageBody = `⚠️ ${machineName} (${machine.machine}) in ${cellName} has been in error for ${roundedMin} minutes.`;

  if (!mechanic) {
    await supabase.from("notification_log").insert({
      machine_id: machineId,
      machine_code: machine.machine,
      mechanic_id: null,
      phone: null,
      message: messageBody,
      status: "failed",
      error_detail: "No mechanic resolved for current shift",
    });
    logger.warn(`Downtime alert for ${machine.machine}: no mechanic resolved`);
    return;
  }

  logger.info(`Sending downtime alert to ${mechanic.name} (${mechanic.phone}) for ${machine.machine} (${roundedMin} min)`);

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;

    // Send free-form WhatsApp message (requires 24h session window or approved template).
    // TODO: switch back to ContentSid template once Meta Business verification is complete.
    const params = {
      From: TWILIO_FROM,
      To: `whatsapp:${mechanic.phone}`,
      Body: messageBody,
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
    });

    const result = await resp.json();
    const success = resp.ok;

    await supabase.from("notification_log").insert({
      machine_id: machineId,
      machine_code: machine.machine,
      mechanic_id: mechanic.mechanicId,
      phone: mechanic.phone,
      message: messageBody,
      status: success ? "sent" : "failed",
      error_detail: success ? null : (result.message || JSON.stringify(result)),
    });

    if (success) {
      logger.info(`WhatsApp alert sent to ${mechanic.name} for ${machine.machine}`);
    } else {
      logger.error(`Twilio error for ${machine.machine}: ${result.message || resp.status}`);
    }
  } catch (err) {
    logger.error(`Failed to send WhatsApp alert for ${machine.machine}: ${err.message}`);
    await supabase.from("notification_log").insert({
      machine_id: machineId,
      machine_code: machine.machine,
      mechanic_id: mechanic.mechanicId,
      phone: mechanic.phone,
      message: messageBody,
      status: "failed",
      error_detail: err.message,
    });
  }
}

/**
 * Check if a machine in error state has exceeded the threshold and should trigger an alert.
 * Called after every handleShiftMessage.
 */
async function checkDowntimeAlert(machine) {
  if (!alertConfig.enabled) return;

  const status = (machine.machineStatus?.Status || "").toLowerCase();
  if (status !== "error") return;

  // Calculate continuous error duration
  if (!machine.statusSince) return;
  const errorMinutes = (Date.now() - new Date(machine.statusSince).getTime()) / 60000;
  if (errorMinutes < alertConfig.threshold_minutes) return;

  // Cooldown check: don't re-notify within cooldown_minutes of the last alert,
  // regardless of whether the machine briefly recovered and errored again.
  const cooldownMinutes = alertConfig.cooldown_minutes ?? 30;
  if (machine.lastNotifiedAt) {
    const minutesSinceLast = (Date.now() - new Date(machine.lastNotifiedAt).getTime()) / 60000;
    if (minutesSinceLast < cooldownMinutes) return;
  }

  machine.lastNotifiedAt = new Date().toISOString();
  await sendDowntimeAlert(machine, errorMinutes);
}

// ============================================
// MQTT CLIENT
// ============================================
function buildMqttUrl() {
  const protocol = brokerSettings.isLocal ? "mqtt" : "mqtts";
  return `${protocol}://${brokerSettings.host}:${brokerSettings.port}`;
}

let mqttClient;

function connectMqtt() {
  const url = buildMqttUrl();
  logger.info(`Connecting to MQTT: ${url} (${brokerSettings.isLocal ? "local" : "cloud+TLS"})`);

  mqttClient = mqtt.connect(url, {
    username: brokerSettings.username,
    password: brokerSettings.password,
    clientId: `falu-pms-bridge-${Date.now()}`,
    clean: true,
    keepalive: 30,
    connectTimeout: 15000,
    reconnectPeriod: 5000,
    rejectUnauthorized: !brokerSettings.isLocal,
  });

  mqttClient.on("connect", () => {
    mqttConnected = true;
    const topic = getSubscribeTopic();
    mqttClient.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        logger.error(`Subscribe failed: ${err.message}`);
      } else {
        logger.info(`Subscribed to: ${topic}`);
      }
    });
  });

  mqttClient.on("message", async (topic, message) => {
    try {
      const payload = message.toString();

      if (topic.includes("Error")) {
        await handleErrorMessage(payload);
      } else if (topic.includes("Shift")) {
        await handleShiftMessage(payload);
      }
      // All other topics (e.g. old Status, RequestShift) are silently ignored
    } catch (err) {
      logger.error(`Message handling error on ${topic}: ${err.message}`);
    }
  });

  mqttClient.on("error", (err) => {
    logger.error(`MQTT error: ${err.message}`);
  });

  mqttClient.on("reconnect", () => {
    logger.info("MQTT reconnecting...");
  });

  mqttClient.on("offline", () => {
    mqttConnected = false;
    logger.warn("MQTT offline");
  });

  mqttClient.on("disconnect", (packet) => {
    mqttConnected = false;
    logger.warn(`MQTT disconnect received (reason code: ${packet?.reasonCode ?? "unknown"})`);
  });

  mqttClient.on("close", () => {
    mqttConnected = false;
    logger.warn("MQTT connection closed");
  });

  // Heartbeat: log connection status every 30 s so we can confirm the bridge is alive
  setInterval(() => {
    logger.info(`[HEARTBEAT] MQTT connected: ${mqttConnected} | machines: ${Object.keys(allMachines).length}`);
  }, 30000);
}

// ============================================
// PERIODIC CLEANUP (replaces pg_cron dependency)
// ============================================
// Runs every hour. Deletes rows older than 48h from shift_readings
// and error_events. Self-correcting: if it misses a run, the next
// one catches up automatically.
async function periodicCleanup() {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { count: srCount, error: srErr } = await supabase
    .from("shift_readings")
    .delete({ count: "exact" })
    .lt("recorded_at", cutoff);
  if (srErr) {
    logger.error(`shift_readings cleanup failed: ${srErr.message}`);
  } else if (srCount > 0) {
    logger.info(`Cleaned up ${srCount} shift_readings rows older than 48h`);
  }

  const { count: eeCount, error: eeErr } = await supabase
    .from("error_events")
    .delete({ count: "exact" })
    .lt("started_at", cutoff);
  if (eeErr) {
    logger.error(`error_events cleanup failed: ${eeErr.message}`);
  } else if (eeCount > 0) {
    logger.info(`Cleaned up ${eeCount} error_events rows older than 48h`);
  }
}

// ============================================
// REST API (for frontend)
// ============================================
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"],
}));
app.use(express.json());

// Root route (used by Railway / ngrok health checks)
app.get("/", (req, res) => {
  res.json({ service: "FALU PMS Bridge", version: "2.0", status: "ok" });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", mqttConnected, machineCount: Object.keys(allMachines).length });
});

// Get all machines (live in-memory data)
app.get("/api/machines", (req, res) => {
  res.json({
    machines: allMachines,
    mqttConnected,
    currentShiftNumber,
    shiftStartedAt,
  });
});

// Get single machine
app.get("/api/machines/:code", (req, res) => {
  const machine = allMachines[req.params.code];
  if (!machine) {
    return res.status(404).json({ error: "Machine not found" });
  }
  res.json(machine);
});

// Request shift data (no-op with push-based simulator — data arrives automatically)
app.post("/api/machines/:code/request-shift", (req, res) => {
  res.json({ success: true });
});

// Delete a machine from bridge memory (Supabase deletion is handled by the frontend)
// When the machine sends MQTT again, it will be auto-registered.
app.delete("/api/machines/:code", (req, res) => {
  const code = req.params.code;
  if (allMachines[code]) {
    delete allMachines[code];
    logger.info(`Machine ${code} removed from bridge memory`);
  }
  if (machineIdCache[code]) {
    delete machineIdCache[code];
  }
  res.json({ success: true });
});

// Get broker settings
app.get("/api/settings/broker", (req, res) => {
  res.json({
    host: brokerSettings.host,
    port: brokerSettings.port,
    username: brokerSettings.username,
    isLocal: brokerSettings.isLocal,
    subscribeTopic: getSubscribeTopic(),
  });
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || process.env.API_PORT || 3001;

app.listen(PORT, () => {
  logger.info(`FALU PMS Bridge API v2 running on port ${PORT} (process.env.PORT=${process.env.PORT ?? "unset"})`);
  logger.info(`MQTT Broker: ${brokerSettings.host}:${brokerSettings.port} (${brokerSettings.isLocal ? "local" : "cloud"})`);
  logger.info(`Topic: ${getSubscribeTopic()}`);

  loadRegisteredMachines()
    .then(() => restoreNotificationTimestamps())
    .then(() => loadAlertConfig())
    .then(() => connectMqtt())
    .catch((err) => logger.error(`Startup error: ${err.message}`));

  // Reload alert config every 60 seconds so admin changes take effect without restart
  setInterval(() => loadAlertConfig(), 60000);

  // Periodic cleanup: delete shift_readings and error_events older than 48h (every hour)
  periodicCleanup(); // run once on startup
  setInterval(() => periodicCleanup(), 60 * 60 * 1000);
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Received SIGINT — shutting down");
  if (mqttClient) mqttClient.end(true);
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM — shutting down");
  if (mqttClient) mqttClient.end(true);
  process.exit(0);
});

// Log crashes so Railway deploy logs show the cause
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason instanceof Error ? reason.stack : reason);
});
