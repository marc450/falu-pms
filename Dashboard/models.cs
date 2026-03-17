namespace Dashboard
{
    public class MQTTShiftDataReceived
    {
        public string Machine { get; set; }
        public int Shift { get; set; }
        public long ProductionTime { get; set; }
        public long IdleTime { get; set; }
        public long CottonTears { get; set; }
        public long MissingSticks { get; set; }
        public long FoultyPickups { get; set; }
        public long OtherErrors { get; set; }
        public long ProducedSwaps { get; set; }
        public long PackagedSwaps { get; set; }
        public long ProducedBoxes { get; set; }
        public long ProducedBoxesLayerPlus { get; set; }
        public long DisgardedSwaps { get; set; }
        public double Efficiency { get; set; }
        public double Reject { get; set; }
        public bool Save { get; set; }
    }

    public class MQTTShiftRequest
    {
        public string Machine { get; set; } = "";
        public int Shift { get; set; }
    }

    public class MQTTMachineDataReceived
    {

        public string Machine { get; set; }
        public string Status { get; set; }
        public string Error { get; set; }
        public int ActShift { get; set; }
        public long Speed { get; set; }
        public long Swaps { get; set; }
        public long Boxes { get; set; }
        public double Efficiency { get; set; }
        public double Reject { get; set; }
    }

    public class MachineData
    {
        public string Machine { get; set; } = "";
        public MQTTMachineDataReceived? MachineStatus { get; set; }
        public MQTTShiftDataReceived? Shift1 { get; set; }
        public MQTTShiftDataReceived? Shift2 { get; set; }
        public MQTTShiftDataReceived? Shift3 { get; set; }
        public MQTTShiftDataReceived? Total { get; set; }
        public DateTime LastSyncStatus { get; set; }
        public DateTime LastSyncShift { get; set; }
        public DateTime LastRequestShift { get; set; }
        /// <summary>Timestamp of the last status change (idle / error / offline / run).</summary>
        public DateTime StatusSince { get; set; } = DateTime.MinValue;
    }
}
