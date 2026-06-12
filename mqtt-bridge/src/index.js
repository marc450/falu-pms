/**
 * FALU PMS - MQTT Bridge + REST API (v3 — full PLC message spec)
 *
 * Subscribes to two topic trees from cotton swab machines:
 *   - Status/<type> (e.g. Status/CB, Status/SV, Status/CT)
 *                    Combined status + production data (every 5 s normally;
 *                    immediately on status change, e.g. when error occurs)
 *                    Fields: Machine, Status, Shift, Speed, ProductionTime,
 *                    IdleTime, ErrorTime, CottonTears, MissingSticks,
 *                    FaultyPickups, OtherErrors, ProducedSwabs, PackagedSwabs,
 *                    ProducedBoxes, ProducedBoxesLayerPlus, DiscardedSwabs,
 *                    Efficiency, Reject, ErrorSince, IdleSince, Save, Timestamp
 *   - Error/<type>  (e.g. Error/CB, Error/SV, Error/CT)
 *                    Individual error code per message (many may arrive in
 *                    quick succession for one error event; Status/<type> with
 *                    Status:"Error" always arrives FIRST)
 *                    Fields: Machine, ErrorCode, ErrorStatus, Timestamp
 *
 * ErrorSince / IdleSince are ISO timestamps from the PLC indicating when the
 * current error or idle episode started. The bridge computes elapsed time as
 * (data.Timestamp - data.ErrorSince) using PLC clock exclusively.
 *
 * IdleTime and ErrorTime are authoritative PLC values (cumulative seconds for
 * the current shift). The bridge converts to minutes and stores them.
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
const { startDataQualityMonitor } = require("./dataQualityMonitor");

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
// CLICKHOUSE (additive dual-write, PoC, behind a flag)
// ============================================
// Mirrors every shift_readings row into ClickHouse for analytics evaluation.
// Fully isolated from the Supabase path: writes are buffered, flushed on a
// timer, and NEVER throw into the MQTT handler. A ClickHouse outage cannot
// affect ingest. Set CLICKHOUSE_ENABLED=false (or unset) to disable entirely.
const CLICKHOUSE_ENABLED = process.env.CLICKHOUSE_ENABLED === "true";
let clickhouse = null;
let chBuffer = [];
let chErrorBuffer = [];        // completed error events, mirrored to CH for Downtime Analytics
const CH_BUFFER_MAX = 50000;   // safety cap so a long CH outage can't exhaust memory

if (CLICKHOUSE_ENABLED) {
  const { createClient: createCHClient } = require("@clickhouse/client");
  clickhouse = createCHClient({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: process.env.CLICKHOUSE_DB || "default",
  });
  logger.info("ClickHouse dual-write ENABLED");
}

// Flush the buffer as one batched INSERT. Never throws into the caller.
async function flushClickHouse() {
  if (!clickhouse || chBuffer.length === 0) return;
  const batch = chBuffer;
  chBuffer = [];                 // swap first so new rows accumulate during the await
  try {
    await clickhouse.insert({
      table: "shift_readings",
      values: batch,
      format: "JSONEachRow",
    });
    logger.debug(`ClickHouse: flushed ${batch.length} rows`);
  } catch (err) {
    // Re-queue on failure (capped) so transient CH errors don't silently drop data
    if (chBuffer.length + batch.length <= CH_BUFFER_MAX) {
      chBuffer = batch.concat(chBuffer);
    } else {
      logger.error(`ClickHouse buffer full (${CH_BUFFER_MAX}), dropping ${batch.length} rows`);
    }
    logger.error(`ClickHouse flush failed: ${err.message}`);
  }
}

// Flush completed error-event rows as one batched INSERT. Never throws into
// the caller. Same isolation guarantees as flushClickHouse: a ClickHouse
// outage re-queues (capped) and can never affect the Supabase ingest path.
async function flushClickHouseErrors() {
  if (!clickhouse || chErrorBuffer.length === 0) return;
  const batch = chErrorBuffer;
  chErrorBuffer = [];            // swap first so new rows accumulate during the await
  try {
    await clickhouse.insert({
      table: "error_events",
      values: batch,
      format: "JSONEachRow",
    });
    logger.debug(`ClickHouse: flushed ${batch.length} error events`);
  } catch (err) {
    if (chErrorBuffer.length + batch.length <= CH_BUFFER_MAX) {
      chErrorBuffer = batch.concat(chErrorBuffer);
    } else {
      logger.error(`ClickHouse error buffer full (${CH_BUFFER_MAX}), dropping ${batch.length} rows`);
    }
    logger.error(`ClickHouse error flush failed: ${err.message}`);
  }
}

if (CLICKHOUSE_ENABLED) {
  setInterval(() => { flushClickHouse(); flushClickHouseErrors(); }, 5000);   // batch every 5s
}

// ============================================
// SHIFT_READINGS WRITE BUFFER (throughput)
// ============================================
// Previously every message did an immediate `await ...insert()` for
// shift_readings PLUS two machines updates. Under a simulator reconnect
// burst that became hundreds of concurrent Supabase requests, saturating
// connections so the bridge fell minutes behind real time. Buffer the
// reading rows and flush them as one batched insert, mirroring the
// ClickHouse path. Analytics read shift_readings on a cron, and the
// 5-min buckets window by plc_timestamp (migration 096), so a ~1.5s
// batch delay is invisible to every consumer.
let srBuffer = [];
const SR_BUFFER_MAX = 50000;            // memory cap if Supabase is unreachable for a while

async function flushShiftReadings() {
  if (srBuffer.length === 0) return;
  const batch = srBuffer;
  srBuffer = [];                         // swap first so new rows accumulate during the await
  const { error } = await supabase.from("shift_readings").insert(batch);
  if (error) {
    // Re-queue on failure (capped) so transient errors don't silently drop data
    if (srBuffer.length + batch.length <= SR_BUFFER_MAX) {
      srBuffer = batch.concat(srBuffer);
    } else {
      logger.error(`shift_readings buffer full (${SR_BUFFER_MAX}), dropping ${batch.length} rows`);
    }
    logger.error(`shift_readings batch insert failed: ${error.message} | code: ${error.code}`);
  } else {
    logger.debug(`shift_readings: flushed ${batch.length} rows`);
  }
}

setInterval(flushShiftReadings, 1500);

/**
 * PLC timestamps are set by hand on the machine and may drift from real time.
 * This helper rejects sentinel values like the PLC's "null" (epoch-zero
 * 1969-12-31T23:00:00.00Z) and any obviously wrong date before 2020.
 */
