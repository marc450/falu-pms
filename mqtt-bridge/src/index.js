/**
 * FALU PMS - MQTT Bridge + REST API
 *
 * Two-way MQTT bridge that:
 * 1. Subscribes to Status and Shift topics from cotton swab machines
 * 2. Can publish RequestShift messages back to machines
 * 3. Persists data to Supabase and CSV files
 * 4. Exposes a REST API for the frontend
 *
 * MQTT Topic Structure (matching developer's Blazor implementation):
 *   Subscribe: cloud/# (or local/#)
 *     - cloud/Status  → MachineStatus messages
 *     - cloud/Shift   → ShiftData messages
 *   Publish:
 *     - cloud/RequestShift → Request shift data from a machine
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

// Ensure log directories exist
fs.mkdirSync("logs", { recursive: true });
fs.mkdirSync("csv_logs/machines", { recursive: true });

// ============================================
// SUPABASE
// ============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// IN-MEMORY STATE (mirrors developer's AllMachines dictionary)
// ============================================
const allMachines = {};
// Structure per machine:
// {
//   machine: "M12",
//   machineStatus: { Machine, Status, Error, ActShift, Speed, Swaps, Boxes, Efficiency, Reject },
//   shift1: { ...shift data },
//   shift2: { ...shift data },
//   shift3: { ...shift data },
//   total: { ...shift data },
//   lastSyncStatus: Date,
//   lastSyncShift: Date,
//   lastRequestShift: Date,
// }

let mqttConnected = false;
let currentShiftNumber = 1;
let shiftStartedAt = Date.now(); // wall-clock ms when current shift began

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

function getPublishTopicPrefix() {
  return brokerSettings.isLocal ? "local" : "cloud";
}

// ============================================
// STARTUP: LOAD ALL REGISTERED MACHINES
// Ensures every machine in the DB appears on the dashboard,
// even if it hasn't sent MQTT data yet this session.
// ============================================
async function loadRegisteredMachines() {
  const { data, error } = await supabase
    .from("machines")
    .select("id, machine_code, status, error_message, active_shift, speed, current_swaps, current_boxes, current_efficiency, current_reject, last_sync_status, last_sync_shift")
    .eq("hidden", false)
    .order("machine_code");

  if (error) {
    logger.error(`Failed to load registered machines: ${error.message}`);
    return;
  }

  for (const row of data) {
    const code = row.machine_code;
    // Pre-populate cache so getMachineId() doesn't need a DB round-trip
    machineIdCache[code] = row.id;

    // Only seed if no live MQTT data has arrived yet for this machine
    if (!allMachines[code]) {
      allMachines[code] = {
        machine: code,
        machineStatus: {
          Machine: code,
          Status: row.status || "offline",
          Error: row.error_message || "",
          ActShift: row.active_shift || 0,
          Speed: row.speed || 0,
          Swabs: row.current_swabs || 0,
          Boxes: row.current_boxes || 0,
          Efficiency: row.current_efficiency || 0,
          Reject: row.current_reject || 0,
        },
        lastSyncStatus: row.last_sync_status || null,
        lastSyncShift: row.last_sync_shift || null,
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
// STATUS MESSAGE HANDLER
// ============================================
async function handleStatusMessage(payload) {
  const data = JSON.parse(payload);
  const machineCode = data.Machine;
  if (!machineCode) return;

  // Update in-memory state
  if (!allMachines[machineCode]) {
    allMachines[machineCode] = { machine: machineCode };
  }

  // Per-machine shift change detection — reset Swaps/Boxes immediately
  // so the dashboard shows 0 for the new shift, not stale values from the old one.
  const prevActShift = allMachines[machineCode].machineStatus?.ActShift;
  const incomingActShift = data.ActShift;
  if (prevActShift !== undefined && incomingActShift && prevActShift !== incomingActShift) {
    data.Swabs = 0;
    data.Boxes = 0;
    logger.info(`Machine ${machineCode} shift ${prevActShift}→${incomingActShift}: reset Swaps/Boxes`);
  }

  allMachines[machineCode].machineStatus = data;
  allMachines[machineCode].lastSyncStatus = new Date();

  // Global shift tracking (used for shiftStartedAt / BU run rate)
  const incomingShift = data.ActShift || currentShiftNumber;
  if (incomingShift !== currentShiftNumber) {
    currentShiftNumber = incomingShift;
    shiftStartedAt = Date.now();
    saveShiftState();
    logger.info(`Global shift changed to ${currentShiftNumber} at ${new Date(shiftStartedAt).toISOString()}`);
  }

  // Update Supabase
  const machineId = await getMachineId(machineCode);
  if (!machineId) return;

  await supabase
    .from("machines")
    .update({
      status: (data.Status || "offline").toLowerCase(),
      error_message: data.Error || null,
      active_shift: data.ActShift || 1,
      speed: data.Speed || 0,
      current_swabs: data.Swabs || 0,
      current_boxes: data.Boxes || 0,
      current_efficiency: data.Efficiency || 0,
      current_reject: data.Reject || 0,
      last_sync_status: new Date().toISOString(),
      hidden: false,  // un-hide automatically when machine sends data again
    })
    .eq("id", machineId);

  logger.debug(`Status updated: ${machineCode} - ${data.Status} | Speed: ${data.Speed} | Eff: ${data.Efficiency}%`);
}

// ============================================
// SHIFT MESSAGE HANDLER
// ============================================
async function handleShiftMessage(payload) {
  const data = JSON.parse(payload);
  const machineCode = data.Machine;
  if (!machineCode) return;

  // Check if data has meaningful content
  const hasData = (data.ProductionTime || 0) > 0 ||
                  (data.IdleTime || 0) > 0 ||
                  (data.ProducedSwabs || 0) > 0 ||
                  (data.ProducedBoxes || 0) > 0;

  // Update in-memory state
  if (!allMachines[machineCode]) {
    allMachines[machineCode] = { machine: machineCode };
  }

  const m = allMachines[machineCode];
  const shiftKey = data.Shift === 4 ? "total" : `shift${data.Shift}`;

  // Only update if we have data or slot is empty (mirrors developer logic)
  if (hasData || !m[shiftKey]) {
    m[shiftKey] = data;
    if (hasData) m.lastSyncShift = new Date();
    logger.debug(`${shiftKey} updated for ${machineCode} - HasData: ${hasData}`);
  } else {
    logger.debug(`${shiftKey} update skipped for ${machineCode} - empty data`);
  }

  // Persist to Supabase
  const machineId = await getMachineId(machineCode);
  if (!machineId) return;

  if (hasData) {
    await supabase.from("shift_readings").insert({
      machine_id: machineId,
      shift_number: data.Shift,
      status: (allMachines[machineCode]?.machineStatus?.Status || "run").toLowerCase(),
      speed: allMachines[machineCode]?.machineStatus?.Speed || 0,
      production_time: data.ProductionTime || 0,
      idle_time: data.IdleTime || 0,
      cotton_tears: data.CottonTears || 0,
      missing_sticks: data.MissingSticks || 0,
      faulty_pickups: data.FoultyPickups || 0,
      other_errors: data.OtherErrors || 0,
      produced_swabs: data.ProducedSwabs || 0,
      packaged_swabs: data.PackagedSwabs || 0,
      produced_boxes: data.ProducedBoxes || 0,
      produced_boxes_layer_plus: data.ProducedBoxesLayerPlus || 0,
      discarded_swabs: data.DiscardedSwabs || 0,
      efficiency: data.Efficiency || 0,
      reject_rate: data.Reject || 0,
      save_flag: data.Save || false,
    });

    await supabase
      .from("machines")
      .update({ last_sync_shift: new Date().toISOString() })
      .eq("id", machineId);
  }

  // CSV logging when Save flag is true
  if (data.Save) {
    logger.info(`Save flag received for ${machineCode}, Shift ${data.Shift} - Logging...`);
    logToCsv(data);
    await logToSavedShiftLogs(machineId, machineCode, data);
  }
}

// ============================================
// CSV LOGGING (matches developer's format exactly)
// ============================================
function formatMinutesToTime(minutes) {
  if (!minutes || minutes === 0) return "00:00";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function logToCsv(data) {
  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
  const prodTime = formatMinutesToTime(data.ProductionTime);
  const idleTime = formatMinutesToTime(data.IdleTime);
  const header = "Timestamp;Machine;Shift;ProductionTime;IdleTime;CottonTears;MissingSticks;FoultyPickups;OtherErrors;ProducedSwabs;PackagedSwabs;ProducedBoxes;ProducedBoxesLayerPlus;DiscardedSwabs;Efficiency;Reject";
  const row = `${timestamp};${data.Machine};${data.Shift};${prodTime};${idleTime};${data.CottonTears || 0};${data.MissingSticks || 0};${data.FoultyPickups || 0};${data.OtherErrors || 0};${data.ProducedSwabs || 0};${data.PackagedSwabs || 0};${data.ProducedBoxes || 0};${data.ProducedBoxesLayerPlus || 0};${data.DiscardedSwabs || 0};${(data.Efficiency || 0).toFixed(2)};${(data.Reject || 0).toFixed(2)}`;

  // Per-machine log
  const machineLogPath = path.join("csv_logs", "machines", `${data.Machine}.csv`);
  if (!fs.existsSync(machineLogPath)) {
    fs.writeFileSync(machineLogPath, header + "\n", "utf8");
  }
  fs.appendFileSync(machineLogPath, row + "\n", "utf8");

  // All-machines log
  const allLogPath = path.join("csv_logs", "AllMachines.csv");
  if (!fs.existsSync(allLogPath)) {
    fs.writeFileSync(allLogPath, header + "\n", "utf8");
  }
  fs.appendFileSync(allLogPath, row + "\n", "utf8");

  logger.info(`CSV logged: ${data.Machine} Shift ${data.Shift}`);
}

async function logToSavedShiftLogs(machineId, machineCode, data) {
  await supabase.from("saved_shift_logs").insert({
    machine_id: machineId,
    machine_code: machineCode,
    shift_number: data.Shift,
    production_time: data.ProductionTime || 0,
    idle_time: data.IdleTime || 0,
    cotton_tears: data.CottonTears || 0,
    missing_sticks: data.MissingSticks || 0,
    faulty_pickups: data.FoultyPickups || 0,
    other_errors: data.OtherErrors || 0,
    produced_swabs: data.ProducedSwabs || 0,
    packaged_swabs: data.PackagedSwabs || 0,
    produced_boxes: data.ProducedBoxes || 0,
    produced_boxes_layer_plus: data.ProducedBoxesLayerPlus || 0,
    discarded_swabs: data.DiscardedSwabs || 0,
    efficiency: data.Efficiency || 0,
    reject_rate: data.Reject || 0,
  });
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
      if (topic.includes("Status")) {
        await handleStatusMessage(payload);
      } else if (topic.includes("Shift") && !topic.includes("Request")) {
        await handleShiftMessage(payload);
      }
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

function publishRequestShift(machine, shift) {
  if (!mqttClient || !mqttConnected) {
    logger.warn("Cannot publish - MQTT not connected");
    return false;
  }

  const topic = `${getPublishTopicPrefix()}/RequestShift/${machine}`;
  const payload = JSON.stringify({ Machine: machine, Shift: shift });

  mqttClient.publish(topic, payload, { qos: 1 }, (err) => {
    if (err) {
      logger.error(`Publish error: ${err.message}`);
    } else {
      logger.info(`RequestShift published: ${machine} Shift ${shift} on ${topic}`);
      if (allMachines[machine]) {
        allMachines[machine].lastRequestShift = new Date();
      }
    }
  });
  return true;
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

// Root route (used by ngrok health checks)
app.get("/", (req, res) => {
  res.json({ service: "FALU PMS Bridge", status: "ok" });
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

// Request shift data from a machine
app.post("/api/machines/:code/request-shift", (req, res) => {
  const { shift } = req.body;
  const success = publishRequestShift(req.params.code, shift || 0);
  res.json({ success });
});

// Get broker settings
app.get("/api/settings/broker", (req, res) => {
  res.json({
    host: brokerSettings.host,
    port: brokerSettings.port,
    username: brokerSettings.username,
    isLocal: brokerSettings.isLocal,
    subscribeTopic: getSubscribeTopic(),
    publishTopicPrefix: getPublishTopicPrefix(),
  });
});

// CSV log files listing
app.get("/api/logs", (req, res) => {
  const logs = [];
  const allLogPath = path.join("csv_logs", "AllMachines.csv");

  if (fs.existsSync(allLogPath)) {
    const stat = fs.statSync(allLogPath);
    logs.push({
      name: "AllMachines.csv",
      path: "AllMachines.csv",
      size: stat.size,
      lastModified: stat.mtime,
    });
  }

  const machineLogsDir = path.join("csv_logs", "machines");
  if (fs.existsSync(machineLogsDir)) {
    const files = fs.readdirSync(machineLogsDir).filter(f => f.endsWith(".csv"));
    for (const file of files) {
      const stat = fs.statSync(path.join(machineLogsDir, file));
      logs.push({
        name: file,
        path: `machines/${file}`,
        size: stat.size,
        lastModified: stat.mtime,
      });
    }
  }

  res.json(logs);
});

// Download a CSV log
app.get("/api/logs/download/:filename", (req, res) => {
  const filePath = path.join("csv_logs", req.params.filename);
  if (fs.existsSync(filePath)) {
    return res.download(filePath);
  }
  res.status(404).json({ error: "File not found" });
});

app.get("/api/logs/download/machines/:filename", (req, res) => {
  const filePath = path.join("csv_logs", "machines", req.params.filename);
  if (fs.existsSync(filePath)) {
    return res.download(filePath);
  }
  res.status(404).json({ error: "File not found" });
});

// Get CSV content (for inline preview)
app.get("/api/logs/preview/:filename", (req, res) => {
  let filePath = path.join("csv_logs", req.params.filename);
  if (!fs.existsSync(filePath)) {
    filePath = path.join("csv_logs", "machines", req.params.filename);
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n");
  const headers = lines[0] ? lines[0].split(";") : [];
  const rows = lines.slice(1).map(line => line.split(";"));

  res.json({ headers, rows: rows.slice(-50) }); // Last 50 rows
});

// ============================================
// START
// ============================================
// Railway injects $PORT — always use it. API_PORT is a local-dev fallback only.
const PORT = process.env.PORT || process.env.API_PORT || 3001;

// Start the HTTP server immediately so Railway health checks pass right away,
// then load registered machines and connect to MQTT in the background.
// This prevents Railway from restarting the service while Supabase is warming up.
app.listen(PORT, () => {
  logger.info(`FALU PMS Bridge API running on port ${PORT} (process.env.PORT=${process.env.PORT ?? "unset"})`);
  logger.info(`MQTT Broker: ${brokerSettings.host}:${brokerSettings.port} (${brokerSettings.isLocal ? "local" : "cloud"})`);
  logger.info(`Topic: ${getSubscribeTopic()}`);

  loadRegisteredMachines()
    .then(() => connectMqtt())
    .catch((err) => logger.error(`Startup error: ${err.message}`));
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down...");
  if (mqttClient) mqttClient.end(true);
  process.exit(0);
});
