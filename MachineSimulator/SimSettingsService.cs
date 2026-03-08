using System.Text.Json;

namespace MachineSimulator
{
    public class SimSettingsService
    {
        private readonly string _path = "simulator_settings.json";
        private SimulatorSettings _settings = new();

        public event Action? OnSettingsChanged;

        public SimSettingsService()
        {
            Load();
        }

        private void Load()
        {
            try
            {
                if (File.Exists(_path))
                {
                    var json = File.ReadAllText(_path);
                    _settings = JsonSerializer.Deserialize<SimulatorSettings>(json) ?? new();
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Settings] Load error: {ex.Message}");
            }
        }

        private void Save()
        {
            try
            {
                File.WriteAllText(_path, JsonSerializer.Serialize(_settings, new JsonSerializerOptions { WriteIndented = true }));
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Settings] Save error: {ex.Message}");
            }
        }

        public SimulatorSettings GetSettings() => _settings;
        public BrokerSettings GetBrokerSettings() => _settings.Broker;

        public void SaveBrokerSettings(BrokerSettings broker)
        {
            _settings.Broker = broker;
            Save();
            OnSettingsChanged?.Invoke();
        }

        public void SaveMachineNames(List<string> names)
        {
            _settings.MachineNames = names;
            Save();
        }

        public void SaveSendingEnabled(bool enabled)
        {
            _settings.SendingEnabled = enabled;
            Save();
        }
    }
}
