/**
 * FALU PMS - Machine Simulator
 * Node.js port of the developer's Blazor MachineSimulator
 *
 * Simulates cotton swab production machines publishing MQTT messages.
 * Usage: npm run simulator
 */

require("dotenv").config();
const mqtt = require("mqtt");

const BROKER_HOST = process.env.MQTT_HOST || "e21df7393cc24e69b198158d3af2b3d6.s1.eu.hivemq.cloud";
const BROKER_PORT = parseInt(process.env.MQTT_PORT || "8883");
const BROKER_USER = process.env.MQTT_USERNAME || "USCotton";
const BROKER_PASS = process.env.MQTT_PASSWORD || "Admin123";
const IS_LOCAL = process.env.MQTT_IS_LOCAL === "true";
const SEND_FREQUENCY = parseInt(process.env.SIM_FREQUENCY_MS || "2000");
const MACHINE_NAMES = (process.env.SIM_MACHINES || "CB-30,CB-31,CB-32,CB-33,CB-34,CB-35,CB-36,CB-37").split(",");

// Per-machine speed ranges (min/max pcs/m)
const MACHINE_SPEED_RANGES = {
  "CB-30": [2821, 2943],
  "CB-31": [1589, 1802],
  "CB-32": [2785, 2897],
  "CB-33": [2821, 2943],
  "CB-34": [2785, 2897],
  "CB-35": [2821, 2943],
  "CB-36": [2785, 2897],
  "CB-37": [2844, 2937],
};

const topicPrefix = IS_LOCAL ? "local" : "cloud";

// ============================================
// SIMULATED MACHINE STATE
// ============================================
const machines = {};

function initMachine(name) {
  const [minSpeed, maxSpeed] = MACHINE_SPEED_RANGES[name] || [400, 500];
  machines[name] = {
    name,
    status: "run",       // run, idle, error
    activeShift: 1,
    speed: minSpeed + Math.floor(Math.random() * (maxSpeed - minSpeed)),
    minSpeed,
    maxSpeed,
    efficiency: 90 + Math.random() * 8,
    reject: 1 + Math.random() * 4,
    shifts: {
      1: createShiftData(),
      2: createShiftData(),
      3: createShiftData(),
    },
  };
}

function createShiftData() {
  return {
    productionTime: 0,
    idleTime: 0,
    cottonTears: 0,
    missingSticks: 0,
    faultyPickups: 0,
    otherErrors: 0,
    producedSwabs: 0,
    packagedSwabs: 0,
    producedBoxes: 0,
    producedBoxesLayerPlus: 0,
    discardedSwabs: 0,
    efficiency: 0,
    reject: 0,
  };
}

// ============================================
// SIMULATION TICK
// ============================================
function simulateTick(machine) {
  if (machine.status !== "run") return;

  const shift = machine.shifts[machine.activeShift];
  if (!shift) return;

  // Increment time (in minutes, ticking proportionally)
  shift.productionTime += 1;

  // Random idle moments
  if (Math.random() < 0.05) {
    shift.idleTime += 1;
  }

  // Production
  const swabsThisTick = Math.floor(machine.speed / 60 * (SEND_FREQUENCY / 1000)) + Math.floor(Math.random() * 5);
  shift.producedSwabs += swabsThisTick;

  const discarded = Math.random() < 0.1 ? Math.floor(Math.random() * 3) : 0;
  shift.discardedSwabs += discarded;
  shift.packagedSwabs += (swabsThisTick - discarded);

  // Blisters (500 swabs per blister)
  const newBoxes = Math.floor(shift.packagedSwabs / 500) - shift.producedBoxes;
  if (newBoxes > 0) {
    shift.producedBoxes += newBoxes;
    if (Math.random() < 0.25) {
      shift.producedBoxesLayerPlus += Math.ceil(newBoxes * 0.3);
    }
  }

  // Random errors
  if (Math.random() < 0.03) shift.cottonTears += 1;
  if (Math.random() < 0.02) shift.missingSticks += 1;
  if (Math.random() < 0.01) shift.faultyPickups += 1;
  if (Math.random() < 0.01) shift.otherErrors += 1;

  // Update efficiency and reject
  machine.efficiency = 85 + Math.random() * 13;
  machine.reject = shift.producedSwabs > 0
    ? (shift.discardedSwabs / shift.producedSwabs) * 100
    : 0;
  shift.efficiency = machine.efficiency;
  shift.reject = machine.reject;

  // Update speed with small variance, clamped to machine's range
  machine.speed = Math.max(machine.minSpeed, Math.min(machine.maxSpeed, machine.speed + Math.floor(Math.random() * 11) - 5));
}

// ============================================
// PUBLISH MESSAGES
// ============================================
function publishStatus(client, machine) {
  const msg = {
    Machine: machine.name,
    Status: machine.status,
    Error: machine.status === "error" ? "Simulated error" : "",
    ActShift: machine.activeShift,
    Speed: machine.speed,
    Swaps: machine.shifts[machine.activeShift]?.producedSwabs || 0,
    Boxes: machine.shifts[machine.activeShift]?.producedBoxes || 0,
    Efficiency: parseFloat(machine.efficiency.toFixed(1)),
    Reject: parseFloat(machine.reject.toFixed(1)),
  };

  client.publish(`${topicPrefix}/Status`, JSON.stringify(msg), { qos: 1 });
}