function isValidPlcTimestamp(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  return !isNaN(d.getTime()) && d.getFullYear() >= 2020;
}

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
//   shiftErrorCounts: { "SHIFT A": { "A172": { count: 3, totalSecs: 120 }, ... }, ... },  // keyed by crew name
// }

let mqttConnected = false;
let currentShiftNumber = 1;
let currentCrew = null;
let shiftStartedAt = Date.now();

// Machine cache: machine_code -> UUID
const machineIdCache = {};

// ============================================
// DOWNTIME ALERT STATE
// ============================================
let alertConfig = { enabled: false, threshold_minutes: 10 };
let shiftConfig = null;   // loaded from app_settings
let shiftMechanics = {};  // crew name -> user UUID
let shiftAssignmentsCache = {};  // date string -> slot_teams array
let factoryTimezone = "Europe/Zurich";  // loaded from app_settings

// Twilio credentials from environment
const TWILIO_SID          = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN        = process.env.TWILIO_AUTH_TOKEN || "";
// SMS sender number (E.164, e.g. "+14405863762"). Falls back to the old
// TWILIO_WHATSAPP_FROM var with any "whatsapp:" prefix stripped.
const TWILIO_FROM         = (process.env.TWILIO_SMS_FROM || process.env.TWILIO_WHATSAPP_FROM || "").replace(/^whatsapp:/, "");
const TWILIO_TEMPLATE_SID = process.env.TWILIO_TEMPLATE_SID || "";   // e.g. "HXe7a2d8e64c4305f014148976f37dc85c"

// ============================================
// BROKER SETTINGS (loaded from env or defaults)
// ============================================
const brokerSettings = {
  host: process.env.MQTT_HOST || "e21df7393cc24e69b198158d3af2b3d6.s1.eu.hivemq.cloud",
  port: parseInt(process.env.MQTT_PORT || "8883"),
  username: process.env.MQTT_USERNAME || "mqtt-user",
  password: process.env.MQTT_PASSWORD || "Admin123",
  isLocal: process.env.MQTT_IS_LOCAL === "true",
};

function getSubscribeTopics() {
  if (brokerSettings.isLocal) return ["local/#"];
  return ["Status/#", "Error/#"];
}

// ============================================
// STARTUP: LOAD ALL REGISTERED MACHINES
// Ensures every machine in the DB appears on the dashboard,
// even if it hasn't sent MQTT data yet this session.
// ============================================
async function loadRegisteredMachines() {
  const { data, error } = await supabase
    .from("machines")
    .select("id, machine_code, status, error_message, plc_shift_slot, speed, current_swabs, current_boxes, current_efficiency, current_scrap_rate, last_sync_status, last_sync_shift, status_since, idle_time_seconds, error_time_seconds, active_error_codes")
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
          Shift: row.plc_shift_slot || 0,
          ProducedSwabs: row.current_swabs || 0,
          ProducedBoxes: row.current_boxes || 0,
          Efficiency: row.current_efficiency || 0,
          Reject: row.current_scrap_rate || 0,
        },
        lastSync: row.last_sync_status || row.last_sync_shift || null,
        // Restore the actual transition time so the status badge shows correctly.
        statusSince: row.status_since || new Date().toISOString(),
        // Restore idle/error time so the REST API exposes them before the first MQTT tick.
        idleTimeSeconds:  row.idle_time_seconds  || 0,
        errorTimeSeconds: row.error_time_seconds || 0,
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
// REHYDRATE OPEN ERROR EVENTS
// Reads error_events rows where ended_at IS NULL so the in-memory
// openErrorEvents map survives bridge restarts. Without this every restart
// orphans every open row forever — the Status:"Running" transition handler
// has nothing in memory to close, so the rows stay open until the 48h
// retention cleanup deletes them.
//
// For each open row:
//   - If the machine is currently in error  → restore into m.openErrorEvents
//   - Otherwise                             → close as an orphan with
//     ended_at = m.lastSync ?? now()
// ============================================
async function restoreOpenErrorEvents() {
  const { data, error } = await supabase
    .from("error_events")
    .select("id, machine_code, error_code, started_at")
    .is("ended_at", null);

  if (error) {
    logger.warn(`Could not restore open error events: ${error.message}`);
    return;
  }
  if (!data || data.length === 0) {
    logger.info("No open error_events to restore on startup");
    return;
  }

  let rehydrated = 0;
  let orphansClosed = 0;
  for (const row of data) {
    const m = allMachines[row.machine_code];
    if (!m) continue;
    const status = (m.machineStatus?.Status || "").toLowerCase();

    if (status === "error") {
      // Machine is still in error — restore so future clear events close it.
      if (!m.openErrorEvents) m.openErrorEvents = {};
      m.openErrorEvents[row.error_code] = row.id;
      rehydrated++;
    } else {
      // Machine already recovered while the bridge was down. Close as orphan.
      const endTime = m.lastSync ? new Date(m.lastSync) : new Date();
      const durationSecs = Math.max(
        0,
        Math.round((endTime.getTime() - new Date(row.started_at).getTime()) / 1000),
      );
      const { error: upErr } = await supabase
        .from("error_events")
        .update({ ended_at: endTime.toISOString(), duration_secs: durationSecs })
        .eq("id", row.id);
      if (upErr) {
        logger.warn(`Failed to close orphan error_event ${row.id}: ${upErr.message}`);
        continue;
      }
      orphansClosed++;
    }
  }
  logger.info(`Restored ${rehydrated} open error_events; closed ${orphansClosed} orphans on startup`);
}

// ============================================
// MACHINE ID RESOLUTION
// ============================================
// Only numeric machine codes are valid. Anything else is either a malformed
// MQTT payload or a wildcard character leaking in from a topic (e.g. '+'),
// and must never be auto-registered as a new machine row.
const VALID_MACHINE_CODE = /^\d{4,6}$/;

