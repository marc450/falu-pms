# Settings System Documentation

## Overview
The Dashboard now includes a comprehensive settings system that allows administrators and supervisors to configure broker parameters and manage which machines are displayed.

## Features

### 1. MQTT Broker Configuration (Administrator Only)
- **Host/IP Address**: MQTT broker server address
- **Port**: MQTT broker port (default: 1883)
- **Username**: MQTT authentication username
- **Password**: MQTT authentication password
- **Topic**: MQTT topic to subscribe to (supports wildcards like `local/#`)

### 2. Machine Configuration (Supervisor and Administrator)
- Add machines manually by name
- Add discovered machines with one click
- Remove machines from the enabled list
- View all currently discovered machines via MQTT

### 3. Settings Persistence
- Settings are saved to `appsettings.json` in the application root
- Settings are loaded automatically on application startup
- Changes take effect immediately (broker reconnects automatically)

## Access Levels

### User
- Cannot access Settings page
- Sees only machines configured in settings

### Supervisor
- Can configure which machines are shown
- Cannot change broker settings
- Can add/remove machines from the enabled list

### Administrator
- Full access to all settings
- Can configure MQTT broker parameters
- Can configure machine list
- Changes to broker settings trigger automatic reconnection

## How It Works

### Startup Sequence
1. **SettingsService** loads settings from `appsettings.json`
2. **MqttService** uses broker settings to connect to MQTT broker
3. **Home page** filters machines based on enabled list

### Machine Filtering
- If **no machines are configured**: All discovered machines are shown
- If **machines are configured**: Only enabled machines are shown
- Machines are filtered in real-time as MQTT data arrives

### Settings Updates
- **Broker settings change**: MQTT client disconnects and reconnects with new settings
- **Machine settings change**: UI updates immediately to show/hide machines

## Files Created

### New Files
- **SettingsModels.cs**: Data models for settings
  - `BrokerSettings`: MQTT broker configuration
  - `MachineSettings`: Machine filter configuration
  - `ApplicationSettings`: Combined settings container

- **SettingsService.cs**: Settings management service
  - Load/save settings to JSON file
  - Notify system when settings change
  - Check if machine is enabled
  - Singleton service

- **Settings.razor**: Settings configuration page
  - Broker settings form (admin only)
  - Machine configuration (supervisor+)
  - Discovered machines list
  - Add/remove machine functionality

### Modified Files
- **MqttService.cs**:
  - Accepts `SettingsService` via dependency injection
  - Uses broker settings from `SettingsService`
  - Reconnects when settings change
  
- **Program.cs**:
  - Registers `SettingsService` as singleton
  
- **Home.razor**:
  - Injects `SettingsService`
  - Filters machines using `SettingsService.IsMachineEnabled()`
  
- **NavMenu.razor**:
  - Added "Settings" menu item (visible to supervisors and admins)

## Usage Instructions

### For Administrators

1. **Navigate to Settings** (menu: Settings)
2. **Configure Broker**:
   - Enter broker host, port, username, password
   - Specify MQTT topic pattern
   - Click "Save Broker Settings"
   - System reconnects automatically
3. **Configure Machines**:
   - Add machines manually or from discovered list
   - Remove unwanted machines
   - Click "Save Machine Configuration"

### For Supervisors

1. **Navigate to Settings**
2. **Configure Machines** (Broker section not visible):
   - View discovered machines from MQTT
   - Add machines to enabled list
   - Remove machines from list
   - Save configuration

### For Users
- Settings page not accessible
- See only machines configured by supervisors/admins

## Settings File Format

The `appsettings.json` file structure:

```json
{
  "Broker": {
    "Host": "localhost",
    "Port": 1883,
    "Username": "EWON",
    "Password": "admin123",
    "Topic": "local/#"
  },
  "Machines": {
    "EnabledMachines": [
      "Machine1",
      "Machine2",
      "Machine3"
    ]
  }
}
```

## Default Settings

If no `appsettings.json` file exists, default settings are used:
- **Host**: localhost
- **Port**: 1883
- **Username**: EWON
- **Password**: admin123
- **Topic**: local/#
- **Enabled Machines**: Empty list (shows all machines)

## Security Considerations

⚠️ **Important for Production**:
- Store broker credentials securely
- Use environment variables for sensitive data
- Encrypt passwords in settings file
- Implement settings backup/restore
- Add audit logging for settings changes
- Consider using Azure Key Vault or similar for production

## Troubleshooting

### Settings Not Saving
- Check file permissions in application directory
- Verify JSON format is valid
- Check console for error messages

### Broker Not Connecting
- Verify host/IP is correct
- Check port is not blocked by firewall
- Confirm username/password are correct
- Check MQTT broker is running

### Machines Not Appearing
- Check if machine is in enabled list
- Verify MQTT broker is sending data
- Check topic subscription matches broker topic
- Look at Debug page for received data

### Settings Not Loading
- Verify `appsettings.json` exists
- Check JSON syntax is valid
- Review console logs for errors
- Delete file to use defaults

## Testing the System

1. **Test with default settings**: Start application without `appsettings.json`
2. **Test broker config**: Change broker settings and verify reconnection
3. **Test machine filtering**: 
   - Add/remove machines
   - Verify home page updates
   - Check different user roles see appropriate access
4. **Test persistence**: Restart application and verify settings are retained

## Future Enhancements

Possible improvements:
- Export/import settings
- Settings history/audit log
- Multiple broker connections
- Machine groups/categories
- Custom machine display order
- Settings validation and error handling
- Settings backup on change
- Role-based machine visibility