function publishShiftData(client, machine, shiftNum, save = false) {
  const shift = machine.shifts[shiftNum];
  if (!shift) return;

  const msg = {
    Machine: machine.name,
    Shift: shiftNum,
    ProductionTime: shift.productionTime,
    IdleTime: shift.idleTime,
    CottonTears: shift.cottonTears,
    MissingSticks: shift.missingSticks,
    FoultyPickups: shift.faultyPickups,
    OtherErrors: shift.otherErrors,
    ProducedSwaps: shift.producedSwabs,
    PackagedSwaps: shift.packagedSwabs,
    ProducedBoxes: shift.producedBoxes,
    ProducedBoxesLayerPlus: shift.producedBoxesLayerPlus,
    DisgardedSwaps: shift.discardedSwabs,
    Efficiency: parseFloat(shift.efficiency.toFixed(2)),
    Reject: parseFloat(shift.reject.toFixed(2)),
    Save: save,
  };

  client.publish(`${topicPrefix}/Shift`, JSON.stringify(msg), { qos: 1 });
}

// ============================================
// MAIN
// ============================================
const url = IS_LOCAL ? `mqtt://${BROKER_HOST}:${BROKER_PORT}` : `mqtts://${BROKER_HOST}:${BROKER_PORT}`;

console.log(`\n=== FALU PMS Machine Simulator ===`);
console.log(`Broker: ${url}`);
console.log(`Machines: ${MACHINE_NAMES.join(", ")}`);
console.log(`Send frequency: ${SEND_FREQUENCY}ms`);
console.log(`Topic prefix: ${topicPrefix}`);
console.log(`=================================\n`);

const client = mqtt.connect(url, {
  username: BROKER_USER,
  password: BROKER_PASS,
  clientId: `falu-simulator-${Date.now()}`,
  clean: true,
  reconnectPeriod: 5000,
  rejectUnauthorized: !IS_LOCAL,
});

client.on("connect", () => {
  console.log("Connected to MQTT broker");

  // Init machines
  MACHINE_NAMES.forEach(name => initMachine(name.trim()));

  // Subscribe to RequestShift
  client.subscribe(`${topicPrefix}/RequestShift`, { qos: 1 });

  // Start simulation loop
  setInterval(() => {
    for (const name of Object.keys(machines)) {
      const m = machines[name];
      simulateTick(m);
      publishStatus(client, m);
    }
  }, SEND_FREQUENCY);

  // Publish shift data every 10 seconds
  setInterval(() => {
    for (const name of Object.keys(machines)) {
      const m = machines[name];
      publishShiftData(client, m, m.activeShift);
    }
  }, 10000);

  // Simulate a Save event every 60 seconds
  setInterval(() => {
    for (const name of Object.keys(machines)) {
      const m = machines[name];
      publishShiftData(client, m, m.activeShift, true);
      console.log(`[SAVE] ${m.name} Shift ${m.activeShift}`);
    }
  }, 60000);

  console.log("Simulation started. Press Ctrl+C to stop.\n");
});

// Handle RequestShift messages
client.on("message", (topic, message) => {
  if (topic.includes("RequestShift")) {
    try {
      const req = JSON.parse(message.toString());
      const m = machines[req.Machine];
      if (m) {
        if (req.Shift === 0) {
          // Send all shifts
          [1, 2, 3].forEach(s => publishShiftData(client, m, s));
          // Send total
          const totalShift = { ...createShiftData() };
          [1, 2, 3].forEach(s => {
            const sd = m.shifts[s];
            if (sd) {
              totalShift.productionTime += sd.productionTime;
              totalShift.idleTime += sd.idleTime;
              totalShift.cottonTears += sd.cottonTears;
              totalShift.missingSticks += sd.missingSticks;
              totalShift.faultyPickups += sd.faultyPickups;
              totalShift.otherErrors += sd.otherErrors;
              totalShift.producedSwabs += sd.producedSwabs;
              totalShift.packagedSwabs += sd.packagedSwabs;
              totalShift.producedBoxes += sd.producedBoxes;
              totalShift.producedBoxesLayerPlus += sd.producedBoxesLayerPlus;
              totalShift.discardedSwabs += sd.discardedSwabs;
            }
          });
          totalShift.efficiency = totalShift.producedSwabs > 0 ? m.efficiency : 0;
          totalShift.reject = totalShift.producedSwabs > 0
            ? (totalShift.discardedSwabs / totalShift.producedSwabs) * 100 : 0;

          // Publish total as Shift 4
          const msg = {
            Machine: req.Machine,
            Shift: 4,
            ProductionTime: totalShift.productionTime,
            IdleTime: totalShift.idleTime,
            CottonTears: totalShift.cottonTears,
            MissingSticks: totalShift.missingSticks,
            FoultyPickups: totalShift.faultyPickups,
            OtherErrors: totalShift.otherErrors,
            ProducedSwaps: totalShift.producedSwabs,
            PackagedSwaps: totalShift.packagedSwabs,
            ProducedBoxes: totalShift.producedBoxes,
            ProducedBoxesLayerPlus: totalShift.producedBoxesLayerPlus,
            DisgardedSwaps: totalShift.discardedSwabs,
            Efficiency: parseFloat(totalShift.efficiency.toFixed(2)),
            Reject: parseFloat(totalShift.reject.toFixed(2)),
            Save: false,
          };
          client.publish(`${topicPrefix}/Shift`, JSON.stringify(msg), { qos: 1 });
        } else {
          publishShiftData(client, m, req.Shift);
        }
        console.log(`[REQ] Shift data sent for ${req.Machine} Shift ${req.Shift}`);
      }
    } catch (err) {
      console.error(`RequestShift error: ${err.message}`);
    }
  }
});

client.on("error", (err) => {
  console.error(`MQTT Error: ${err.message}`);
});

process.on("SIGINT", () => {
  console.log("\nShutting down simulator...");
  client.end(true);
  process.exit(0);
});
