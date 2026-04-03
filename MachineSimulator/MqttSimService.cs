using MQTTnet;
using System.Buffers;
using System.Text.Json;

namespace MachineSimulator
{
    public class MqttSimService : IDisposable
    {
        private readonly SimSettingsService _settings;
        private readonly SimulatorService _simulator;
        private IMqttClient? _client;
        private MqttClientOptions _options;

        public bool IsConnected { get; private set; }
        public event Action<bool>? OnConnectionChanged;

        public MqttSimService(SimSettingsService settings, SimulatorService simulator)
        {
            _settings = settings;
            _simulator = simulator;
            _options = BuildOptions();

            _simulator.OnStatusReady += PublishStatus;
            _simulator.OnShiftReady  += PublishShift;
            _settings.OnSettingsChanged += OnSettingsChanged;

            _ = Connect();
        }

        // ─────────────────────────── Connection ──────────────────────────────────

        private MqttClientOptions BuildOptions()
        {
            var b = _settings.GetBrokerSettings();
            var builder = new MqttClientOptionsBuilder()
                .WithCredentials(b.Username, b.Password)
                .WithCleanSession()
                .WithNoKeepAlive()
                .WithTcpServer(b.Host, b.Port);

            if (!b.IsLocal)
                builder.WithTlsOptions(o => o.UseTls());

            return builder.Build();
        }

        public async Task Connect()
        {
            try
            {
                var factory = new MqttClientFactory();
                _client = factory.CreateMqttClient();

                _client.ConnectedAsync += async e =>
                {
                    IsConnected = true;
                    OnConnectionChanged?.Invoke(true);
                    var topic = _settings.GetBrokerSettings().GetSubscribeTopic();
                    await _client.SubscribeAsync(topic);
                    Console.WriteLine($"[MQTT-Sim] Connected, subscribed to {topic}");
                    await Task.CompletedTask;
                };

                _client.DisconnectedAsync += async e =>
                {
                    IsConnected = false;
                    OnConnectionChanged?.Invoke(false);
                    Console.WriteLine("[MQTT-Sim] Disconnected – retrying in 5s...");
                    await Task.Delay(5000);
                    try { await _client.ConnectAsync(_options); }
                    catch (Exception ex) { Console.WriteLine($"[MQTT-Sim] Reconnect failed: {ex.Message}"); }
                };

                _client.ApplicationMessageReceivedAsync += HandleMessage;

                await _client.ConnectAsync(_options);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[MQTT-Sim] Connect error: {ex.Message}");
            }
        }

        private async void OnSettingsChanged()
        {
            try
            {
                _options = BuildOptions();
                if (_client != null)
                    await _client.DisconnectAsync();
                await Connect();
            }
            catch (Exception ex) { Console.WriteLine($"[MQTT-Sim] Reconnect error: {ex.Message}"); }
        }

        // ─────────────────────────── Incoming messages ───────────────────────────

        private async Task HandleMessage(MqttApplicationMessageReceivedEventArgs e)
        {
            var topic   = e.ApplicationMessage.Topic;
            var payload = System.Text.Encoding.UTF8.GetString(e.ApplicationMessage.Payload.ToArray());

            try
            {
                if (topic.Contains("RequestShift"))
                {
                    var req = JsonSerializer.Deserialize<SimShiftRequest>(payload);
                    if (req != null)
                    {
                        Console.WriteLine($"[MQTT-Sim] RequestShift: Machine={req.Machine}, Shift={req.Shift}");
                        _simulator.HandleRequestShift(req.Machine, req.Shift);
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine($"[MQTT-Sim] HandleMessage error: {ex.Message}"); }

            await Task.CompletedTask;
        }

        // ─────────────────────────── Publishing ──────────────────────────────────

        private async void PublishStatus(SimStatusMessage msg)
        {
            if (_client == null || !IsConnected) return;
            try
            {
                var prefix = _settings.GetBrokerSettings().GetPublishTopicPrefix();
                await Publish($"{prefix}/Status", msg);
            }
            catch (Exception ex) { Console.WriteLine($"[MQTT-Sim] PublishStatus error: {ex.Message}"); }
        }

        private async void PublishShift(SimShiftMessage msg)
        {
            if (_client == null || !IsConnected) return;
            try
            {
                var prefix = _settings.GetBrokerSettings().GetPublishTopicPrefix();
                await Publish($"{prefix}/Shift", msg);
                Console.WriteLine($"[MQTT-Sim] Shift {msg.Shift} published for {msg.Machine} (Save={msg.Save})");
            }
            catch (Exception ex) { Console.WriteLine($"[MQTT-Sim] PublishShift error: {ex.Message}"); }
        }

        private async Task Publish<T>(string topic, T payload)
        {
            var json = JsonSerializer.Serialize(payload);
            var msg  = new MqttApplicationMessageBuilder()
                .WithTopic(topic)
                .WithPayload(json)
                .Build();
            await _client!.PublishAsync(msg);
        }

        public void Dispose()
        {
            _simulator.OnStatusReady -= PublishStatus;
            _simulator.OnShiftReady  -= PublishShift;
            _settings.OnSettingsChanged -= OnSettingsChanged;
            _client?.DisconnectAsync().Wait(2000);
        }
    }
}
