# Tablet Kiosk Mode

## Context
The manufacturer wants to install tablets on their machines showing live performance data. When a machine is idle or in error, operators pick a stop reason from a predefined list. The system needs a secure but lightweight auth mechanism (URL token + PIN) since full Supabase auth is overkill for a dedicated kiosk device.

## Architecture Overview

```
/tablet/<UUID-token>  →  PIN entry (4 digits)  →  Kiosk view
                                                    ├── Running: Performance dashboard + cell comparison
                                                    └── Idle/Error: Stop reason picker overlay
                                                        → Auto-dismisses when status returns to "running"
```

No Supabase user login. Tablet uses the anon Supabase key + bridge REST API. Token + PIN stored on the `machines` table directly (one token per machine).

---

## Step 1: SQL Migration (`054_tablet_kiosk.sql`)

### 1a. `stop_reasons` table
```sql
CREATE TABLE stop_reasons (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('error', 'idle')),
  position   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- RLS: anon can read (tablets), authenticated can CRUD
```

### 1b. Add tablet columns to `machines`
```sql
ALTER TABLE machines
  ADD COLUMN tablet_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN tablet_pin   TEXT;  -- plain 4-digit string
CREATE UNIQUE INDEX idx_machines_tablet_token ON machines(tablet_token) WHERE tablet_token IS NOT NULL;
```

### 1c. `stop_reason_log` table
```sql
CREATE TABLE stop_reason_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id          UUID NOT NULL REFERENCES machines(id),
  stop_reason_id      UUID NOT NULL REFERENCES stop_reasons(id),
  status_at_selection TEXT NOT NULL CHECK (status_at_selection IN ('error', 'idle')),
  selected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ
);
CREATE INDEX idx_srl_machine ON stop_reason_log(machine_id, selected_at DESC);
-- RLS: anon can SELECT/INSERT/UPDATE (tablets), authenticated can SELECT (reporting)
```

### 1d. RLS policies for anon access
- `stop_reasons`: anon SELECT
- `stop_reason_log`: anon SELECT, INSERT, UPDATE (only resolved_at on unresolved rows)
- `machines`: anon SELECT (already public operational data, no secrets)

---

## Step 2: Supabase Functions (`frontend/src/lib/supabase.ts`)

### New types
- `StopReason { id, name, category: 'error'|'idle', position, created_at }`
- `StopReasonLog { id, machine_id, stop_reason_id, status_at_selection, selected_at, resolved_at }`
- `TabletSession { machine_id, machine_code, cell_id, name }`

### Tablet auth functions
- `validateTabletToken(token)` -> machine info or null (query machines where tablet_token = token)
- `validateTabletPin(token, pin)` -> boolean

### Stop reasons CRUD (admin)
- `fetchStopReasons()`, `createStopReason()`, `updateStopReason()`, `deleteStopReason()`

### Tablet token management (admin)
- `generateTabletToken(machineCode)` -> regenerate UUID
- `setTabletPin(machineCode, pin)` -> update PIN
- `revokeTabletToken(machineCode)` -> set both to NULL

### Tablet data functions (anon)
- `fetchTabletMachineData(machineId)` -> live columns from machines table
- `fetchTabletCellPeers(cellId)` -> all machines in the cell
- `fetchStopReasonsForCategory(category)` -> filtered stop reasons
- `submitStopReason(machineId, stopReasonId, status)` -> insert log
- `resolveStopReason(logId)` -> set resolved_at
- `fetchActiveStopReasonLog(machineId)` -> current unresolved log entry

---

## Step 3: AuthLayout Bypass (`frontend/src/components/AuthLayout.tsx`)

Add `const isTabletPage = pathname?.startsWith("/tablet");` and handle it like `/leaderboard`: skip auth redirect, render without sidebar.

---

## Step 4: Settings UI for Stop Reasons

### Placement: New section in Machines tab (Settings)
Below the cell/machine management, add a "Stop Reasons" card with two sections:

```
Stop Reasons
  Error Reasons                    Idle Reasons
  +--------------------+           +--------------------+
  | Motor failure     x|           | Cleaning          x|
  | Material jam      x|           | Break             x|
  | Sensor error      x|           | Material wait     x|
  | [+ Add reason]     |           | [+ Add reason]     |
  +--------------------+           +--------------------+
```

### Tablet Token management: Per-machine in MachinesTab
For each machine, add a "Tablet" expandable section showing:
- Generated URL (copyable): `https://<origin>/tablet/<token>`
- PIN input (4 digits)
- Regenerate / Revoke buttons

---

## Step 5: Tablet Kiosk Page (`frontend/src/app/tablet/[token]/page.tsx`)

### State machine
1. **Load**: validate token -> if invalid, show "Invalid link"
2. **PIN check**: check localStorage for `tablet_session_<token>` -> if missing, show PIN pad
3. **Live mode**: poll every 5s, switch between Running view and Stop Reason overlay

### PIN Entry component
- Large 4-digit number pad, touch optimized (min 60px button height)
- 4 dot indicators for entered digits
- Machine name displayed above

### Running View (TabletDashboard)
- Machine name prominently at top
- Large KPI tiles: Speed, Uptime, Scrap Rate, Swabs, Boxes
- Cell comparison: horizontal bar chart or ranked list of all machines in the same cell
- Current machine highlighted in the ranking
- Fullscreen, dark theme, no scrolling

### Stop Reason Overlay
- Shown when status = "idle" or "error"
- Header: "Machine is Idle" (yellow) or "Machine is in Error" (red)
- Grid of large touch buttons (one per reason for the matching category)
- On tap: submit reason, show confirmation, button stays highlighted
- If reason already submitted for this stop: show it as selected
- Auto-dismisses when status returns to "run" (resolves the log entry)

### Data flow (polling, same pattern as dashboard)
```typescript
// Every 5 seconds:
const machineData = await fetchTabletMachineData(machineId);
const cellPeers = cellId ? await fetchTabletCellPeers(cellId) : [];
// Status check -> switch view
```

---

## Step 6: Implementation Order

1. Migration `054_tablet_kiosk.sql` (provide to user to run)
2. Types + Supabase functions in `supabase.ts`
3. AuthLayout bypass for `/tablet` route
4. Stop Reasons management UI in Settings -> Machines tab
5. Tablet token management UI in Settings -> per machine
6. Tablet kiosk page: PIN entry -> Running view -> Stop Reason overlay
7. Test on tablet device

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `database/migrations/054_tablet_kiosk.sql` | Create |
| `frontend/src/lib/supabase.ts` | Add types + all tablet/stop reason functions |
| `frontend/src/components/AuthLayout.tsx` | Add tablet route bypass |
| `frontend/src/app/settings/page.tsx` | Add Stop Reasons section + tablet token mgmt |
| `frontend/src/app/tablet/[token]/page.tsx` | Create (full kiosk page) |

## Verification
1. Create stop reasons in Settings (both error and idle categories)
2. Generate a tablet token + set PIN for a machine
3. Open `/tablet/<token>` in a browser
4. Enter PIN -> see the running dashboard with cell comparison
5. Wait for machine to enter idle/error -> stop reason overlay appears
6. Select a reason -> confirmed
7. Machine returns to running -> overlay auto-dismisses, log entry resolved
