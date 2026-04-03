# Settings and Home Page Improvements

## Changes Made

### 1. ✅ Topic Configuration Simplified
**Before:** Manual topic entry (e.g., "local/#" or "cloud/#")
**After:** Simple Local/Cloud selector

- **Settings Model Updated**: `BrokerSettings` now has `IsLocal` boolean property
- **Topic Auto-Generated**: 
  - `IsLocal = true` → Topic: `local/#`
  - `IsLocal = false` → Topic: `cloud/#`
- **Settings Page**: Dropdown selector instead of text input
- **Display**: Shows current topic next to selector

### 2. ✅ Machine Configuration Card Resized
- Machine Configuration card now matches MQTT Broker Settings card height
- Fixed height: 510px when admin view (both cards same size)
- Full width when supervisor-only view

### 3. ✅ Scrollable Machine List
- Added scrollbar to machine list container
- **Max height**: 300px
- **Auto-scroll**: When more machines than fit
- **Styled scrollbar**: Custom dark theme scrollbar
- **Handles**: 50-60+ machines easily

### 4. ✅ All Configured Machines Always Visible
**Before:** Only machines with MQTT data appeared
**After:** All configured machines shown in table

- Configured machines without data show as "offline" with `---` for values
- Creates placeholder `MachineData` objects for configured machines
- Users see complete machine inventory at all times

### 5. ✅ Improved Status Messages
**Before:** "Waiting for data" message inside empty table
**After:** Status message at top where machine counter is

**Two States:**
1. **No Data Received Yet**:
   ```
   ⟳ Waiting for MQTT data...
   ```
   (Yellow badge with spinner)

2. **Data Received**:
   ```
   ⚡ X Machines online
   ```
   (Blue badge with count)

### 6. ✅ Machine Counter Logic
- **No machines configured**: Shows count of all discovered machines
- **Machines configured**: Shows count of configured machines that are online
- Online = machine exists in `Mqtt.AllMachines` dictionary

## Files Modified

### SettingsModels.cs
- Removed `Topic` property from `BrokerSettings`
- Added `IsLocal` boolean property
- Added `GetTopic()` method to generate topic based on `IsLocal`

### MqttService.cs
- Uses `brokerSettings.GetTopic()` instead of `brokerSettings.Topic`
- Logs full topic when connecting

### Settings.razor
- Replaced topic text input with dropdown selector
- Added fixed height to machine configuration card body
- Added scrollable container for machine list
- Added custom scrollbar CSS
- Shows current topic dynamically

### Home.razor
- Status message moved to header area (where machine counter was)
- Shows spinner when no data received
- Shows online count when data available
- Table always shows all configured machines
- Placeholder machines show `---` for missing data
- Online counter counts only machines with data

## Visual Changes

### Settings Page - Local/Cloud Selector
```
Instance Type
┌──────────────────────────────────┐
│ Local (Topic: local/#)     ▼    │
└──────────────────────────────────┘
Current topic: local/#
```

### Settings Page - Machine List (Scrollable)
```
Enabled Machines (50)
┌──────────────────────────────────┐
│ 🖥️ Machine1        [Remove]     │
│ 🖥️ Machine2        [Remove]     │
│ 🖥️ Machine3        [Remove]     │
│ ...                              │ ← Scrollbar
│ 🖥️ Machine50       [Remove]     │
└──────────────────────────────────┘
```

### Home Page - Status Message
**Waiting for data:**
```
Machine Park Live Status     [⟳ Waiting for MQTT data...]
```

**Data received:**
```
Machine Park Live Status     [⚡ 15 Machines online]
```

### Home Page - Table with Configured Machines
```
Machine    Status     Speed    Swaps    Boxes    Efficiency    Reject    Last Sync
────────────────────────────────────────────────────────────────────────────────────
Machine1   Run        1500     1250     150      95.5%        2.3%      14:35:22
Machine2   Offline    ---      ---      ---      ---          ---       ---
Machine3   Run        1450     1200     145      94.2%        3.1%      14:35:20
...
```

## Behavior

### Machine Visibility
1. **No Machines Configured** (empty list):
   - Shows all machines discovered via MQTT
   - "Waiting for MQTT data..." until first machine appears

2. **Machines Configured**:
   - Shows ONLY configured machines
   - Machines without data show as "offline" with `---`
   - Online counter shows X of Y machines online

### Topic Handling
- **Local Mode**: Subscribes to `local/#` (local dashboard)
- **Cloud Mode**: Subscribes to `cloud/#` (cloud dashboard)
- Mode stored in settings, persists across restarts
- Changing mode reconnects MQTT client automatically

### Data Display
- **Has Data**: Shows actual values from MQTT
- **No Data**: Shows `---` placeholders
- Status badge shows "offline" when no data
- Last Sync shows `---` when no data

## Benefits

### For Large Installations
- ✅ Handles 50-60 machines easily
- ✅ Scrollbar prevents UI overflow
- ✅ Consistent card sizing
- ✅ All machines always visible

### For Users
- ✅ Clear status: waiting vs. online
- ✅ See all configured machines immediately
- ✅ Easy to identify machines without connection
- ✅ Professional, clean UI

### For Administrators
- ✅ Simple Local/Cloud toggle
- ✅ No manual topic configuration
- ✅ Less configuration errors
- ✅ Easier to manage many machines

## Testing

1. **Test with no machines configured**:
   - Should show "Waiting for MQTT data..." initially
   - Should show all discovered machines when data arrives
   - Counter should show total discovered machines

2. **Test with configured machines**:
   - Should show all configured machines immediately
   - Machines without data show "offline" and `---`
   - Counter shows "X Machines online" (only online count)

3. **Test Local/Cloud toggle**:
   - Change from Local to Cloud
   - Verify reconnection
   - Check console for topic change
   - Verify data still flows

4. **Test 50+ machines**:
   - Add 50+ machines to settings
   - Verify scrollbar appears
   - Verify all machines listed
   - Verify performance is good

## Migration Notes

Existing `appsettings.json` files will need update:

**Old Format:**
```json
{
  "Broker": {
    "Topic": "local/#"
  }
}
```

**New Format:**
```json
{
  "Broker": {
    "IsLocal": true
  }
}
```

The `Topic` property is ignored if present. The system will default to `IsLocal = true` (local mode).
