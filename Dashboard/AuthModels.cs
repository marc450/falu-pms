namespace Dashboard
{
    public enum UserRole
    {
        User,
        Supervisor,
        Administrator
    }

    public class UserAccount
    {
        public string Username { get; set; } = "";
        public string PasswordHash { get; set; } = "";
        public UserRole Role { get; set; }
    }

    public class CurrentUser
    {
        public string Username { get; set; } = "";
        public UserRole Role { get; set; }
        public bool IsAuthenticated { get; set; }
    }
}
