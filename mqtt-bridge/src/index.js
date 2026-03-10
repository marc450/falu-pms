/**
 * FALU PMS - MQTT to Supabase Bridge
 *
 * Subscribes to MQTT topics from cotton swab production machines
 * and writes the data to Supabase PostgreSQL.
 *
 * Expected MQTT JSON payload format:
 * {
 *   "machine_code": "MACHINE-01",
 *   "timestamp": "2026-03-10T14:30:00Z",  // optional, defaults to NOW
 *   "production_time": 3600,
 *   "downtime": 120,
 *   "machine_speed": 450,
 *   "cotton_tears": 3,
 *   "produced_swabs": 15000,
 *   "packed_swabs": 14850,
 *   "produced_boxes": 120,
 *   "produced_boxes_extra_layer": 30,
 *   "rejected_swabs": 150,
 *   "faulty_pickups": 5,
 *   "error_stops": 2,
 *   "efficiency": 0.95,
 *   "scrap_rate": 0.01
 * }
 */

require("dotenv").config();
const mqtt = require("mqtt");
const { createClient } = require("@supabase/supabase-js");
const winston = require("winston");

// ============================================
// LOGGER
// ============================================
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/error.log", level: "error" }),
    new winston.transports.File({ filename: "logs/combined.log" }),
  ],
});

// ============================================
// SUPABASE CLIENT (using service_role key for writes)
// ============================================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================
// MACHINE CACHE
// Maps machine_code -> machine UUID to avoid repeated lookups
// ============================================
const machineCache = new Map();

async function getMachineId(machineCode) {
  if (machineCache.has(machineCode)) {
    return machineCache.get(machineCode);
  }

  const { data, error } = await supabase
    .from("machines")
    .select("id")
    .eq("machine_code", machineCode)
    .single();

  if (error || !data) {
    logger.warn(`Unknown machine code: ${machineCode}. Auto-registering...`);
    // Auto-register unknown machines
    const { data: newMachine, error: insertError } = await supabase
      .from("machines")
      .insert({ machine_code: machineCode, name: machineCode, status: "online" })
      .select("id")
      .single();

    if (insertError) {
      logger.error(`Failed to register machine ${machineCode}:`, insertError);
      return null;
    }
    machineCache.set(machineCode, newMachine.id);
    return newMachine.id;
  }

  machineCache.set(machineCode, data.id);
  return data.id;
}

// ============================================
// MESSAGE HANDLER
// ============================================
async function handleMessage(topic, message) {
  let payload;

  try {
    payload = JSON.parse(message.toString());
  } catch (err) {
    logger.error(`Invalid JSON on topic ${topic}:`, err.message);
    return;
  }

  logger.debug(`Received message on ${topic}:`, payload);

  const machineCode = payload.machine_code || topic.split("/").pop();
  const machineId = await getMachineId(machineCode);

  if (!machineId) {
    logger.error(`Could not resolve machine ID for: ${machineCode}`);
    return;
  }

  // Update machine status to online
  await supabase
    .from("machines")
    .update({ status: "online" })
    .eq("id", machineId);

  // Insert reading
  const reading = {
    machine_id: machineId,
    recorded_at: payload.timestamp || new Date().toISOString(),
    production_time: payload.production_time,
    downtime: payload.downtime,
    machine_speed: payload.machine_speed,
    cotton_tears: payload.cotton_tears,
    produced_swabs: payload.produced_swabs,
    packed_swabs: payload.packed_swabs,
    produced_boxes: payload.produced_boxes,
    produced_boxes_extra_layer: payload.produced_boxes_extra_layer,
    rejected_swabs: payload.rejected_swabs,
    faulty_pickups: payload.faulty_pickups,
    error_stops: payload.error_stops,
    efficiency: payload.efficiency,
    scrap_rate: payload.scrap_rate,
    raw_payload: payload,
  };

  const { error } = await supabase.from("production_readings").insert(reading);

  if (error) {
    logger.error(`Failed to insert reading for ${machineCode}:`, error);
  } else {
    logger.info(
      `Saved reading for ${machineCode}: ${payload.produced_swabs || 0} swabs, efficiency: ${payload.efficiency || "N/A"}`
    );
  }

  // Check for alert conditions
  await checkAlerts(machineId, payload, reading);
}

// ============================================
// ALERT CHECKING
// ============================================
async function checkAlerts(machineId, payload) {
  const alerts = [];

  // High scrap rate alert (> 5%)
  if (payload.scrap_rate && payload.scrap_rate > 0.05) {
    alerts.push({
      machine_id: machineId,
      alert_type: "high_scrap_rate",
      severity: payload.scrap_rate > 0.1 ? "critical" : "warning",
      message: `Scrap rate at ${(payload.scrap_rate * 100).toFixed(1)}% (threshold: 5%)`,
    });
  }

  // Low efficiency alert (< 80%)
  if (payload.efficiency && payload.efficiency < 0.8) {
    alerts.push({
      machine_id: machineId,
      alert_type: "low_efficiency",
      severity: payload.efficiency < 0.6 ? "critical" : "warning",
      message: `Efficiency at ${(payload.efficiency * 100).toFixed(1)}% (threshold: 80%)`,
    });
  }

  // High error stops
  if (payload.error_stops && payload.error_stops > 5) {
    alerts.push({
      machine_id: machineId,
      alert_type: "excessive_error_stops",
      severity: "warning",
      message: `${payload.error_stops} error stops recorded`,
    });
  }

  if (alerts.length > 0) {
    const { error } = await supabase.from("alerts").insert(alerts);
    if (error) {
      logger.error("Failed to insert alerts:", error);
    } else {
      logger.warn(`Created ${alerts.length} alert(s) for machine ${machineId}`);
    }
  }
}

// ============================================
// MQTT CONNECTION
// ============================================
const MQTT_TOPIC = process.env.MQTT_TOPIC || "falu/production/#";

const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL, {
  username: process.env.MQTT_USERNAME || undefined,
  password: process.env.MQTT_PASSWORD || undefined,
  clientId: `falu-pms-bridge-${Date.now()}`,
  clean: true,
  reconnectPeriod: 5000,
});

mqttClient.on("connect", () => {
  logger.info(`Connected to MQTT broker: ${process.env.MQTT_BROKER_URL}`);
  mqttClient.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
    if (err) {
      logger.error(`Failed to subscribe to ${MQTT_TOPIC}:`, err);
    } else {
      logger.info(`Subscribed to topic: ${MQTT_TOPIC}`);
    }
  });
});

mqttClient.on("message", (topic, message) => {
  handleMessage(topic, message).catch((err) => {
    logger.error("Unhandled error in message handler:", err);
  });
});

mqttClient.on("error", (err) => {
  logger.error("MQTT connection error:", err);
});

mqttClient.on("reconnect", () => {
  logger.info("Reconnecting to MQTT broker...");
});

mqttClient.on("offline", () => {
  logger.warn("MQTT client went offline");
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on("SIGINT", () => {
  logger.info("Shutting down MQTT bridge...");
  mqttClient.end(true, () => {
    logger.info("MQTT connection closed.");
    process.exit(0);
  });
});

logger.info("FALU PMS MQTT Bridge starting...");
logger.info(`Broker: ${process.env.MQTT_BROKER_URL}`);
logger.info(`Topic: ${MQTT_TOPIC}`);
