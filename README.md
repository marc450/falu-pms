# FALU PMS - Production Monitoring System

Real-time monitoring system for cotton swab production machinery.

## Architecture

```
Machines → MQTT Broker → Bridge Service → Supabase (PostgreSQL) → Next.js Dashboard
```

## Project Structure

```
falu-pms/
├── database/migrations/   # SQL schema for Supabase
├── mqtt-bridge/           # Node.js MQTT-to-Supabase bridge
├── frontend/              # Next.js dashboard application
└── README.md
```

## Setup

### 1. Database

Run the SQL migration in your Supabase SQL Editor:
- `database/migrations/001_initial_schema.sql`

### 2. MQTT Bridge

```bash
cd mqtt-bridge
npm install
cp .env.example .env    # Fill in your Supabase and MQTT credentials
npm start
```

### 3. Frontend

```bash
cd frontend
npm install
cp .env.example .env.local    # Fill in your Supabase public credentials
npm run dev
```

## Environment Variables

### MQTT Bridge (`mqtt-bridge/.env`)
- `MQTT_BROKER_URL` - MQTT broker connection string
- `MQTT_TOPIC` - Topic pattern to subscribe to
- `SUPABASE_URL` - Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (server-side only)

### Frontend (`frontend/.env.local`)
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase anon/public key
