namespace Dashboard
{
    public class BrokerSettings
    {
        public string Host { get; set; } = "localhost";
        public int Port { get; set; } = 1883;
        public string Username { get; set; } = "EWON";
        public string Password { get; set; } = "admin123";
        public bool IsLocal { get; set; } = true;

        public string GetSubscribeTopic()
        {
            return IsLocal ? "local/#" : "cloud/*";
        }

        public string GetPublishTopicPrefix()
        {
            return IsLocal ? "local" : "cloud";
        }
    }

    public class MachineSettings
    {
        public List<string> EnabledMachines { get; set; } = new List<string>();
    }

    public class ApplicationSettings
    {
        public BrokerSettings Broker { get; set; } = new BrokerSettings();
        public MachineSettings Machines { get; set; } = new MachineSettings();
    }
}
