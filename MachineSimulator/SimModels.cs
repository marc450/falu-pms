namespace MachineSimulator
{
    // Matches Dashboard MQTTMachineDataReceived exactly
    public class SimStatusMessage
    {
        public string Machine { get; set; } = "";
        public string Status { get; set; } = "";
        public string Error { get; set; } = "";
        public int ActShift { get; set; }
        public long Speed { get; set; }
        public long Swaps { get; set; }
        public long Boxes { get; set; }
        public double Efficiency { get; set; }
        public double Reject { get; set; }
    }

    // Matches Dashboard MQTTShiftDataReceived exactly
    public class SimShiftMessage
    {
        public string Machine { get; set; } = "";
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

    // Matches Dashboard MQTTShiftRequest exactly
    public class SimShiftRequest
    {
        public string Machine { get; set; } = "";
        public int Shift { get; set; }
    }

    // Per-shift simulation data
    public class ShiftData
    {
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
    }

    // One simulated machine
    public class SimMachine
    {
        public string Name { get; set; } = "";
        public string Status { get; set; } = "idle";   // run | idle | error
        public int ActShift { get; set; } = 1;
        public string Error { get; set; } = "";
        public long Speed { get; set; }
        public double Efficiency { get; set; }
        public double Reject { get; set; }

        public ShiftData Shift1 { get; set; } = new();
        public ShiftData Shift2 { get; set; } = new();
        public ShiftData Shift3 { get; set; } = new();
        public ShiftData Total  { get; set; } = new();

        public ShiftData GetShift(int n) => n switch
        {
            1 => Shift1,
            2 => Shift2,
            3 => Shift3,
            _ => Total
        };
    }
}
