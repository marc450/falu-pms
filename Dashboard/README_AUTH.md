# Dashboard Authentication & CSV Format Update

## Changes Made

### 1. CSV Time Format (Production Time & Idle Time)
- Updated `MqttService.cs` to format times as `hh:mm` in CSV files
- Added `FormatMinutesToTime()` method
- CSV files now show: `08:30` instead of `510` minutes

### 2. Authentication System Implemented

#### User Roles:
- **User** - Can only view data (Home & Production pages)
- **Supervisor** - Can view data + download log files
- **Administrator** - Full access including debug page

#### Default Accounts:
| Username    | Password   | Role          |
|-------------|------------|---------------|
| user        | user123    | User          |
| supervisor  | super123   | Supervisor    |
| admin       | admin123   | Administrator |

#### New Files Created:
1. `AuthModels.cs` - User account models and roles
2. `AuthenticationService.cs` - Authentication logic
3. `Login.razor` - Login page
4. `AuthorizeView.razor` - Component for page protection
5. `Unauthorized.razor` - Access denied page

#### Updated Files:
1. `Program.cs` - Added AuthenticationService singleton
2. `NavMenu.razor` - Shows username, role badge, role-based menu items, logout button
3. `Home.razor` - Protected with AuthorizeView
4. `Production.razor` - Protected with AuthorizeView
5. `Downloads.razor` - Requires Supervisor role or higher
6. `Debug.razor` - Requires Administrator role
7. `MqttService.cs` - CSV time formatting

## Navigation Menu Changes

### All Users:
- Home
- Production

### Supervisor + Administrator:
- Downloads (CSV export)

### Administrator Only:
- Debug (system diagnostics)

### Always Visible:
- Username and Role badge in header
- Logout button

## How to Use

1. **Start the application**
2. **Navigate to `/login`** (or any protected page will redirect to login)
3. **Login with one of the default accounts**
4. **Access pages based on your role**

## Security Notes

⚠️ **Important for Production:**
- Change default passwords immediately
- Store user credentials in a secure database (not in code)
- Use proper password hashing (current implementation uses SHA256)
- Implement password complexity requirements
- Add account lockout after failed attempts
- Consider using ASP.NET Core Identity for production

## CSV File Format

### Log Files Location:
- **All Machines:** `wwwroot/logs/AllMachines.csv`
- **Individual Machines:** `wwwroot/logs/machines/{MachineName}.csv`

### CSV Format:
```
Timestamp;Machine;Shift;ProductionTime;IdleTime;CottonTears;MissingSticks;FoultyPickups;OtherErrors;ProducedSwaps;PackagedSwaps;ProducedBoxes;ProducedBoxesLayerPlus;DisgardedSwaps;Efficiency;Reject
2024-01-15 08:30:15;Machine1;1;08:30;01:45;3;2;5;1;1250;1200;150;75;50;95.50;2.30
```

**Time Format:** `hh:mm` (hours:minutes)

## Testing Authentication

1. **Test as User:**
   - Login: `user` / `user123`
   - Should see: Home, Production
   - Should NOT see: Downloads, Debug

2. **Test as Supervisor:**
   - Login: `supervisor` / `super123`
   - Should see: Home, Production, Downloads
   - Should NOT see: Debug

3. **Test as Administrator:**
   - Login: `admin` / `admin123`
   - Should see: All pages (Home, Production, Downloads, Debug)

## Future Enhancements

- Settings page for administrators
- User management (add/edit/delete users)
- Password change functionality
- Remember me option
- Session timeout
- Activity logging
- Database integration for user storage
