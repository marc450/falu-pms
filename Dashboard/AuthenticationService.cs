using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Dashboard
{
    public class AuthenticationService
    {
        private CurrentUser _currentUser = new CurrentUser();
        private List<UserAccount> _users = new();
        private readonly string _usersFilePath = "users.json";

        public event Action? OnAuthStateChanged;
        public event Action? OnUsersChanged;

        public AuthenticationService()
        {
            LoadUsers();
        }

        private void LoadUsers()
        {
            try
            {
                if (File.Exists(_usersFilePath))
                {
                    var json = File.ReadAllText(_usersFilePath);
                    var users = JsonSerializer.Deserialize<List<UserAccount>>(json);
                    if (users != null && users.Count > 0)
                    {
                        _users = users;
                        Console.WriteLine($"Loaded {_users.Count} users from {_usersFilePath}");
                        return;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error loading users: {ex.Message}");
            }

            // Default users if no file exists
            _users = new List<UserAccount>
            {
                new UserAccount { Username = "user",       PasswordHash = HashPassword("user123"),  Role = UserRole.User },
                new UserAccount { Username = "supervisor", PasswordHash = HashPassword("super123"), Role = UserRole.Supervisor },
                new UserAccount { Username = "admin",      PasswordHash = HashPassword("admin123"), Role = UserRole.Administrator }
            };
            SaveUsers();
        }

        private void SaveUsers()
        {
            try
            {
                var options = new JsonSerializerOptions { WriteIndented = true };
                var json = JsonSerializer.Serialize(_users, options);
                File.WriteAllText(_usersFilePath, json);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error saving users: {ex.Message}");
            }
        }

        public List<UserAccount> GetAllUsers() => _users.ToList();

        public (bool Success, string Error) CreateUser(string username, string password, UserRole role)
        {
            if (string.IsNullOrWhiteSpace(username))
                return (false, "Username cannot be empty.");

            if (string.IsNullOrWhiteSpace(password) || password.Length < 6)
                return (false, "Password must be at least 6 characters.");

            if (_users.Any(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase)))
                return (false, $"User '{username}' already exists.");

            _users.Add(new UserAccount
            {
                Username = username,
                PasswordHash = HashPassword(password),
                Role = role
            });

            SaveUsers();
            OnUsersChanged?.Invoke();
            return (true, "");
        }

        public (bool Success, string Error) DeleteUser(string username, string requestedByUsername)
        {
            if (username.Equals(requestedByUsername, StringComparison.OrdinalIgnoreCase))
                return (false, "You cannot delete your own account.");

            var user = _users.FirstOrDefault(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
            if (user == null)
                return (false, $"User '{username}' not found.");

            _users.Remove(user);
            SaveUsers();
            OnUsersChanged?.Invoke();
            return (true, "");
        }

        public (bool Success, string Error) ChangePassword(string username, string newPassword)
        {
            if (string.IsNullOrWhiteSpace(newPassword) || newPassword.Length < 6)
                return (false, "Password must be at least 6 characters.");

            var user = _users.FirstOrDefault(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));
            if (user == null)
                return (false, $"User '{username}' not found.");

            user.PasswordHash = HashPassword(newPassword);
            SaveUsers();
            return (true, "");
        }

        public CurrentUser GetCurrentUser() => _currentUser;

        public bool IsAuthenticated() => _currentUser.IsAuthenticated;

        public bool HasRole(UserRole role) => _currentUser.IsAuthenticated && _currentUser.Role >= role;

        public bool Login(string username, string password)
        {
            var user = _users.FirstOrDefault(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));

            if (user != null && user.PasswordHash == HashPassword(password))
            {
                _currentUser = new CurrentUser
                {
                    Username = user.Username,
                    Role = user.Role,
                    IsAuthenticated = true
                };

                OnAuthStateChanged?.Invoke();
                return true;
            }

            return false;
        }

        public void Logout()
        {
            _currentUser = new CurrentUser();
            OnAuthStateChanged?.Invoke();
        }

        public string HashPassword(string password)
        {
            using var sha256 = SHA256.Create();
            var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(password));
            return Convert.ToBase64String(bytes);
        }

        public string GetRoleDisplayName(UserRole role)
        {
            return role switch
            {
                UserRole.User => "User",
                UserRole.Supervisor => "Supervisor",
                UserRole.Administrator => "Administrator",
                _ => "Unknown"
            };
        }
    }
}
