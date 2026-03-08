namespace Dashboard
{
    public class BrokerSettings
    {
        public string Host { get; set; } = "e21df7393cc24e69b198158d3af2b3d6.s1.eu.hivemq.cloud";
        public int Port { get; set; } = 8883;
        public string Username { get; set; } = "USCotton";
        public string Password { get; set; } = "Admin123";
        public bool IsLocal { get; set; } = false;

        public string GetSubscribeTopic()
        {
            return IsLocal ? "local/#" : "cloud/#";
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