async function getMachineId(machineCode) {
  if (!machineCode || typeof machineCode !== "string" || !VALID_MACHINE_CODE.test(machineCode)) {
    logger.warn(`Rejecting invalid machine_code: ${JSON.stringify(machineCode)}`);
    return null;
  }

  if (machineIdCache[machineCode]) return machineIdCache[machineCode];

  const { data, error } = await supabase
    .from("machines")
    .select("id")
    .eq("machine_code", machineCode)
    .single();

  if (error || !data) {
    // Auto-register (only reached for well-formed numeric codes)
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
// Status/<type> now carries everything: status fields + production data.
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
  // Always refresh current crew (schedule may change intra-shift)
  currentCrew = resolveCurrentCrew() || null;

  // ── Status transition detection — update statusSince for the badge timer ──
  // All timestamps come from the PLC clock (data.Timestamp). The PLC clock is
  // set by hand and may drift from real time, but we use it consistently so
  // that durations (idle time, error time) are always self-consistent.
  const prevStatus = (m.machineStatus?.Status || "").toLowerCase();
  const nextStatus = (data.Status || "offline").toLowerCase();
  const plcNow = isValidPlcTimestamp(data.Timestamp) ? data.Timestamp : new Date().toISOString();
  if (prevStatus !== nextStatus) {
    m.statusSince = plcNow;
    logger.info(`Status change for ${machineCode}: ${prevStatus || "(none)"}→${nextStatus} at ${m.statusSince}`);
  }
  // Trust the authoritative episode-start timestamps from the PLC.
  // ErrorSince / IdleSince indicate when the current episode started.
  // This corrects a stale statusSince caused by the bridge missing a
  // status-change message while it was offline or reconnecting.
  // The PLC sends epoch-zero (~1969) as a "null" sentinel — ignore those.
  if (nextStatus === "error" && isValidPlcTimestamp(data.ErrorSince)) {
    m.statusSince = data.ErrorSince;
  } else if (nextStatus === "idle" && isValidPlcTimestamp(data.IdleSince)) {
    m.statusSince = data.IdleSince;
  }
  if (!m.statusSince) {
    m.statusSince = plcNow;
  }

  // ── Clear active error codes when machine returns to running ──────────────
  // The PLC sends Status/<type> Status:"Error" before sending Error/<type> codes.
  // When the machine recovers, it sends Status/<type> Status:"Running" — at that
  // point all error codes are resolved.
  if (nextStatus === "running") {
    // Close all open error_event rows for this machine
    if (m.openErrorEvents && Object.keys(m.openErrorEvents).length > 0) {
      const plcEnd = new Date(plcNow);
      const crew = resolveMessageCrew(data) || "Unassigned";
      for (const [errCode, eventId] of Object.entries(m.openErrorEvents)) {
        const { data: ev } = await supabase.from("error_events").select("started_at").eq("id", eventId).single();
        const durationSecs = ev ? Math.round((plcEnd.getTime() - new Date(ev.started_at).getTime()) / 1000) : 0;
        await supabase.from("error_events").update({
          ended_at: plcEnd.toISOString(),
          duration_secs: durationSecs,
        }).eq("id", eventId);
        // Add to shift aggregation (keyed by crew name)
        if (!m.shiftErrorCounts) m.shiftErrorCounts = {};
        if (!m.shiftErrorCounts[crew]) m.shiftErrorCounts[crew] = {};
        if (!m.shiftErrorCounts[crew][errCode]) m.shiftErrorCounts[crew][errCode] = { count: 0, totalSecs: 0 };
        m.shiftErrorCounts[crew][errCode].totalSecs += durationSecs;
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
    error_message: null, // errors come via Error/<type>; active codes tracked in active_error_codes
    plc_shift_slot: data.Shift || 1,
    speed: data.Speed || 0,
    current_swabs: data.ProducedSwabs || 0,
    current_boxes: data.ProducedBoxes || 0,
    current_efficiency: data.Efficiency || 0,
    current_scrap_rate: data.Reject || 0,
    last_sync_status: now,
    hidden: false,
    // PLC is the authoritative source for idle/error time (seconds).
    // These reset automatically when the PLC reports a shift change.
    status_since:       m.statusSince || now,
    idle_time_seconds:  Math.round(data.IdleTime  || 0),
    error_time_seconds: Math.round(data.ErrorTime || 0),
    // Persist active error codes so they survive a bridge restart.
    active_error_codes: m.activeErrors || [],
    // Folded in from the former second machines update (one round-trip, not two).
    last_sync_shift: now,
  };

  // Mirror the PLC seconds values onto the in-memory object so the REST
  // API (/api/machines) exposes them and the dashboard can read them directly.
  m.idleTimeSeconds  = Math.round(data.IdleTime  || 0);
  m.errorTimeSeconds = Math.round(data.ErrorTime || 0);
  await supabase
    .from("machines")
    .update(updatePayload)
    .eq("id", machineId);

  // Insert a shift_readings row if there's meaningful production data.
  const hasData = (data.ProductionTime || 0) > 0 ||
                  (data.IdleTime || 0) > 0 ||
                  (data.ProducedSwabs || 0) > 0 ||
                  (data.ProducedBoxes || 0) > 0;

  if (hasData) {
    const crew = resolveMessageCrew(data) || "Unassigned";

    // Single source of truth for the reading row, written to both stores.
    const readingRow = {
      machine_id: machineId,
      machine_code: machineCode,
      shift_crew: crew,
      status: (data.Status || "running").toLowerCase(),
      speed: data.Speed || 0,
      production_time_seconds:   data.ProductionTime          || 0,  // seconds, from PLC
      idle_time_seconds:         data.IdleTime                || 0,  // seconds, from PLC
      error_time_seconds:        data.ErrorTime               || 0,  // seconds, from PLC
      cotton_tears:              data.CottonTears             || 0,
      missing_sticks:            data.MissingSticks           || 0,
      faulty_pickups:            data.FaultyPickups           || 0,
      other_errors:              data.OtherErrors             || 0,
      produced_swabs:            data.ProducedSwabs           || 0,
      packaged_swabs:            data.PackagedSwabs           || 0,
      produced_boxes:            data.ProducedBoxes           || 0,
      produced_boxes_layer_plus: data.ProducedBoxesLayerPlus  || 0,
      discarded_swabs:           data.DiscardedSwabs          || 0,
      efficiency:                data.Efficiency              || 0,
      scrap_rate:                data.Reject                  || 0,
      save_flag:                 data.Save                    || false,
      raw_payload: data,
      plc_timestamp: data.Timestamp ? new Date(data.Timestamp).toISOString() : null,
    };

    // ── Supabase write (buffered batch insert; see flushShiftReadings) ──
    // recorded_at = true receipt time so it's accurate despite the batch delay.
    srBuffer.push({ ...readingRow, recorded_at: new Date().toISOString() });
    if (srBuffer.length >= 500) flushShiftReadings();   // burst guard: flush early

    // ── ClickHouse dual-write (additive, buffered, never blocks/throws) ──
    if (CLICKHOUSE_ENABLED) {
      chBuffer.push({
        ...readingRow,
        save_flag: readingRow.save_flag ? 1 : 0,        // CH UInt8, not JS bool
        raw_payload: JSON.stringify(data),               // CH String column, not nested object
        plc_timestamp: readingRow.plc_timestamp,         // already ISO string or null
        ingested_at: new Date().toISOString(),           // reliable server arrival time
      });
    }
  }

  if (data.Save) {
    const saveCrew = resolveMessageCrew(data) || "Unassigned";
    logger.info(`Save flag (end of shift) received for ${machineCode}, crew ${saveCrew}`);

    // ── Flush in-memory error counts to error_shift_summary ──
    // Error counts are keyed by crew name
    const shiftCounts = m.shiftErrorCounts?.[saveCrew];
    if (shiftCounts && Object.keys(shiftCounts).length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      for (const [errCode, agg] of Object.entries(shiftCounts)) {
        if (agg.count === 0 && agg.totalSecs === 0) continue;
        await supabase.from("error_shift_summary").upsert({
          machine_id: machineId,
          machine_code: machineCode,
          shift_date: today,
          shift_crew: saveCrew,
          error_code: errCode,
          occurrence_count: agg.count,
          total_duration_secs: agg.totalSecs,
        }, { onConflict: "machine_id,shift_date,shift_crew,error_code" });
      }
      logger.info(`Flushed error_shift_summary for ${machineCode} crew ${saveCrew}: ${Object.keys(shiftCounts).length} codes`);
      delete m.shiftErrorCounts[saveCrew];
    }

    await supabase.from("saved_shift_logs").insert({
      machine_id:               machineId,
      machine_code:             machineCode,
      shift_crew:               saveCrew,
      production_time_seconds:  Math.round(data.ProductionTime  || 0),  // seconds, from PLC
      idle_time_seconds:        Math.round(data.IdleTime        || 0),  // seconds, from PLC
      error_time_seconds:       Math.round(data.ErrorTime       || 0),  // seconds, from PLC
      cotton_tears:             data.CottonTears               || 0,
      missing_sticks:           data.MissingSticks             || 0,
      faulty_pickups:           data.FaultyPickups             || 0,
      other_errors:             data.OtherErrors               || 0,
      produced_swabs:           data.ProducedSwabs             || 0,
      packaged_swabs:           data.PackagedSwabs             || 0,
      produced_boxes:           data.ProducedBoxes             || 0,
      produced_boxes_layer_plus: data.ProducedBoxesLayerPlus   || 0,
      discarded_swabs:          data.DiscardedSwabs            || 0,
      efficiency:               data.Efficiency                || 0,
      scrap_rate:               data.Reject                    || 0,
    });
  }

  logger.debug(`Shift updated: ${machineCode} - ${data.Status} | Shift ${data.Shift} | Speed: ${data.Speed} | Eff: ${data.Efficiency}%`);

  // ── Check downtime alert ──
  await checkDowntimeAlert(m);
}

// ============================================
// ERROR MESSAGE HANDLER — Error/<type>
// ============================================
// PLC sends one message per error code. Many codes may arrive in quick
// succession for a single error event. The Status/<type> message with
// Status:"Error" ALWAYS arrives before any Error/<type> messages, so the
// machine is already registered in allMachines when these arrive.
// Payload: { Machine: "11564", ErrorCode: 232, ErrorStatus: true, Timestamp: "..." }
async function handleErrorMessage(payload) {
  const data = JSON.parse(payload);
  const machineCode = data.Machine;
  if (!machineCode) return;

  // Do NOT auto-register from error messages — Status/<type> always arrives first.
  const m = allMachines[machineCode];
  if (!m) {
    logger.warn(`Error/<type> for unknown machine ${machineCode} — ignoring`);
    return;
  }

  const code = String(data.ErrorCode);
  if (!code) return;

  if (!m.activeErrors) m.activeErrors = [];
  if (!m.openErrorEvents) m.openErrorEvents = {};
  if (!m.shiftErrorCounts) m.shiftErrorCounts = {};

  const machineId = machineIdCache[machineCode];
  const crew = resolveMessageCrew(data) || "Unassigned";

  if (data.ErrorStatus) {
    // Error activated
    if (!m.activeErrors.includes(code)) m.activeErrors.push(code);

    // Log to error_events (detailed, 48h retention).
    // The JS guard below is best-effort; the real guarantee is the partial
    // unique index error_events_open_unique_idx (migration 088) which blocks
    // a second open row for the same (machine, code). MQTT QoS-1 redelivers
    // messages whose ack is slow, so this code path can legitimately run
    // twice for the same event. On the second run the INSERT fails with
    // 23505 (unique_violation) — we then look up the existing open row
    // and adopt it into openErrorEvents so the close-on-running path works.
    if (machineId && !m.openErrorEvents[code]) {
      const { data: row, error: insertErr } = await supabase.from("error_events").insert({
        machine_id: machineId,
        machine_code: machineCode,
        error_code: code,
        shift_crew: crew,
        started_at: data.Timestamp ? new Date(data.Timestamp).toISOString() : new Date().toISOString(),
      }).select("id").single();
      if (insertErr) {
        if (insertErr.code === "23505") {
          // Another concurrent handler already opened this event — adopt it.
          const { data: existing } = await supabase
            .from("error_events")
            .select("id")
            .eq("machine_id", machineId)
            .eq("error_code", code)
            .is("ended_at", null)
            .order("started_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existing) {
            m.openErrorEvents[code] = existing.id;
            logger.info(`Duplicate ErrorStatus=true for ${machineCode}/${code} — adopted existing open row ${existing.id}`);
          }
        } else {
          logger.error(`Failed to insert error_events for ${machineCode}/${code}: ${insertErr.message}`);
        }
      } else if (row) {
        m.openErrorEvents[code] = row.id;
      }
    }

    // Increment in-memory shift aggregation count (keyed by crew)
    if (!m.shiftErrorCounts[crew]) m.shiftErrorCounts[crew] = {};
    if (!m.shiftErrorCounts[crew][code]) m.shiftErrorCounts[crew][code] = { count: 0, totalSecs: 0 };
    m.shiftErrorCounts[crew][code].count++;

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

      // ── ClickHouse dual-write: one complete fact row per closed event ──
      // Additive, buffered, never throws into this handler. ClickHouse keeps
      // these indefinitely (no 48h cap) so Downtime Analytics has full history.
      if (CLICKHOUSE_ENABLED) {
        const startedAt = ev ? new Date(ev.started_at) : now;
        chErrorBuffer.push({
          machine_id: machineId,
          machine_code: machineCode,
          error_code: code,
          shift_crew: crew,
          started_at: startedAt.toISOString(),
          ended_at: now.toISOString(),
          duration_secs: durationSecs,
          ingested_at: new Date().toISOString(),
        });
      }

      // Add duration to in-memory shift aggregation
      if (m.shiftErrorCounts[crew]?.[code]) {
        m.shiftErrorCounts[crew][code].totalSecs += durationSecs;
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
    const keys = ["downtime_alert_config", "shift_config", "shift_mechanics", "factory_timezone"];
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
      if (row.key === "factory_timezone" && row.value) factoryTimezone = row.value;
    }
    logger.debug(`Alert config loaded: enabled=${alertConfig.enabled}, threshold=${alertConfig.threshold_minutes}min, tz=${factoryTimezone}`);

    // Cache shift assignments for the current month (covers today and nearby days)
    await loadShiftAssignments();
  } catch (err) {
    logger.error(`loadAlertConfig error: ${err.message}`);
  }
}

/**
 * Load shift assignments for a window around today so we can resolve crew names.
 * Cached in shiftAssignmentsCache keyed by date string (YYYY-MM-DD).
 */
async function loadShiftAssignments() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 2); // 2 days back (overnight shifts)
  const to = new Date(today);
  to.setDate(to.getDate() + 1); // 1 day ahead
  const fromStr = from.toISOString().slice(0, 10);
  const toStr = to.toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("shift_assignments")
    .select("shift_date, slot_teams, day_team, night_team")
    .gte("shift_date", fromStr)
    .lte("shift_date", toStr);

  if (error) {
    logger.error(`Failed to load shift assignments: ${error.message}`);
    return;
  }

  shiftAssignmentsCache = {};
  for (const row of data || []) {
    const raw = row.slot_teams;
    const hasSlotTeams = Array.isArray(raw) && raw.length > 0;
    shiftAssignmentsCache[row.shift_date] = hasSlotTeams
      ? raw
      : [row.day_team || null, row.night_team || null];
  }
  logger.debug(`Cached shift assignments for ${Object.keys(shiftAssignmentsCache).length} days`);
}

/**
 * Resolve the crew name currently on duty based on shift config + schedule.
 * Returns the crew name string or null if no assignment exists.
 */
function resolveCurrentCrew(timestamp) {
  if (!shiftConfig || !shiftConfig.slots || shiftConfig.slots.length === 0) {
    return null;
  }

  const now = timestamp ? new Date(timestamp) : new Date();

  // Convert to factory-local time using Intl (works correctly on UTC servers)
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: factoryTimezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(now)) {
    parts[type] = parseInt(value, 10);
  }
  const currentHour = parts.hour + parts.minute / 60;
  const firstStart = shiftConfig.firstShiftStartHour || 0;
  const duration = shiftConfig.shiftDurationHours || 12;

  // Determine slot index
  const hoursSinceFirst = ((currentHour - firstStart) + 24) % 24;
  const slotIndex = Math.floor(hoursSinceFirst / duration);

  // Determine work date in factory timezone (if before first shift start, use yesterday)
  const localYear  = parts.year;
  const localMonth = String(parts.month).padStart(2, "0");
  const localDay   = String(parts.day).padStart(2, "0");
  let dateStr = `${localYear}-${localMonth}-${localDay}`;
  if (currentHour < firstStart) {
    const yesterday = new Date(localYear, parts.month - 1, parts.day - 1);
    const y = yesterday.getFullYear();
    const m = String(yesterday.getMonth() + 1).padStart(2, "0");
    const d = String(yesterday.getDate()).padStart(2, "0");
    dateStr = `${y}-${m}-${d}`;
  }

  const teams = shiftAssignmentsCache[dateStr];
  if (!teams || !teams[slotIndex]) {
    return null;
  }

  return teams[slotIndex];
}

