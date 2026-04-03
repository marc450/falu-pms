namespace MachineSimulator
{
    public class BrokerSettings
    {
        public string Host { get; set; } = "localhost";
        public int Port { get; set; } = 1883;
        public string Username { get; set; } = "EWON";
        public string Password { get; set; } = "admin123";
        public bool IsLocal { get; set; } = true;
        public int SendFrequencyMs { get; set; } = 2000;

        public string GetSubscribeTopic() => IsLocal ? "local/#" : "cloud/#";
        public string GetPublishTopicPrefix() => IsLocal ? "local" : "cloud";
    }

    public class SimulatorSettings
    {
        public BrokerSettings Broker { get; set; } = new();
        public List<string> MachineNames { get; set; } = new();
        public bool SendingEnabled { get; set; } = false;
    }
}
