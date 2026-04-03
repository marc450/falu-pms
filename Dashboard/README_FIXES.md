# Settings and Home Page Fixes

## Changes Made

### 1. ✅ Fixed Local/Cloud Selection
**Problem:** Dropdown was unclear about which option was selected
**Solution:** Changed to radio buttons with clear labels

**Before:**
```
Instance Type
┌──────────────────────────────────┐
│ Local (Topic: local/#)     ▼    │
└──────────────────────────────────┘
```

**After:**
```
Instance Type
○ Local - Subscribe: local/#, Publish: local/RequestShift
● Cloud - Subscribe: cloud/*, Publish: cloud/RequestShift
```

- Clear visual indication of selection
- Shows both subscribe and publish topics
- Radio buttons are more intuitive than dropdown

### 2. ✅ Fixed Cloud Topic Pattern
**Problem:** Cloud mode used `cloud/#` (same pattern as local)
**Solution:** Cloud mode now uses proper patterns:
- **Subscribe**: `cloud/*` (not `cloud/#`)
- **Publish**: `cloud/RequestShift` (not `local/RequestShift`)

**Implementation:**
- `GetSubscribeTopic()`: Returns `cloud/*` for cloud mode
- `GetPublishTopicPrefix()`: Returns `cloud` for cloud mode
- Publish topics dynamically built: `{prefix}/RequestShift`

### 3. ✅ Button Labels Added

**Enabled Machines - Delete Button:**
**Before:** 🗑️ (icon only)
**After:** 🗑️ Delete

**Discovered Machines - Add Button:**
**Before:** ➕ (icon only)
**After:** ➕ Add

**Already Added Badge:**
**Before:** ✓
**After:** ✓ Added

### 4. ✅ Discovered Machines Scrollbar
- Added `max-height: 400px` to discovered machines card body
- Added `overflow-y: auto` for scrolling
- Handles many discovered machines gracefully

### 5. ✅ Empty Cells on Home Page
**Problem:** Showed "---" for missing data
**Solution:** Show empty cells (no text)

**Before:**
```
Swaps    Boxes    Efficiency    Reject
─────────────────────────────────────
---      ---      ---          ---
```

**After:**
```
Swaps    Boxes    Efficiency    Reject
─────────────────────────────────────
                                      (empty cells)
```

**Logic:**
- Only show value if > 0
- Speed: Only show if exists and > 0
- Swaps/Boxes: Only show if > 0 (empty cell otherwise)
- Efficiency/Reject: Only show if exists and > 0

## Technical Details

### SettingsModels.cs
```csharp
public string GetSubscribeTopic()
{
    return IsLocal ? "local/#" : "cloud/*";
}

public string GetPublishTopicPrefix()
{
    return IsLocal ? "local" : "cloud";
}
```

### MqttService.cs
```csharp
// Subscribe topic
var topic = brokerSettings.GetSubscribeTopic();
await _mqttClient.SubscribeAsync(topic);

// Publish topic
var topicPrefix = brokerSettings.GetPublishTopicPrefix();
var topic = $"{topicPrefix}/RequestShift";
```

### Settings.razor Radio Buttons
```razor
<div class="form-check">
    <input class="form-check-input" type="radio" name="instanceType" id="radioLocal" 
           checked="@brokerSettings.IsLocal" @onchange="() => brokerSettings.IsLocal = true">
    <label class="form-check-label" for="radioLocal">
        <strong>Local</strong> - Subscribe: <code>local/#</code>, Publish: <code>local/RequestShift</code>
    </label>
</div>
```

### Home.razor Empty Cells
```razor
<td>@(entry.MachineStatus?.Swaps > 0 ? entry.MachineStatus.Swaps.ToString() : "")</td>
<td>@(entry.MachineStatus?.Boxes > 0 ? entry.MachineStatus.Boxes.ToString() : "")</td>
```

## Testing Checklist

### Settings Page
- [ ] Radio buttons clearly show Local vs Cloud
- [ ] Current selection is visually obvious
- [ ] Topics are displayed for both options
- [ ] Delete button shows "Delete" label
- [ ] Add button shows "Add" label
- [ ] Added badge shows "Added" text
- [ ] Discovered machines scrolls when many machines

### MQTT Topics
- [ ] Local mode subscribes to `local/#`
- [ ] Cloud mode subscribes to `cloud/*`
- [ ] Local mode publishes to `local/RequestShift`
- [ ] Cloud mode publishes to `cloud/RequestShift`
- [ ] Console shows correct topic in logs

### Home Page
- [ ] Empty cells for machines without data
- [ ] No "---" text anywhere
- [ ] Speed only shows when > 0
- [ ] Swaps/Boxes empty when 0 or null
- [ ] Efficiency/Reject empty when 0 or null

## Console Output Examples

### Local Mode
```
Connected to broker at localhost:1883, subscribed to local/#
Shift data requested for Machine1, Shift 0 on topic local/RequestShift
```

### Cloud Mode
```
Connected to broker at broker.hivemq.com:1883, subscribed to cloud/*
Shift data requested for Machine1, Shift 0 on topic cloud/RequestShift
```

## Visual Improvements Summary

1. **Settings Page**:
   - ✅ Radio buttons for instance type (clearer than dropdown)
   - ✅ Button labels ("Delete", "Add", "Added")
   - ✅ Scrollable discovered machines list
   - ✅ Topics clearly displayed for each mode

2. **Home Page**:
   - ✅ Clean empty cells (no "---")
   - ✅ Professional appearance
   - ✅ Only show data when exists and > 0

3. **MQTT Communication**:
   - ✅ Correct cloud topics (`cloud/*` not `cloud/#`)
   - ✅ Dynamic publish topics based on mode
   - ✅ Clear logging of topics used
