using System.Timers;

namespace MachineSimulator
{
    public class SimulatorService : IDisposable
    {
        // ── Shift schedule constants ───────────────────────────────────────────────
        // Shifts cycle: 1 (07:00–19:00) → 2 (19:00–07:00) → 3 (07:00–19:00) → repeat
        // The anchor is any historical Monday 07:00 — used purely as a modulo origin.
        private static readonly DateTime ShiftAnchor =
            new DateTime(2000, 1, 3, 7, 0, 0, DateTimeKind.Local); // 2000-01-03 was a Monday

        private const int ShiftDurationHours = 12;
        private const int ShiftCycleLength   = 3; // shifts before repeating

        // ── Returns the current shift number (1, 2, or 3) based on wall-clock time ─
        public static int ComputeCurrentShift()
        {
            var elapsed = DateTime.Now - ShiftAnchor;
            if (elapsed.TotalHours < 0) elapsed = TimeSpan.Zero;
            var block = (long)(elapsed.TotalHours / ShiftDurationHours);
            return (int)(block % ShiftCycleLength) + 1; // 1-based
        }

        // ── Returns the DateTime when the next shift boundary occurs ──────────────
        public static DateTime NextShiftChangeTime()
        {
            var elapsed = DateTime.Now - ShiftAnchor;
            if (elapsed.TotalHours < 0) elapsed = TimeSpan.Zero;
            var block = (long)(elapsed.TotalHours / ShiftDurationHours);
            return ShiftAnchor.AddHours((block + 1) * ShiftDurationHours);
        }

        private readonly SimSettingsService _settings;
        private readonly Random _rng = new();
        private System.Timers.Timer? _timer;

        public List<SimMachine> Machines { get; } = new();
        public bool SendingEnabled { get; private set; }

        // Raised on every simulation tick (for UI refresh)
        public event Action? OnDataChanged;

        // Raised when a status message is ready to publish
        public event Action<SimStatusMessage>? OnStatusReady;

        // Raised when a shift message is ready to publish
        public event Action<SimShiftMessage>? OnShiftReady;

        public SimulatorService(SimSettingsService settings)
        {
            _settings = settings;

            foreach (var name in settings.GetSettings().MachineNames)
                Machines.Add(CreateMachine(name));

            // Initialise each machine to the currently scheduled shift
            var currentShift = ComputeCurrentShift();
            foreach (var m in Machines)
                m.ActShift = currentShift;

            SendingEnabled = settings.GetSettings().SendingEnabled;
            RestartTimer();
        }

        // ─────────────────────────── Machine management ───────────────────────────

        private SimMachine CreateMachine(string name) => new()
        {
            Name = name,
            Status = "idle",
            ActShift = 1
        };