/**
 * Resolve the crew for an incoming MQTT message.
 *
 * Same as resolveCurrentCrew(data.Timestamp) except SAVE messages — which carry
 * the just-ended shift's cumulative totals — are pinned to one second before
 * their wall-clock timestamp. Without this nudge a SAVE message published at
 * the exact shift boundary (e.g. 19:00:00.000) would be tagged with the NEW
 * crew, even though its payload is entirely the previous crew's data.
 */
function resolveMessageCrew(data) {
  const ts = data?.Timestamp;
  if (!ts) return resolveCurrentCrew();
  if (data?.Save === true) {
    const adjusted = new Date(new Date(ts).getTime() - 1000).toISOString();
    return resolveCurrentCrew(adjusted);
  }
  return resolveCurrentCrew(ts);
}

/**
 * Resolve which shift crew is currently active, then find the assigned mechanic.
 * Returns { mechanicId, phone, crewName } or null.
 */
async function resolveCurrentMechanic() {
  const crewName = resolveCurrentCrew();
  if (!crewName) {
    logger.warn("No crew resolved for current shift, cannot resolve mechanic");
    return null;
  }

  const mechanicId = shiftMechanics[crewName] || null;
  if (!mechanicId) {
    logger.warn(`No mechanic assigned to crew ${crewName}`);
    return null;
  }

  // Look up mechanic's phone
  const { data: profile, error: profErr } = await supabase
    .from("user_profiles")
    .select("first_name, last_name, mechanic_phone")
    .eq("id", mechanicId)
    .single();

  if (profErr || !profile || !profile.mechanic_phone) {
    logger.warn(`Mechanic ${mechanicId} has no phone number`);
    return null;
  }

  return {
    mechanicId,
    phone: profile.mechanic_phone,
    name: `${profile.first_name} ${profile.last_name}`.trim(),
    crewName,
  };
}

