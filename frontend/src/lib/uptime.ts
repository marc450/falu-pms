import type { MachineData } from "./supabase";

// Recalculate uptime with a planned-downtime budget: scheduled breaks (up
// to the configured budget) are excluded from the denominator so they do
// not penalise the efficiency figure. Unlike calcBuRunRate, this function
// still uses the budget — uptime is a backward-looking measurement of
// machine performance against expectations, where forgiving scheduled
// breaks makes sense. (calcBuRunRate is purely trend-based; future breaks
// are implicit in past idle proportion.)
//
// All accumulators below are in SECONDS to match the bridge's authoritative
// PLC counters (m.machineStatus.ProductionTime / IdleTime are raw seconds,
// and m.errorTimeSeconds is mirrored in seconds too). plannedDowntimeMinutes
// is normalised to seconds once at the top so the denominator is unit-clean.
// Previously this function mixed seconds and minutes, which caused error
// time to be undercounted ~60× and inflated uptime for machines whose
// downtime is dominated by errors rather than scheduled idle.
//
// Shared by the dashboard (Avg Uptime tile + cell headers + machine rows)
// and the leaderboard (Floor Uptime gauge + cell EFF) so the two pages
// can never drift apart on the uptime formula.
export function calcCorrectedEfficiency(m: MachineData, plannedDowntimeMinutes: number): number | null {
  const activeShift     = m.machineStatus?.ActShift ?? 1;
  const activeShiftData = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
  const productionSecs  = activeShiftData?.ProductionTime ?? m.machineStatus?.ProductionTime ?? 0;
  const idleSecs        = activeShiftData?.IdleTime       ?? m.machineStatus?.IdleTime       ?? 0;
  const errorSecs       = m.errorTimeSeconds ?? 0;
  if (productionSecs === 0 && idleSecs === 0) return null;
  const plannedDowntimeSecs = plannedDowntimeMinutes * 60;
  // Separate error time from idle time so the downtime budget only forgives
  // genuine idle (scheduled breaks). Error time always counts against uptime.
  const idleOnlySecs    = Math.max(0, idleSecs - errorSecs);
  const unplannedIdleSecs = Math.max(0, idleOnlySecs - plannedDowntimeSecs);
  const effectiveSecs   = productionSecs + unplannedIdleSecs + errorSecs;
  return effectiveSecs > 0 ? (productionSecs / effectiveSecs) * 100 : null;
}
