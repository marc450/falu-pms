# Production Page - Machine Selection & MQTT Request Implementation

## Changes Made

### 1. Production Page Updated
- Changed from showing all machines to showing **only one selected machine**
- Route changed from `/production` to `/production/{MachineName}`
- Added **Back** button to return to Home page
- Added display of **Last Request** timestamp

### 2. MQTT Request Functionality
When the Production page opens for a machine:
- **Initial Request:** Sends MQTT message with `Shift = 0`
- **Periodic Requests:** Every 10 seconds, sends MQTT message with `Shift = ActShift` (current shift number)

#### MQTT Message Format:
**Topic:** `local/RequestShift`

**Payload (JSON):**
```json
{
  "Machine": "MachineName",
  "Shift": 0  // or actual shift number
}
```

### 3. Files Modified

#### models.cs
- Added `MQTTShiftRequest` class for shift data requests

#### MqttService.cs
- Added `RequestShiftData(string machine, int shift)` method
- Publishes MQTT messages to `local/RequestShift` topic
- Updates `LastRequestShift` timestamp in MachineData

#### Production.razor
- Changed route to accept MachineName parameter: `@page "/production/{MachineName}"`
- Added route parameter: `[Parameter] public string MachineName { get; set; }`
- Added timer for periodic requests (10 second interval)
- Shows only the selected machine's data
- Sends initial request with Shift=0 on page load
- Sends periodic requests with current shift number
- Added "Back" button to return to Home
- Shows "Last Request" timestamp

#### Home.razor
- Updated navigation to pass machine name: `/production/{entry.Machine}`
- Clicking on a machine row opens Production page for that specific machine

#### NavMenu.razor
- Removed direct "Production" link from menu
- Users must select a machine from Home page to view production details

### 4. How It Works

1. **User clicks on a machine** in the Home page table
2. **Production page opens** for that specific machine (`/production/Machine1`)
3. **Initial MQTT request sent** immediately with Shift=0
4. **Timer starts** - sends new request every 10 seconds with current shift number
5. **Page displays** all shift data for the selected machine
6. **Timer stops** when user leaves the page (Dispose called)

### 5. MQTT Request Schedule

| Event | Timing | Shift Value |
|-------|--------|-------------|
| Page Load | Immediate | 0 |
| Timer Tick | Every 10s | ActShift (current shift number) |
| Page Close | N/A | (stops sending) |

### 6. Data Flow

```
User clicks Machine
    ↓
Production Page Opens
    ↓
MQTT Publish: local/RequestShift {"Machine": "X", "Shift": 0}
    ↓
Timer starts (10s interval)
    ↓
MQTT Publish: local/RequestShift {"Machine": "X", "Shift": ActShift}
    ↓
(repeats every 10 seconds)
    ↓
User navigates away
    ↓
Timer stops, page disposed
```

### 7. UI Changes

- Production page now shows single machine view
- Back button added to top of page
- Last request timestamp shown in card header
- Machine status badge displayed
- All shift data (Shift 1, 2, 3, Total) displayed in table

### 8. Testing

To test the implementation:

1. **Start the application**
2. **Login** and go to Home page
3. **Click on any machine** in the table
4. **Verify:**
   - Production page opens for that machine
   - Check console for: "Shift data requested for {Machine}, Shift 0"
   - After 10 seconds: "Shift data requested for {Machine}, Shift {ActShift}"
   - Check MQTT broker for messages on `local/RequestShift` topic
5. **Navigate back** using Back button
6. **Select different machine** to test with another machine

### 9. Console Messages

You will see:
```
Shift data requested for Machine1, Shift 0
Shift data requested for Machine1, Shift 1
Shift data requested for Machine1, Shift 1
... (every 10 seconds)
```

## Important Notes

- The timer automatically stops when leaving the page (proper cleanup)
- Requests use QoS 1 (AtLeastOnce) for reliability
- The MachineName must match exactly with MQTT machine names
- Initial request uses Shift=0 as requested
- Subsequent requests use the current/active shift number from MachineStatus
