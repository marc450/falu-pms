/**
 * FALU PMS - MQTT Bridge + REST API (v2 — combined topic)
 *
 * Subscribes to a single unified topic from cotton swab machines:
 *   - cloud/Shift  → Combined status + shift data (every 5 s)
 *   - cloud/Error   → Active error codes per machine (future)
 *
 * Historical shift data is stored in Supabase; the bridge no longer
 * publishes RequestShift — the dashboard reads past shifts from the DB.
 *
 * MQTT Topic Structure:
 *   Subscribe: cloud/# (or local/#)
 *     - cloud/Shift  → unified machine message (status + production)
 *     - cloud/Error   → error code list (future)
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
// }

let mqttConnected = false;
let currentShiftNumber = 1;
let shiftStartedAt = Date.now();

// Persist/restore shift state so a bridge restart doesn't lose the start time
const SHIFT_STATE_FILE = path.join(__dirname, "..", "shift-state.json");

function saveShiftState() {
  try {
    fs.writeFileSync(SHIFT_STATE_FILE, JSON.stringify({ currentShiftNumber, shiftStartedAt }));
  } catch (e) { /* non-fatal */ }
}

function loadShiftState() {
  try {
    const raw = fs.readFileSync(SHIFT_STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (s.currentShiftNumber) currentShiftNumber = s.currentShiftNumber;
    if (s.shiftStartedAt)    shiftStartedAt    = s.shiftStartedAt;
  } catch (e) { /* file doesn't exist yet — use defaults */ }
}

loadShiftState();

// Machine cache: machine_code -> UUID
const machineIdCache = {};

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
    .select("id, machine_code, status, error_message, active_shift, speed, current_swabs, current_boxes, current_efficiency, current_reject, last_sync_status, last_sync_shift, status_since")
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
          ProducedSwabs: row.current_swabs || 0,
          ProducedBoxes: row.current_boxes || 0,
          Efficiency: row.current_efficiency || 0,
          Reject: row.current_reject || 0,
        },
        lastSync: row.last_sync_status || row.last_sync_shift || null,
        statusSince: row.status_since || new Date().toISOString(),
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
    allMachines[machineCode] = { machine: machineCode };
  }
  const m = allMachines[machineCode];

  // Shift change detection — track globally for BU run rate
  const prevShift = m.machineStatus?.Shift;
  const incomingShift = data.Shift || currentShiftNumber;
  if (prevShift !== undefined && incomingShift && prevShift !== incomingShift) {
    logger.info(`Machine ${machineCode} shift ${prevShift}→${incomingShift}`);
  }
  if (incomingShift !== currentShiftNumber) {
    currentShiftNumber = incomingShift;
    shiftStartedAt = Date.now();
    saveShiftState();
    logger.info(`Global shift changed to ${currentShiftNumber} at ${new Date(shiftStartedAt).toISOString()}`);
  }

  // ── Status transition detection for statusSince timer ──
  const prevStatus = (m.machineStatus?.Status || "").toLowerCase();
  const nextStatus = (data.Status || "offline").toLowerCase();
  if (prevStatus !== nextStatus) {
    m.statusSince = new Date().toISOString();
    logger.info(`Status change for ${machineCode}: ${prevStatus || "(none)"}→${nextStatus} at ${m.statusSince}`);
  }
  if (!m.statusSince) {
    m.statusSince = new Date().toISOString();
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
    status: (data.Status || "offline").toLowerCase(),
    error_message: null, // errors now come via cloud/Error
    active_shift: data.Shift || 1,
    speed: data.Speed || 0,
    current_swabs: data.ProducedSwabs || 0,
    current_boxes: data.ProducedBoxes || 0,
    current_efficiency: data.Efficiency || 0,
    current_reject: data.Reject || 0,
    last_sync_status: now,
    hidden: false,
  };
  // Persist statusSince on status change
  if (prevStatus !== nextStatus) {
    updatePayload.status_since = m.statusSince;
  }
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
    await supabase.from("shift_readings").insert({
      machine_id: machineId,
      shift_number: data.Shift,
      status: (data.Status || "run").toLowerCase(),
      speed: data.Speed || 0,
      production_time: data.ProductionTime || 0,
      idle_time: data.IdleTime || 0,
      cotton_tears: 0,           // no longer in payload — will come via cloud/Error
      missing_sticks: 0,
      faulty_pickups: 0,
      other_errors: 0,
      produced_swabs: data.ProducedSwabs || 0,
      packaged_swabs: data.PackagedSwabs || 0,
      produced_boxes: data.ProducedBoxes || 0,
      produced_boxes_layer_plus: 0,
      discarded_swabs: data.DiscardedSwabs || 0,
      efficiency: data.Efficiency || 0,
      reject_rate: data.Reject || 0,
      save_flag: data.Save || false,
      raw_payload: data,
    });

    await supabase
      .from("machines")
      .update({ last_sync_shift: now })
      .eq("id", machineId);
  }

  if (data.Save) {
    logger.info(`Save flag (end of shift) received for ${machineCode}, Shift ${data.Shift}`);
    await supabase.from("saved_shift_logs").insert({
      machine_id:               machineId,
      machine_code:             machineCode,
      shift_number:             data.Shift,
      production_time:          Math.round(data.ProductionTime  || 0),
      idle_time:                Math.round(data.IdleTime        || 0),
      cotton_tears:             data.CottonTears               || 0,
      missing_sticks:           data.MissingSticks             || 0,
      faulty_pickups:           data.FoultyPickups             || 0,
      other_errors:             data.OtherErrors               || 0,
      produced_swabs:           data.ProducedSwabs             || 0,
      packaged_swabs:           data.PackagedSwabs             || 0,
      produced_boxes:           data.ProducedBoxes             || 0,
      produced_boxes_layer_plus: data.ProducedBoxesLayerPlus   || 0,
      discarded_swabs:          data.DiscardedSwabs            || 0,
      efficiency:               data.Efficiency                || 0,
      reject_rate:              data.Reject                    || 0,
    });
  }

  logger.debug(`Shift updated: ${machineCode} - ${data.Status} | Shift ${data.Shift} | Speed: ${data.Speed} | Eff: ${data.Efficiency}%`);
}

// ============================================
// ERROR MESSAGE HANDLER (future — cloud/Error)
// ============================================
// Expected payload: { Machine: "CB-30", Errors: [101, 205, 310] }
// For now, just log it. Full implementation after Sebastian ships PLC changes.
async function handleErrorMessage(payload) {
  const data = JSON.parse(payload);
  const machineCode = data.Machine;
  if (!machineCode) return;

  const errorCodes = data.Errors || [];
  logger.info(`Error codes for ${machineCode}: [${errorCodes.join(", ")}]`);

  // Update in-memory state
  if (!allMachines[machineCode]) {
    allMachines[machineCode] = { machine: machineCode };
  }
  allMachines[machineCode].activeErrors = errorCodes;

  // TODO: persist error codes to Supabase once schema is ready
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
    .then(() => connectMqtt())
    .catch((err) => logger.error(`Startup error: ${err.message}`));
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