        public void AddMachine(string name)
        {
            name = name.Trim();
            if (string.IsNullOrWhiteSpace(name) ||
                Machines.Any(m => m.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                return;

            var m = CreateMachine(name);
            m.ActShift = ComputeCurrentShift();
            Machines.Add(m);
            PersistMachines();
            OnDataChanged?.Invoke();
        }

        public void RemoveMachine(string name)
        {
            var m = Machines.FirstOrDefault(x => x.Name == name);
            if (m == null) return;
            Machines.Remove(m);
            PersistMachines();
            OnDataChanged?.Invoke();
        }

        private void PersistMachines() =>
            _settings.SaveMachineNames(Machines.Select(m => m.Name).ToList());

        // ─────────────────────────── User controls ────────────────────────────────

        public void SetStatus(SimMachine m, string status)
        {
            m.Status = status;
            if (status != "error") m.Error = "";
            OnDataChanged?.Invoke();
        }

        public void SetShift(SimMachine m, int shift)
        {
            m.ActShift = shift;
            OnDataChanged?.Invoke();
        }

        public void EnableSending(bool enabled)
        {
            SendingEnabled = enabled;
            _settings.SaveSendingEnabled(enabled);
            OnDataChanged?.Invoke();
        }

        // Called by UI: immediately send shift data with Save=true, then reset
        public void TriggerSave(SimMachine m, int shift)
        {
            OnShiftReady?.Invoke(BuildShift(m, shift, m.GetShift(shift), save: true));
            OnShiftReady?.Invoke(BuildShift(m, 4, m.Total, save: false));
            Console.WriteLine($"[Sim] Save triggered for {m.Name} Shift {shift}");
        }

        // Called by MqttSimService when RequestShift arrives
        public void HandleRequestShift(string machineName, int requestedShift)
        {
            var m = Machines.FirstOrDefault(x =>
                x.Name.Equals(machineName, StringComparison.OrdinalIgnoreCase));
            if (m == null) return;

            if (requestedShift == 0)
            {
                // Send all shifts and total
                OnShiftReady?.Invoke(BuildShift(m, 1, m.Shift1));
                OnShiftReady?.Invoke(BuildShift(m, 2, m.Shift2));
                OnShiftReady?.Invoke(BuildShift(m, 3, m.Shift3));
                OnShiftReady?.Invoke(BuildShift(m, 4, m.Total));
            }
            else if (requestedShift >= 1 && requestedShift <= 3)
            {
                // Send requested shift + total
                OnShiftReady?.Invoke(BuildShift(m, requestedShift, m.GetShift(requestedShift)));
                OnShiftReady?.Invoke(BuildShift(m, 4, m.Total));
            }
        }

        // ─────────────────────────── Shift rotation ───────────────────────────────

        // Called every tick: if the scheduled shift has changed, save outgoing
        // shift data, reset its counters, and move to the new shift.
        private void CheckAndRotateShift(SimMachine m)
        {
            var scheduled = ComputeCurrentShift();
            if (m.ActShift == scheduled) return;

            var outgoingShift = m.ActShift;

            // Publish save for the outgoing shift and current total
            if (SendingEnabled)
            {
                OnShiftReady?.Invoke(BuildShift(m, outgoingShift, m.GetShift(outgoingShift), save: true));
                OnShiftReady?.Invoke(BuildShift(m, 4, m.Total, save: false));
            }

            Console.WriteLine($"[Sim] {m.Name}: Shift {outgoingShift} → {scheduled} at {DateTime.Now:HH:mm:ss}");

            // Reset the incoming shift's counters so it starts fresh
            m.GetShift(scheduled).Reset();

            m.ActShift = scheduled;
        }

        // ─────────────────────────── Timer & simulation ───────────────────────────

        public void RestartTimer()
        {
            _timer?.Stop();
            _timer?.Dispose();
            var freq = Math.Max(500, _settings.GetBrokerSettings().SendFrequencyMs);
            _timer = new System.Timers.Timer(freq);
            _timer.Elapsed += (_, _) => Tick();
            _timer.AutoReset = true;
            _timer.Start();
        }

        private void Tick()
        {
            foreach (var m in Machines)
                CheckAndRotateShift(m);

            foreach (var m in Machines)
                Simulate(m);

            if (SendingEnabled)
                foreach (var m in Machines)
                    OnStatusReady?.Invoke(BuildStatus(m));

            OnDataChanged?.Invoke();
        }

        private void Simulate(SimMachine m)
        {
            if (m.Status == "idle")
            {
                m.GetShift(m.ActShift).IdleTime++;
                m.Speed = 0;
                UpdateTotal(m);
                return;
            }

            if (m.Status == "error")
            {
                m.Speed = 0;
                return;
            }

            // Status == "running"
            var s = m.GetShift(m.ActShift);
            s.ProductionTime++;

            var produced = (long)_rng.Next(8, 25);
            var discarded = (long)_rng.Next(0, 3);
            s.ProducedSwaps += produced;
            s.PackagedSwaps += produced - discarded;
            s.DisgardedSwaps += discarded;
            s.ProducedBoxes += _rng.Next(1, 4);
            s.ProducedBoxesLayerPlus += _rng.Next(0, 2);

            // Rare errors
            if (_rng.Next(0, 40) == 0) s.CottonTears++;
            if (_rng.Next(0, 60) == 0) s.MissingSticks++;
            if (_rng.Next(0, 70) == 0) s.FoultyPickups++;
            if (_rng.Next(0, 90) == 0) s.OtherErrors++;

            s.Reject = s.ProducedSwaps > 0
                ? Math.Round((double)s.DisgardedSwaps / s.ProducedSwaps * 100, 1)
                : 0;
            s.Efficiency = Math.Round(85.0 + _rng.NextDouble() * 13.0, 1);

            m.Speed = 1200 + _rng.Next(-200, 400);
            m.Efficiency = s.Efficiency;
            m.Reject = s.Reject;

            UpdateTotal(m);
        }

        private static void UpdateTotal(SimMachine m)
        {
            m.Total.ProductionTime       = m.Shift1.ProductionTime + m.Shift2.ProductionTime + m.Shift3.ProductionTime;
            m.Total.IdleTime             = m.Shift1.IdleTime + m.Shift2.IdleTime + m.Shift3.IdleTime;
            m.Total.CottonTears          = m.Shift1.CottonTears + m.Shift2.CottonTears + m.Shift3.CottonTears;
            m.Total.MissingSticks        = m.Shift1.MissingSticks + m.Shift2.MissingSticks + m.Shift3.MissingSticks;
            m.Total.FoultyPickups        = m.Shift1.FoultyPickups + m.Shift2.FoultyPickups + m.Shift3.FoultyPickups;
            m.Total.OtherErrors          = m.Shift1.OtherErrors + m.Shift2.OtherErrors + m.Shift3.OtherErrors;
            m.Total.ProducedSwaps        = m.Shift1.ProducedSwaps + m.Shift2.ProducedSwaps + m.Shift3.ProducedSwaps;
            m.Total.PackagedSwaps        = m.Shift1.PackagedSwaps + m.Shift2.PackagedSwaps + m.Shift3.PackagedSwaps;
            m.Total.ProducedBoxes        = m.Shift1.ProducedBoxes + m.Shift2.ProducedBoxes + m.Shift3.ProducedBoxes;
            m.Total.ProducedBoxesLayerPlus = m.Shift1.ProducedBoxesLayerPlus + m.Shift2.ProducedBoxesLayerPlus + m.Shift3.ProducedBoxesLayerPlus;
            m.Total.DisgardedSwaps       = m.Shift1.DisgardedSwaps + m.Shift2.DisgardedSwaps + m.Shift3.DisgardedSwaps;
            m.Total.Reject               = m.Total.ProducedSwaps > 0
                ? Math.Round((double)m.Total.DisgardedSwaps / m.Total.ProducedSwaps * 100, 1)
                : 0;
            m.Total.Efficiency = Math.Round(
                (m.Shift1.Efficiency + m.Shift2.Efficiency + m.Shift3.Efficiency) / 3.0, 1);
        }

        // ─────────────────────────── Message builders ────────────────────────────

        public SimStatusMessage BuildStatus(SimMachine m)
        {
            var s = m.GetShift(m.ActShift);
            return new SimStatusMessage
            {
                Machine = m.Name,
                Status = m.Status,
                Error = m.Error,
                ActShift = m.ActShift,
                Speed = m.Speed,
                Swaps = s.ProducedSwaps,
                Boxes = s.ProducedBoxes,
                Efficiency = m.Efficiency,
                Reject = m.Reject
            };
        }

        private static SimShiftMessage BuildShift(SimMachine m, int shiftNum, ShiftData d, bool save = false) =>
            new()
            {
                Machine = m.Name,
                Shift = shiftNum,
                ProductionTime = d.ProductionTime,
                IdleTime = d.IdleTime,
                CottonTears = d.CottonTears,
                MissingSticks = d.MissingSticks,
                FoultyPickups = d.FoultyPickups,
                OtherErrors = d.OtherErrors,
                ProducedSwaps = d.ProducedSwaps,
                PackagedSwaps = d.PackagedSwaps,
                ProducedBoxes = d.ProducedBoxes,
                ProducedBoxesLayerPlus = d.ProducedBoxesLayerPlus,
                DisgardedSwaps = d.DisgardedSwaps,
                Efficiency = d.Efficiency,
                Reject = d.Reject,
                Save = save
            };

        public void Dispose()
        {
            _timer?.Stop();
            _timer?.Dispose();
        }
    }
}