/**
 * Send an SMS downtime alert via Twilio and log to notification_log.
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

    const params = {
      From: TWILIO_FROM,
      To: mechanic.phone,
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
      logger.info(`SMS alert sent to ${mechanic.name} for ${machine.machine}`);
    } else {
      logger.error(`Twilio error for ${machine.machine}: ${result.message || resp.status}`);
    }
  } catch (err) {
    logger.error(`Failed to send SMS alert for ${machine.machine}: ${err.message}`);
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
    const topics = getSubscribeTopics();
    mqttClient.subscribe(topics, { qos: 1 }, (err) => {
      if (err) {
        logger.error(`Subscribe failed: ${err.message}`);
      } else {
        logger.info(`Subscribed to: ${topics.join(", ")}`);
      }
    });
  });

  mqttClient.on("message", async (topic, message) => {
    try {
      const payload = message.toString();

      if (topic.startsWith("Error/") || topic.includes("Error")) {
        await handleErrorMessage(payload);
      } else if (topic.startsWith("Status/") || topic.includes("Shift") || topic.includes("local/")) {
        await handleShiftMessage(payload);
      }
      // All other topics are silently ignored
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

  // Staleness sweep: mark machines as "offline" if no MQTT message in 60 seconds.
  // Also updates Supabase so the dashboard reflects reality even after a page reload.
  const STALE_TIMEOUT_MS = 60 * 1000;
  setInterval(async () => {
    const now = Date.now();
    for (const [code, m] of Object.entries(allMachines)) {
      if (!m.lastSync) continue;
      const age = now - new Date(m.lastSync).getTime();
      const currentStatus = (m.machineStatus?.Status || "").toLowerCase();
      if (age > STALE_TIMEOUT_MS && currentStatus !== "offline") {
        logger.info(`Marking ${code} as offline (no MQTT for ${Math.round(age / 1000)}s)`);
        m.machineStatus = { ...m.machineStatus, Status: "offline", Speed: 0 };
        m.statusSince = new Date().toISOString();
        m.activeErrors = [];
        // Persist to DB
        const machineId = machineIdCache[code];
        if (machineId) {
          await supabase.from("machines").update({
            status: "offline",
            speed: 0,
            status_since: m.statusSince,
            active_error_codes: [],
          }).eq("id", machineId);
        }
      }
    }
  }, 15000);
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
    currentCrew,
    shiftStartedAt,
  });
});

// ── Analytics: fleet trend from ClickHouse (Phase 3, full granularity ladder) ──
// Read-only proxy so the browser never touches ClickHouse directly. Returns the
// same row shape the frontend already consumes (avg_uptime/avg_scrap/totals +
// production/idle/error seconds for the corrected-uptime tile). The reset-aware
// delta math lives in the views; here we just pick grain + filter range/machines.
//
// granularity: 5s | 5m | 1h | 1d. 5s reads the per-reading delta view; 5m/1h/1d
// roll up the validated 5-min deltas (1d = factory work-day, -7h Europe/Zurich).
const TREND_GRAN = {
  "5s": { src: "v_bucket_deltas_5s", per: 5,   ts: "bucket_ts",                                                              label: "%Y-%m-%dT%H:%i:%S" },
  "5m": { src: "v_bucket_deltas_5m", per: 300, ts: "bucket_ts",                                                              label: "%Y-%m-%dT%H:%i" },
  "1h": { src: "v_bucket_deltas_5m", per: 300, ts: "toStartOfInterval(bucket_ts, INTERVAL 1 HOUR)",                          label: "%Y-%m-%dT%H:00" },
  "1d": { src: "v_bucket_deltas_5m", per: 300, ts: "toDate(toTimeZone(bucket_ts, 'Europe/Zurich'))",                         label: null },
};
app.get("/api/analytics/fleet-trend", async (req, res) => {
  if (!clickhouse) return res.status(503).json({ error: "ClickHouse not enabled on this bridge" });
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end (ISO) required" });
  const fmt = (s) => new Date(s).toISOString().slice(0, 19).replace("T", " ");  // -> CH 'YYYY-MM-DD HH:MM:SS'
  const machines = req.query.machines ? String(req.query.machines).split(",").filter(Boolean) : [];
  const gran = String(req.query.granularity);
  const g = TREND_GRAN[gran] || TREND_GRAN["5m"];   // whitelist -> no injection

  // ── Bucket-grid snapping (makes the cache real) ──────────────────────────
  // The chart only ever renders complete buckets, so the exact sub-bucket
  // second of `end` is irrelevant to the result. We snap `start` DOWN and
  // `end` UP to the bucket grid so the query text is byte-identical for every
  // reload within the same window. `end` rounds up into the empty future, so
  // no rendered data point changes. With a stable query the ClickHouse query
  // cache (below) and the HTTP cache both actually hit instead of recomputing.
  const Q_MS = { "5s": 5_000, "5m": 300_000, "1h": 3_600_000, "1d": 3_600_000 };
  const qms = Q_MS[gran] || 300_000;
  const startSnap = new Date(Math.floor(new Date(start).getTime() / qms) * qms);
  const endSnap   = new Date(Math.ceil(new Date(end).getTime()  / qms) * qms);
  const bucketSel = g.label ? `formatDateTime(${g.ts}, '${g.label}')` : `toString(${g.ts})`;

  // 5m/1h/1d read the pre-aggregated MV (fast). 5s reads RAW with window funcs,
  // so the time filter MUST be pushed into the raw scan — otherwise the window
  // runs over the whole table (104M rows -> timeout). 30s margin keeps the first
  // in-window bucket's delta anchor.
  const query5s = `
    SELECT
      formatDateTime(bucket_ts, '%Y-%m-%dT%H:%i:%S')                                  AS bucket,
      round(sum(delta_prod_t) / (count() * 5) * 100, 1)                               AS avg_uptime,
      if(sum(delta_swabs) > 0, round(sum(delta_discard) / sum(delta_swabs) * 100, 1), 0) AS avg_scrap,
      toInt64(sum(delta_boxes))   AS total_boxes,   toInt64(sum(delta_swabs)) AS total_swabs,
      uniqExact(machine_id)       AS machine_count, toInt64(sum(reading_count)) AS reading_count,
      uniqExact(shift_crew)       AS shift_count,
      toInt64(sum(delta_prod_t))  AS production_seconds,
      toInt64(sum(delta_idle_t))  AS idle_seconds,  toInt64(sum(delta_error_t)) AS error_seconds
    FROM (
      SELECT machine_id, shift_crew, bucket_ts, reading_count,
        if(rn=1,0, if(max_swabs<anc_swabs, max_swabs-min_swabs, max_swabs-anc_swabs))       AS delta_swabs,
        if(rn=1,0, if(max_boxes<anc_boxes, max_boxes-min_boxes, max_boxes-anc_boxes))       AS delta_boxes,
        if(rn=1,0, if(max_prod_t<anc_prod_t, max_prod_t-min_prod_t, max_prod_t-anc_prod_t)) AS delta_prod_t,
        if(rn=1,0, if(max_idle_t<anc_idle_t, max_idle_t-min_idle_t, max_idle_t-anc_idle_t)) AS delta_idle_t,
        if(rn=1,0, if(max_error_t<anc_error_t, max_error_t-min_error_t, max_error_t-anc_error_t)) AS delta_error_t,
        if(rn=1,0, if(max_discard<anc_discard, max_discard-min_discard, max_discard-anc_discard)) AS delta_discard
      FROM (
        SELECT *, row_number() OVER w AS rn,
          lagInFrame(max_swabs) OVER w AS anc_swabs, lagInFrame(max_boxes) OVER w AS anc_boxes,
          lagInFrame(max_prod_t) OVER w AS anc_prod_t, lagInFrame(max_idle_t) OVER w AS anc_idle_t,
          lagInFrame(max_error_t) OVER w AS anc_error_t, lagInFrame(max_discard) OVER w AS anc_discard
        FROM (
          SELECT machine_id, toStartOfInterval(plc_timestamp, INTERVAL 5 SECOND) AS bucket_ts,
            argMax(shift_crew, plc_timestamp) AS shift_crew,
            max(produced_swabs) AS max_swabs, min(produced_swabs) AS min_swabs,
            max(produced_boxes) AS max_boxes, min(produced_boxes) AS min_boxes,
            max(production_time_seconds) AS max_prod_t, min(production_time_seconds) AS min_prod_t,
            max(idle_time_seconds) AS max_idle_t, min(idle_time_seconds) AS min_idle_t,
            max(error_time_seconds) AS max_error_t, min(error_time_seconds) AS min_error_t,
            max(discarded_swabs) AS max_discard, min(discarded_swabs) AS min_discard,
            count() AS reading_count
          FROM shift_readings
          WHERE plc_timestamp >= (toDateTime64({start:String}, 3, 'UTC') - INTERVAL 30 SECOND)
            AND plc_timestamp <  toDateTime64({end:String}, 3, 'UTC')
            AND plc_timestamp IS NOT NULL AND shift_readings.shift_crew != ''
            AND (length({machines:Array(String)}) = 0 OR machine_id IN {machines:Array(String)})
          GROUP BY machine_id, bucket_ts
        ) WINDOW w AS (PARTITION BY machine_id ORDER BY bucket_ts)
      ) WHERE bucket_ts >= toDateTime64({start:String}, 3, 'UTC')
    )
    GROUP BY bucket_ts
    ORDER BY bucket_ts`;

  const queryAgg = `
        SELECT
          ${bucketSel}                                                                  AS bucket,
          round(sum(delta_prod_t) / (count() * ${g.per}) * 100, 1)                      AS avg_uptime,
          if(sum(delta_swabs) > 0, round(sum(delta_discard) / sum(delta_swabs) * 100, 1), 0) AS avg_scrap,
          toInt64(sum(delta_boxes))                                                     AS total_boxes,
          toInt64(sum(delta_swabs))                                                     AS total_swabs,
          uniqExact(machine_id)                                                         AS machine_count,
          toInt64(sum(reading_count))                                                   AS reading_count,
          uniqExact(shift_crew)                                                         AS shift_count,
          toInt64(sum(delta_prod_t))                                                    AS production_seconds,
          toInt64(sum(delta_idle_t))                                                    AS idle_seconds,
          toInt64(sum(delta_error_t))                                                   AS error_seconds
        FROM ${g.src}
        WHERE bucket_ts >= toDateTime64({start:String}, 3, 'UTC')
          AND bucket_ts <  toDateTime64({end:String}, 3, 'UTC')
          AND (length({machines:Array(String)}) = 0 OR machine_id IN {machines:Array(String)})
        GROUP BY ${g.ts}
        ORDER BY ${g.ts}`;

  try {
    const rs = await clickhouse.query({
      query: gran === "5s" ? query5s : queryAgg,
      query_params: { start: fmt(startSnap), end: fmt(endSnap), machines },
      // Fail fast + legibly: a runaway query is killed at 20s (and returns a
      // clear error the endpoint surfaces as 500) instead of hanging ~90s.
      // use_query_cache: identical (snapped) queries within the window return
      // the cached result instead of recomputing — a reload no longer re-scans
      // ClickHouse. TTL = the window length so it expires exactly when a new
      // bucket can appear.
      clickhouse_settings: {
        max_execution_time: 20,
        use_query_cache: 1,
        query_cache_ttl: Math.ceil(qms / 1000),
      },
      format: "JSONEachRow",
    });
    const payload = await rs.json();
    // Let the browser serve a reload straight from its HTTP cache until the
    // next bucket boundary — no request reaches the bridge at all.
    res.set("Cache-Control", `public, max-age=${Math.ceil(qms / 1000)}`);
    res.json(payload);
  } catch (err) {
    logger.error(`fleet-trend query failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Crew shift reconstruction (Crew Comparison tab on ClickHouse) ──────────
// Rebuilds one row per shift from the 5-minute delta view. A shift = a
// contiguous run of the same crew on a machine (segmented by crew change). We
// sum the reset-aware per-bucket deltas across that run (output, boxes,
// discards, producing seconds) and derive the shift's uptime the same way the
// fleet trend does (producing seconds / elapsed). The returned rows mirror the
// saved_shift_logs column shape so the frontend runs the *identical*
// aggregation it uses for the Supabase path — only the data source differs.
app.get("/api/analytics/crew-shifts", async (req, res) => {
  if (!clickhouse) return res.status(503).json({ error: "ClickHouse not enabled on this bridge" });
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end (ISO) required" });
  const fmt = (s) => new Date(s).toISOString().slice(0, 19).replace("T", " ");
  const machines = req.query.machines ? String(req.query.machines).split(",").filter(Boolean) : [];

  // Snap to a 1h grid so reloads within the hour reuse the cached result.
  const Q_MS = 3_600_000;
  const startSnap = new Date(Math.floor(new Date(start).getTime() / Q_MS) * Q_MS);
  const endSnap   = new Date(Math.ceil(new Date(end).getTime()  / Q_MS) * Q_MS);

  const query = `
    SELECT
      machine_id,
      any(machine_code)                                   AS machine_code,
      any(shift_crew)                                     AS shift_crew,
      toInt64(sum(delta_swabs))                           AS produced_swabs,
      toInt64(sum(delta_boxes))                           AS produced_boxes,
      toInt64(sum(delta_discard))                         AS discarded_swabs,
      toInt64(sum(delta_prod_t))                          AS production_time_seconds,
      round(sum(delta_prod_t) / (count() * 300) * 100, 1) AS efficiency,
      concat(formatDateTime(max(bucket_ts), '%Y-%m-%dT%H:%i:%S'), 'Z') AS saved_at
    FROM (
      SELECT *,
        sum(seg_start) OVER (PARTITION BY machine_id ORDER BY bucket_ts
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS seg_id
      FROM (
        SELECT machine_id, machine_code, shift_crew, bucket_ts,
               delta_swabs, delta_boxes, delta_discard, delta_prod_t,
               if(shift_crew != lagInFrame(shift_crew, 1, '') OVER w, 1, 0) AS seg_start
        FROM v_bucket_deltas_5m
        WHERE bucket_ts >= toDateTime64({start:String}, 3, 'UTC')
          AND bucket_ts <  toDateTime64({end:String}, 3, 'UTC')
          AND shift_crew != ''
          AND (length({machines:Array(String)}) = 0 OR machine_id IN {machines:Array(String)})
        WINDOW w AS (PARTITION BY machine_id ORDER BY bucket_ts)
      )
    )
    GROUP BY machine_id, seg_id
    ORDER BY saved_at`;

  try {
    const rs = await clickhouse.query({
      query,
      query_params: { start: fmt(startSnap), end: fmt(endSnap), machines },
      clickhouse_settings: {
        max_execution_time: 20,
        use_query_cache: 1,
        query_cache_ttl: Math.ceil(Q_MS / 1000),
      },
      format: "JSONEachRow",
    });
    const payload = await rs.json();
    res.set("Cache-Control", `public, max-age=${Math.ceil(Q_MS / 1000)}`);
    res.json(payload);
  } catch (err) {
    logger.error(`crew-shifts query failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Downtime Analytics: per error code / machine / crew / day aggregation from
// the ClickHouse error_events mirror. Returns the exact ErrorShiftSummaryRow
// shape produced by the Supabase RPC get_error_shift_summary, so the frontend
// treats both backends identically.
app.get("/api/analytics/downtime-summary", async (req, res) => {
  if (!clickhouse) return res.status(503).json({ error: "ClickHouse not enabled on this bridge" });
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end (ISO) required" });
  const fmt = (s) => new Date(s).toISOString().slice(0, 19).replace("T", " ");

  // Snap to a 1d grid (matching the frontend) so reloads within the day reuse
  // the cached result and the cache key stays stable. shift_date buckets by
  // toDate(started_at) in UTC, mirroring the Supabase RPC's started_at::DATE.
  const Q_MS = 86_400_000;
  const startSnap = new Date(Math.floor(new Date(start).getTime() / Q_MS) * Q_MS);
  const endSnap   = new Date(Math.ceil(new Date(end).getTime()  / Q_MS) * Q_MS);

  const query = `
    SELECT
      machine_id,
      any(machine_code)            AS machine_code,
      toString(toDate(started_at)) AS shift_date,
      shift_crew,
      error_code,
      toInt32(count())             AS occurrence_count,
      toInt32(sum(duration_secs))  AS total_duration_secs
    FROM error_events
    WHERE started_at >= toDateTime64({start:String}, 3, 'UTC')
      AND started_at <  toDateTime64({end:String}, 3, 'UTC')
    GROUP BY machine_id, shift_date, shift_crew, error_code
    ORDER BY shift_date`;

  try {
    const rs = await clickhouse.query({
      query,
      query_params: { start: fmt(startSnap), end: fmt(endSnap) },
      clickhouse_settings: {
        max_execution_time: 20,
        use_query_cache: 1,
        query_cache_ttl: 3600,
      },
      format: "JSONEachRow",
    });
    const payload = await rs.json();
    res.set("Cache-Control", "public, max-age=3600");
    res.json(payload);
  } catch (err) {
    logger.error(`downtime-summary query failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
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
    subscribeTopics: getSubscribeTopics(),
  });
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || process.env.API_PORT || 3001;

app.listen(PORT, () => {
  logger.info(`FALU PMS Bridge API v2 running on port ${PORT} (process.env.PORT=${process.env.PORT ?? "unset"})`);
  logger.info(`MQTT Broker: ${brokerSettings.host}:${brokerSettings.port} (${brokerSettings.isLocal ? "local" : "cloud"})`);
  logger.info(`Topics: ${getSubscribeTopics().join(", ")}`);

  loadRegisteredMachines()
    .then(() => restoreNotificationTimestamps())
    .then(() => restoreOpenErrorEvents())
    .then(() => loadAlertConfig())
    .then(() => connectMqtt())
    .catch((err) => logger.error(`Startup error: ${err.message}`));

  // Reload alert config every 60 seconds so admin changes take effect without restart
  setInterval(() => loadAlertConfig(), 60000);

  // Periodic cleanup: delete shift_readings and error_events older than 48h (every hour)
  periodicCleanup(); // run once on startup
  setInterval(() => periodicCleanup(), 60 * 60 * 1000);

  // Data-quality monitor: polls data_quality_alerts (filled by pg_cron job
  // `data-quality-check`, migration 095) and posts a Claude root-cause report
  // to Slack when impossible values appear. Cheap until an incident fires.
  startDataQualityMonitor({ supabase, logger });
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal} — shutting down`);
  if (mqttClient) mqttClient.end(true);
  try { await flushShiftReadings(); } catch (e) { logger.error(`shutdown flush failed: ${e.message}`); }
  try { await flushClickHouse(); } catch (e) { logger.error(`shutdown CH flush failed: ${e.message}`); }
  try { await flushClickHouseErrors(); } catch (e) { logger.error(`shutdown CH error flush failed: ${e.message}`); }
  process.exit(0);
}

process.on("SIGINT",  () => { gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });

// Log crashes so Railway deploy logs show the cause
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err.message, err.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason instanceof Error ? reason.stack : reason);
});
