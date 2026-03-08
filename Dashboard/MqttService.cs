using Dashboard;
using Microsoft.Extensions.Options;
using MQTTnet;
using System.Buffers;
using System.Text.Json;
using Microsoft.Extensions.Configuration;


    public class MqttService
    {
        private IMqttClient _mqttClient;
        private MqttClientOptions _options;
        private readonly string _allMachinesLogPath = "wwwroot/logs/AllMachines.csv";
        private readonly string _machineLogBasePath = "wwwroot/logs/machines/";
        private readonly SettingsService _settingsService;

        // Central data storage for all Razor pages
        public Dictionary<string, MachineData> AllMachines { get; } = new();
        public int CurrentShiftNumber { get; private set; } = 1;
        public bool IsConnected { get; private set; } = false;

        // Event that notifies the UI (Home/Production) when data changes
        public event Action? OnDataChanged;
        public event Action<bool>? OnConnectionStatusChanged;

        public MqttService(SettingsService settingsService)
        {
            _settingsService = settingsService;
            var factory = new MqttClientFactory();
            _mqttClient = factory.CreateMqttClient();

            BuildConnectionOptions();

            _mqttClient.ApplicationMessageReceivedAsync += HandleMessage;

            // Connection status handling
            _mqttClient.ConnectedAsync += async e =>
            {
                IsConnected = true;
                OnConnectionStatusChanged?.Invoke(true);
                Console.WriteLine("MQTT Connected");
                await Task.CompletedTask;
            };

            // Optional: Automatic reconnect on connection loss
            _mqttClient.DisconnectedAsync += async e =>
            {
                IsConnected = false;
                OnConnectionStatusChanged?.Invoke(false);
                Console.WriteLine("MQTT Disconnected - Attempting reconnection...");

                await Task.Delay(TimeSpan.FromSeconds(5));
                try 
                { 
                    await _mqttClient.ConnectAsync(_options); 
                } 
                catch (Exception ex)
                {
                    Console.WriteLine($"Reconnection failed: {ex.Message}");
                }
            };

            // Subscribe to settings changes
            _settingsService.OnSettingsChanged += OnSettingsChanged;

            Connect();
        }

        private void BuildConnectionOptions()
        {
            var brokerSettings = _settingsService.GetBrokerSettings();

            var builder = new MqttClientOptionsBuilder()
                .WithCredentials(brokerSettings.Username, brokerSettings.Password)
                .WithCleanSession()
                .WithTcpServer(brokerSettings.Host, brokerSettings.Port);

            // Enable TLS for cloud brokers (IsLocal = false → HiveMQ, Azure, etc.)
            if (!brokerSettings.IsLocal)
            {
                builder.WithTlsOptions(o => o.UseTls());
                Console.WriteLine($"[MQTT] TLS enabled → {brokerSettings.Host}:{brokerSettings.Port}");
            }
            else
            {
                Console.WriteLine($"[MQTT] Plain TCP → {brokerSettings.Host}:{brokerSettings.Port}");
            }

            _options = builder.Build();
        }

        private async void OnSettingsChanged()
        {
            // Reconnect with new settings
            try
            {
                await _mqttClient.DisconnectAsync();
                BuildConnectionOptions();
                await Connect();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error reconnecting after settings change: {ex.Message}");
            }
        }

        public async Task Connect()
        {
            try
            {
                await _mqttClient.ConnectAsync(_options);
                IsConnected = true;
                OnConnectionStatusChanged?.Invoke(true);

                // Subscribe to configured topic
                var brokerSettings = _settingsService.GetBrokerSettings();
                var topic = brokerSettings.GetSubscribeTopic();
                await _mqttClient.SubscribeAsync(topic);
                Console.WriteLine($"Connected to broker at {brokerSettings.Host}:{brokerSettings.Port}, subscribed to {topic}");
            //    await _mqttClient.SubscribeAsync("maschinen/+/production");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"MQTT Connection Error: {ex.Message}");
            }
        }

        public async Task RequestShiftData(string machine, int shift)
        {
            try
            {
                var request = new MQTTShiftRequest
                {
                    Machine = machine,
                    Shift = shift
                };

                var brokerSettings = _settingsService.GetBrokerSettings();
                var topicPrefix = brokerSettings.GetPublishTopicPrefix();
                var topic = $"{topicPrefix}/RequestShift";

                var json = JsonSerializer.Serialize(request);
                var message = new MqttApplicationMessageBuilder()
                    .WithTopic(topic)
                    .WithPayload(json)
                    .WithQualityOfServiceLevel(MQTTnet.Protocol.MqttQualityOfServiceLevel.AtLeastOnce)
                    .Build();

                await _mqttClient.PublishAsync(message);

                // Update last request time
                if (AllMachines.ContainsKey(machine))
                {
                    AllMachines[machine].LastRequestShift = DateTime.Now;
                }

                Console.WriteLine($"Shift data requested for {machine}, Shift {shift} on topic {topic}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error requesting shift data: {ex.Message}");
            }
        }

        private async Task HandleMessage(MqttApplicationMessageReceivedEventArgs e)
        {
            var topic = e.ApplicationMessage.Topic;
            var payload = System.Text.Encoding.UTF8.GetString(e.ApplicationMessage.Payload.ToArray());

            try
            {
                if (topic.Contains("Status"))
                {
                    var data = JsonSerializer.Deserialize<MQTTMachineDataReceived>(payload);
                    if (data != null) UpdateMachineStatus(data);
                }
                else if (topic.Contains("Shift"))
                {
                    var data = JsonSerializer.Deserialize<MQTTShiftDataReceived>(payload);
                    if (data != null) UpdateShiftData(data);
                }

                // Notify all registered Razor pages (Home, Production etc.)
                OnDataChanged?.Invoke();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error processing message: {ex.Message}");
            }
        }

        private void UpdateMachineStatus(MQTTMachineDataReceived data)
        {
            if (!AllMachines.ContainsKey(data.Machine))
                AllMachines[data.Machine] = new MachineData { Machine = data.Machine };

            var m = AllMachines[data.Machine];
            m.MachineStatus = data;
            m.LastSyncStatus = DateTime.Now;
            CurrentShiftNumber = data.ActShift; // Sets the global shift number
        }

        private void UpdateShiftData(MQTTShiftDataReceived data)
        {
            if (!AllMachines.ContainsKey(data.Machine))
                AllMachines[data.Machine] = new MachineData { Machine = data.Machine };

            var m = AllMachines[data.Machine];

            // Only update shift data if it contains meaningful data (not all zeros)
            // This prevents overwriting existing shift data with empty responses
            bool hasData = data.ProductionTime > 0 || 
                          data.IdleTime > 0 || 
                          data.ProducedSwaps > 0 || 
                          data.ProducedBoxes > 0;

            // Sort into the correct shift of the MachineData class
            // Only update if we have data OR if the slot is currently null
            switch (data.Shift)
            {
                case 1:
                    if (hasData || m.Shift1 == null)
                    {
                        m.Shift1 = data;
                        Console.WriteLine($"Shift1 updated for {data.Machine} - HasData: {hasData}, ProdTime: {data.ProductionTime}");
                    }
                    else
                    {
                        Console.WriteLine($"Shift1 update skipped for {data.Machine} - Empty data received");
                    }
                    break;
                case 2:
                    if (hasData || m.Shift2 == null)
                    {
                        m.Shift2 = data;
                        Console.WriteLine($"Shift2 updated for {data.Machine} - HasData: {hasData}, ProdTime: {data.ProductionTime}");
                    }
                    else
                    {
                        Console.WriteLine($"Shift2 update skipped for {data.Machine} - Empty data received");
                    }
                    break;
                case 3:
                    if (hasData || m.Shift3 == null)
                    {
                        m.Shift3 = data;
                        Console.WriteLine($"Shift3 updated for {data.Machine} - HasData: {hasData}, ProdTime: {data.ProductionTime}");
                    }
                    else
                    {
                        Console.WriteLine($"Shift3 update skipped for {data.Machine} - Empty data received");
                    }
                    break;
                case 4:
                    if (hasData || m.Total == null)
                    {
                        m.Total = data;
                        Console.WriteLine($"Total updated for {data.Machine} - HasData: {hasData}, ProdTime: {data.ProductionTime}");
                    }
                    else
                    {
                        Console.WriteLine($"Total update skipped for {data.Machine} - Empty data received");
                    }
                    break;
                default:
                    Console.WriteLine($"Invalid shift number received: {data.Shift} for {data.Machine}");
                    break;
            }

            // Only update sync time if we actually updated data
            if (hasData)
            {
                m.LastSyncShift = DateTime.Now;
            }

            // Persistent logging when the Save flag comes from the PLC
            if (data.Save)
            {
                Console.WriteLine($"Save flag received for {data.Machine}, Shift {data.Shift} - Logging to CSV...");
                LogToMachineCsv(data);
                LogToAllMachinesCsv(data);
            }
        }

        private void LogToMachineCsv(MQTTShiftDataReceived data)
        {
            try
            {
                var machineLogPath = $"{_machineLogBasePath}{data.Machine}.csv";
                var dir = Path.GetDirectoryName(machineLogPath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir!);

                bool fileExists = File.Exists(machineLogPath);
                using (var writer = new StreamWriter(machineLogPath, append: true, encoding: System.Text.Encoding.UTF8))
                {
                    if (!fileExists)
                    {
                        writer.WriteLine("Timestamp;Machine;Shift;ProductionTime;IdleTime;CottonTears;MissingSticks;FoultyPickups;OtherErrors;ProducedSwaps;PackagedSwaps;ProducedBoxes;ProducedBoxesLayerPlus;DisgardedSwaps;Efficiency;Reject");
                    }

                    var prodTime = FormatMinutesToTime(data.ProductionTime);
                    var idleTime = FormatMinutesToTime(data.IdleTime);
                    writer.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss};{data.Machine};{data.Shift};{prodTime};{idleTime};{data.CottonTears};{data.MissingSticks};{data.FoultyPickups};{data.OtherErrors};{data.ProducedSwaps};{data.PackagedSwaps};{data.ProducedBoxes};{data.ProducedBoxesLayerPlus};{data.DisgardedSwaps};{data.Efficiency:F2};{data.Reject:F2}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"CSV Logging Error (Machine): {ex.Message}");
            }
        }

        private void LogToAllMachinesCsv(MQTTShiftDataReceived data)
        {
            try
            {
                var dir = Path.GetDirectoryName(_allMachinesLogPath);
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir!);

                bool fileExists = File.Exists(_allMachinesLogPath);
                using (var writer = new StreamWriter(_allMachinesLogPath, append: true, encoding: System.Text.Encoding.UTF8))
                {
                    if (!fileExists)
                    {
                        writer.WriteLine("Timestamp;Machine;Shift;ProductionTime;IdleTime;CottonTears;MissingSticks;FoultyPickups;OtherErrors;ProducedSwaps;PackagedSwaps;ProducedBoxes;ProducedBoxesLayerPlus;DisgardedSwaps;Efficiency;Reject");
                    }

                    var prodTime = FormatMinutesToTime(data.ProductionTime);
                    var idleTime = FormatMinutesToTime(data.IdleTime);
                    writer.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss};{data.Machine};{data.Shift};{prodTime};{idleTime};{data.CottonTears};{data.MissingSticks};{data.FoultyPickups};{data.OtherErrors};{data.ProducedSwaps};{data.PackagedSwaps};{data.ProducedBoxes};{data.ProducedBoxesLayerPlus};{data.DisgardedSwaps};{data.Efficiency:F2};{data.Reject:F2}");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"CSV Logging Error (All Machines): {ex.Message}");
            }
        }

        private string FormatMinutesToTime(long minutes)
        {
            if (minutes == 0)
                return "00:00";

            var hours = minutes / 60;
            var mins = minutes % 60;
            return $"{hours:D2}:{mins:D2}";
        }
    }

