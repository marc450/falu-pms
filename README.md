# FALU PMS - Production Monitoring System

Real-time monitoring system for cotton swab production machinery.

## Architecture

```
Machines (PLC) ←→ MQTT Broker (HiveMQ) ←→ Bridge Service (Node.js + Express)
                                                ↓               ↓
                                           Supabase DB      CSV Logs
                                                ↓
                                        Frontend (Next.js + React)
```

## Project Structure

```
falu-pms/
├── database/migrations/     # SQL schema for Supabase
├── mqtt-bridge/             # Node.js MQTT bridge + REST API + Machine Simulator
│   └── src/
│       ├── index.js         # Main bridge service
│       └── simulator.js     # Machine simulator for testing
├── frontend/                # Next.js + React + Tailwind dashboard
│   └── src/
│       ├── app/             # Pages (Dashboard, Production, Settings, Downloads, Debug)
│       └── lib/             # Supabase client, API helpers, utilities
└── README.md
```

## MQTT Topics

The system uses the same MQTT protocol as the original Blazor implementation:

| Topic | Direction | Description |
|-------|-----------|-------------|
| `cloud/Status` | Machine → Bridge | Real-time machine status (speed, swaps, efficiency) |
| `cloud/Shift` | Machine → Bridge | Per-shift production data (with Save flag for persistence) |
| `cloud/RequestShift` | Bridge → Machine | Request shift data from a machine |

For local broker, replace `cloud/` with `local/`.

## Setup

### 1. Database (Supabase)

Run the SQL migration in your Supabase SQL Editor:
- `database/migrations/001_initial_schema.sql`

### 2. MQTT Bridge

```bash
cd mqtt-bridge
npm install
cp .env.example .env     # Configure Supabase and MQTT credentials
npm start                # Start the bridge
npm run simulator        # (Optional) Start the machine simulator
```

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env.local   # Configure Supabase and API URL
npm run dev
```

## Pages

- **Dashboard** (`/`) — Live machine park status table with sortable columns
- **Production** (`/production/:machine`) — Per-machine shift breakdown (Shift 1, 2, 3, Total)
- **Settings** (`/settings`) — MQTT broker info, machine configuration
- **Logfiles** (`/downloads`) — CSV log viewer and download
- **Debug** (`/debug`) — Raw shift data inspection, save flag monitoring
