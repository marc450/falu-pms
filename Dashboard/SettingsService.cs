using System.Text.Json;

namespace Dashboard
{
    public class SettingsService
    {
        private readonly string _settingsPath = "appsettings.json";
        private ApplicationSettings _settings;
        
        public event Action? OnSettingsChanged;

        public SettingsService()
        {
            _settings = LoadSettings();
        }

        public ApplicationSettings GetSettings()
        {
            return _settings;
        }

        public BrokerSettings GetBrokerSettings()
        {
            var host = Environment.GetEnvironmentVariable("BROKER__HOST");
            if (!string.IsNullOrEmpty(host))
            {
                return new BrokerSettings
                {
                    Host     = host,
                    Port     = int.TryParse(Environment.GetEnvironmentVariable("BROKER__PORT"), out var p) ? p : 1883,
                    Username = Environment.GetEnvironmentVariable("BROKER__USERNAME") ?? _settings.Broker.Username,
                    Password = Environment.GetEnvironmentVariable("BROKER__PASSWORD") ?? _settings.Broker.Password,
                    IsLocal  = bool.TryParse(Environment.GetEnvironmentVariable("BROKER__ISLOCAL"), out var l) ? l : _settings.Broker.IsLocal,
                };
            }
            return _settings.Broker;
        }

        public MachineSettings GetMachineSettings()
        {
            return _settings.Machines;
        }

        public void SaveBrokerSettings(BrokerSettings brokerSettings)
        {
            _settings.Broker = brokerSettings;
            SaveSettings();
            OnSettingsChanged?.Invoke();
        }

        public void SaveMachineSettings(MachineSettings machineSettings)
        {
            _settings.Machines = machineSettings;
            SaveSettings();
            OnSettingsChanged?.Invoke();
        }

        public bool IsMachineEnabled(string machineName)
        {
            if (_settings.Machines.EnabledMachines == null || !_settings.Machines.EnabledMachines.Any())
            {
                return true; // If no machines configured, show all
            }
            return _settings.Machines.EnabledMachines.Contains(machineName);
        }

        private ApplicationSettings LoadSettings()
        {
            try
            {
                if (File.Exists(_settingsPath))
                {
                    var json = File.ReadAllText(_settingsPath);
                    var settings = JsonSerializer.Deserialize<ApplicationSettings>(json);
                    if (settings != null)
                    {
                        Console.WriteLine($"Settings loaded from {_settingsPath}");
                        return settings;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error loading settings: {ex.Message}");
            }

            // Return default settings
            Console.WriteLine("Using default settings");
            return new ApplicationSettings();
        }

        private void SaveSettings()
        {
            try
            {
                var options = new JsonSerializerOptions
                {
                    WriteIndented = true
                };
                var json = JsonSerializer.Serialize(_settings, options);
                File.WriteAllText(_settingsPath, json);
                Console.WriteLine($"Settings saved to {_settingsPath}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error saving settings: {ex.Message}");
            }
        }

        public List<string> GetAllDiscoveredMachines()
        {
            // This will be populated by MqttService as machines are discovered
            return _settings.Machines.EnabledMachines.ToList();
        }

        public void AddDiscoveredMachine(string machineName)
        {
            if (!_settings.Machines.EnabledMachines.Contains(machineName))
            {
                _settings.Machines.EnabledMachines.Add(machineName);
                SaveSettings();
            }
        }
    }
}
