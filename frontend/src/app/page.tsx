"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  fetchMachines,
  fetchRegisteredMachines,
  fetchMachineLiveData,
  fetchProductionCells,
  fetchThresholds,
  fetchShiftConfig,
  fetchShiftAssignments,
  fetchErrorCodeLookup,
  applyEfficiencyColor,
  applyScrapColor,
  applyMachineEfficiencyColor,
  applyMachineScrapColor,
  applyMachineSpeedColor,
  applySpeedHeaderColor,
  applyBuRunRateColor,
  DEFAULT_THRESHOLDS,
  DEFAULT_SHIFT_CONFIG,
} from "@/lib/supabase";
import type { MachineData, RegisteredMachine, MachineLiveData, ProductionCell, Thresholds, PackingFormat, ShiftConfig, PlcErrorCode } from "@/lib/supabase";
import { PACKING_FORMATS } from "@/lib/supabase";
import { getStatusColor, formatStatus } from "@/lib/utils";
import { fmtN, fmtPct } from "@/lib/fmt";

type SortColumn  = "Machine" | "Status" | "Speed" | "IdleTime" | "ErrorTime" | "Efficiency" | "Reject" | "LastSync";
type CellSortCol = "Machine" | "Status" | "Uptime" | "Scrap" | "TotalBU" | "BU" | "Speed" | "IdleTime" | "ErrorTime" | "Sync";

type DashboardMachine = MachineData & {
  cellId?: string | null;
  cellPosition?: number;
  packingFormat?: PackingFormat | null;
  efficiencyGood?: number | null;
  efficiencyMediocre?: number | null;
  scrapGood?: number | null;
  scrapMediocre?: number | null;
  buTarget?: number | null;
  buMediocre?: number | null;
  speedTarget?: number | null;
  /** User-defined display name (from machines.name). Falls back to machine_code. */
  displayName?: string;
  // statusSince, idleTimeCalc, errorTimeCalc, activeErrors inherited from MachineData
};

function formatStateDuration(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// BU run rate: projected BUs at end of shift.
// When the machine is running, the live speed is used.
// When idle or in error (speed = 0), the historical average production rate
// from PLC ProductionTime is used so planned breaks do not freeze the forecast.
function calcBuRunRate(
  m: DashboardMachine,
  shiftLengthMinutes: number,
  shiftStartedAt: number,
  plannedDowntimeMinutes: number = 0,
): { projected: number; target: number; rate: number } | null {
  const target = m.buTarget;
  if (!target || target <= 0) return null;
  const s = m.machineStatus?.Status?.toLowerCase();
  if (!s || s === "offline") return null;

  // Read production from the shift that is actually active, not always shift1.
  const activeShift = m.machineStatus?.ActShift ?? 1;
  const activeShiftData = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
  const currentBUs      = (activeShiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0) / 7200;

  // Use PLC-reported ProductionTime + IdleTime as elapsed shift time.
  // The wall clock (shiftStartedAt) resets every time the bridge restarts, which
  // makes elapsed ≈ 0 and inflates the projection to near a full shift.
  // The PLC counters are unaffected by bridge restarts and reflect actual machine time.
  // Fall back to wall clock only when no PLC shift data has arrived yet.
  const productionTimeMins = activeShiftData?.ProductionTime ?? 0;
  const idleTime           = activeShiftData?.IdleTime ?? 0;
  const plcElapsed         = productionTimeMins + idleTime;
  const elapsed            = plcElapsed > 0
    ? plcElapsed
    : (Date.now() - shiftStartedAt) / 60000;
  if (elapsed <= 0) return null;

  // Determine effective BU rate:
  //   - Machine running: use live speed for real-time accuracy.
  //   - Machine idle/error (speed = 0): fall back to the average BU/min rate
  //     over the elapsed shift time so breaks do not freeze the forecast.
  //     Using elapsed (not ProductionTime) because PLC production counters
  //     accumulate across shifts and cannot be trusted as a per-shift value.
  const currentSpeed = m.machineStatus?.Speed ?? 0;
  let buPerMin: number;
  if (currentSpeed > 0) {
    buPerMin = currentSpeed / 7200;
  } else if (elapsed > 0 && currentBUs > 0) {
    buPerMin = currentBUs / elapsed;
  } else {
    buPerMin = 0;
  }

  // Treat planned downtime as a budget that drains as idle time accumulates.
  // Only subtract downtime that has NOT yet been consumed — avoids double-counting
  // breaks that are already baked into elapsed time.
  // Error time is excluded: it is unplanned and should not consume the budget.
  const remainingDowntimeBudget = Math.max(0, plannedDowntimeMinutes - idleTime);
  const remaining  = Math.max(0, shiftLengthMinutes - elapsed - remainingDowntimeBudget);
  const projected  = currentBUs + buPerMin * remaining;
  return { projected, target, rate: projected / target };
}

// Recalculate uptime using the same downtime budget logic as calcBuRunRate.
// Planned idle time (up to the budget) is excluded from the denominator so
// scheduled breaks do not penalise the efficiency figure.
function calcCorrectedEfficiency(m: DashboardMachine, plannedDowntimeMinutes: number): number | null {
  const activeShift    = m.machineStatus?.ActShift ?? 1;
  const activeShiftData = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
  const productionTime  = activeShiftData?.ProductionTime ?? m.machineStatus?.ProductionTime ?? 0;
  const idleTime        = activeShiftData?.IdleTime       ?? m.machineStatus?.IdleTime       ?? 0;
  if (productionTime === 0 && idleTime === 0) return null;
  // Separate error time from idle time so the downtime budget only forgives
  // genuine idle (scheduled breaks). Error time always counts against uptime.
  const { errorMins } = calcIdleErrorTime(m, Date.now());
  const idleOnly      = Math.max(0, idleTime - errorMins);
  const unplannedIdle = Math.max(0, idleOnly - plannedDowntimeMinutes);
  const effectiveTime = productionTime + unplannedIdle + errorMins;
  return effectiveTime > 0 ? (productionTime / effectiveTime) * 100 : null;
}

// The bridge accumulates idle/error time on every MQTT tick (every 5 s) and
// saves the running totals directly to machines.idle_time_calc /
// error_time_calc.  They are reset only when the PLC reports a shift change.
// The frontend just reads the stored values — no need to add a current stint.
function calcIdleErrorTime(m: DashboardMachine, _now: number): { idleMins: number; errorMins: number } {
  return {
    idleMins:  m.idleTimeCalc  ?? 0,
    errorMins: m.errorTimeCalc ?? 0,
  };
}

function offlinePlaceholder(row: RegisteredMachine): MachineData {
  return {
    machine: row.machine_code,
    machineStatus: {
      Machine: row.machine_code,
      Status: "offline",
      Error: "",
      ActShift: 0,
      Speed: 0,
      Swabs: 0,
      Boxes: 0,
      Efficiency: 0,
      Reject: 0,
    },
    lastSyncStatus: row.last_sync_status || undefined,
    lastSyncShift: row.last_sync_shift || undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Table headers / sort helpers
// ─────────────────────────────────────────────────────────────
function SortHeader({
  col,
  label,
  sortColumn,
  sortAsc,
  onSort,
  className,
}: {
  col: SortColumn;
  label: string;
  sortColumn: SortColumn;
  sortAsc: boolean;
  onSort: (col: SortColumn) => void;
  className?: string;
}) {
  return (
    <th
      onClick={() => onSort(col)}
      className={`px-4 py-3 text-left text-sm font-medium cursor-pointer select-none transition-colors hover:text-cyan-400 hover:bg-cyan-900/10 ${
        sortColumn === col ? "text-white" : "text-gray-400"
      } ${className || ""}`}
    >
      {label} {sortColumn === col ? (sortAsc ? "▲" : "▼") : ""}
    </th>
  );
}

function sortMachineList(
  list: MachineData[],
  col: SortColumn,
  asc: boolean
): MachineData[] {
  return [...list].sort((a, b) => {
    let aVal: string | number = 0;
    let bVal: string | number = 0;
    switch (col) {
      case "Machine":    aVal = a.machine; bVal = b.machine; break;
      case "Status":     aVal = a.machineStatus?.Status || "zzz"; bVal = b.machineStatus?.Status || "zzz"; break;
      case "Speed":      aVal = a.machineStatus?.Speed || 0; bVal = b.machineStatus?.Speed || 0; break;
      case "IdleTime": {
        const aT = calcIdleErrorTime(a as DashboardMachine, Date.now());
        const bT = calcIdleErrorTime(b as DashboardMachine, Date.now());
        aVal = aT.idleMins; bVal = bT.idleMins; break;
      }
      case "ErrorTime": {
        const aT2 = calcIdleErrorTime(a as DashboardMachine, Date.now());
        const bT2 = calcIdleErrorTime(b as DashboardMachine, Date.now());
        aVal = aT2.errorMins; bVal = bT2.errorMins; break;
      }
      case "Efficiency": aVal = a.machineStatus?.Efficiency || 0; bVal = b.machineStatus?.Efficiency || 0; break;
      case "Reject":     aVal = a.machineStatus?.Reject || 0; bVal = b.machineStatus?.Reject || 0; break;
      case "LastSync":
        aVal = a.lastSyncStatus ? new Date(a.lastSyncStatus).getTime() : 0;
        bVal = b.lastSyncStatus ? new Date(b.lastSyncStatus).getTime() : 0;
        break;
    }
    if (typeof aVal === "string") return asc ? aVal.localeCompare(bVal as string, undefined, { numeric: true }) : (bVal as string).localeCompare(aVal, undefined, { numeric: true });
    return asc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });
}

// ─────────────────────────────────────────────────────────────
// Error badge with fixed-position tooltip (escapes overflow-hidden containers)
// ─────────────────────────────────────────────────────────────
function ErrorBadgeCell({ status, m, now, errorLookup }: { status: ReturnType<typeof getStatusColor>; m: DashboardMachine; now: number; errorLookup: Record<string, PlcErrorCode> }) {
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const hasErrors = m.machineStatus?.Status?.toLowerCase() === "error" && m.activeErrors && m.activeErrors.length > 0;

  return (
    <td className="px-4 py-3">
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${status.bg} ${status.text} ${hasErrors ? "cursor-default" : ""}`}
        onMouseEnter={hasErrors ? (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setTooltipPos({ x: rect.left, y: rect.bottom + 4 });
        } : undefined}
        onMouseLeave={hasErrors ? () => setTooltipPos(null) : undefined}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`}></span>
        {formatStatus(m.machineStatus?.Status)}
        {m.statusSince && (m.machineStatus?.Status?.toLowerCase() !== "run") && (
          <span className="opacity-70 font-normal">{formatStateDuration(m.statusSince, now)}</span>
        )}
      </span>
      {tooltipPos && hasErrors && (
        <div
          className="fixed z-[9999] bg-slate-800 border border-slate-600 rounded-lg p-3 shadow-xl min-w-[280px] max-w-[400px]"
          style={{ left: tooltipPos.x, top: tooltipPos.y }}
          onMouseEnter={() => {}}
          onMouseLeave={() => setTooltipPos(null)}
        >
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-700">
                <th className="text-left pb-1 pr-3 font-medium">Code</th>
                <th className="text-left pb-1 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {m.activeErrors!.map((code: string | number) => {
                const codeStr = String(code);
                const info = errorLookup[codeStr];
                return (
                  <tr key={codeStr} className="border-b border-gray-700/50 last:border-0">
                    <td className="py-1 pr-3 font-mono text-red-300 whitespace-nowrap">{codeStr}</td>
                    <td className="py-1 text-gray-300">{info?.description ?? "Unknown"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </td>
  );
}

// ─────────────────────────────────────────────────────────────
// Machine row
// ─────────────────────────────────────────────────────────────
function MachineRow({ m, shiftLengthMinutes, plannedDowntimeMinutes, shiftStartedAt, onClick, now, errorLookup }: { m: DashboardMachine; shiftLengthMinutes: number; plannedDowntimeMinutes: number; shiftStartedAt: number; onClick: () => void; now: number; errorLookup: Record<string, PlcErrorCode> }) {
  const status     = getStatusColor(m.machineStatus?.Status);
  const corrEff    = calcCorrectedEfficiency(m, plannedDowntimeMinutes);
  const effColor   = applyMachineEfficiencyColor(corrEff, m.efficiencyGood ?? null, m.efficiencyMediocre ?? null);
  const scpColor   = applyMachineScrapColor(m.machineStatus?.Reject ?? null, m.scrapGood ?? null, m.scrapMediocre ?? null);
  const spdColor   = applyMachineSpeedColor(m.machineStatus?.Speed ?? null, m.speedTarget ?? null);
  const buRate     = calcBuRunRate(m, shiftLengthMinutes, shiftStartedAt, plannedDowntimeMinutes);
  const buColor    = applyBuRunRateColor(buRate?.projected ?? null, buRate?.target ?? null, m.buMediocre ?? null);
  const isOffline  = m.machineStatus?.Status?.toLowerCase() === "offline";
  const hasProduction = (m.machineStatus?.Swabs ?? 0) > 0;
  const activeShiftNum  = m.machineStatus?.ActShift ?? 1;
  const activeShiftData = activeShiftNum === 2 ? m.shift2 : activeShiftNum === 3 ? m.shift3 : m.shift1;
  const currentBUs  = (activeShiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0) / 7200;
  const { idleMins, errorMins } = calcIdleErrorTime(m, now);

  // In rows: suppress green — only yellow and red signal problems; good = plain white
  const toRowColor = (c: string) => c === "text-green-400" ? "text-white" : c;

  return (
    <tr onClick={onClick} className="cursor-pointer hover:bg-white/5 transition-colors">
      <td className="px-4 py-3">
        <div className="font-bold text-cyan-400 leading-tight">{m.displayName ?? m.machine}</div>
        {m.displayName && m.displayName !== m.machine && (
          <div className="text-xs text-gray-500 leading-tight">{m.machine}</div>
        )}
      </td>
      <ErrorBadgeCell status={status} m={m} now={now} errorLookup={errorLookup} />
      <td className={`px-4 py-3 font-medium ${toRowColor(effColor.text)}`}>
        {!isOffline && hasProduction && corrEff !== null ? fmtPct(corrEff, 1) : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(scpColor.text)}`}>
        {!isOffline && hasProduction ? fmtPct(m.machineStatus?.Reject ?? 0, 1) : ""}
      </td>
      <td className="px-4 py-3 font-medium text-white">
        {!isOffline && currentBUs > 0
          ? <>{Math.round(currentBUs).toLocaleString()} <span className="text-gray-500 text-xs">BUs</span></>
          : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(buColor.text)}`}>
        {buRate !== null ? (
          <>{Math.round(buRate.projected).toLocaleString()} <span className="text-gray-500 text-xs">BUs</span>
          {" "}<span className="text-xs opacity-70">{fmtN(Math.round((buRate.projected / buRate.target) * 100))}%</span></>
        ) : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${spdColor.text}`}>
        {!isOffline ? (
          <>{(m.machineStatus?.Speed ?? 0).toLocaleString()} <span className="text-gray-500 text-xs">pcs/min</span></>
        ) : null}
      </td>
      <td className="px-4 py-3 text-white">
        {!isOffline ? (Math.round(idleMins) > 0 ? fmtDuration(idleMins) : <span className="text-gray-600">&ndash;</span>) : ""}
      </td>
      <td className="px-4 py-3 text-white">
        {!isOffline ? (Math.round(errorMins) > 0 ? fmtDuration(errorMins) : <span className="text-gray-600">&ndash;</span>) : ""}
      </td>
      <td className="px-4 py-3 text-gray-400">
        {m.lastSyncStatus
          ? new Date(m.lastSyncStatus).toLocaleTimeString("de-DE")
          : <span className="text-gray-600">---</span>}
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────
// Cell sort helper
// ─────────────────────────────────────────────────────────────
function sortCellMachines(
  ms: DashboardMachine[],
  col: CellSortCol,
  asc: boolean,
  shiftLengthMinutes: number,
  shiftStartedAt: number,
  plannedDowntimeMinutes: number = 0,
): DashboardMachine[] {
  return [...ms].sort((a, b) => {
    let aVal: string | number = 0;
    let bVal: string | number = 0;
    switch (col) {
      case "Machine": aVal = a.machine; bVal = b.machine; break;
      case "Status":  aVal = a.machineStatus?.Status || "zzz"; bVal = b.machineStatus?.Status || "zzz"; break;
      case "Uptime":    aVal = a.machineStatus?.Efficiency || 0; bVal = b.machineStatus?.Efficiency || 0; break;
      case "Scrap":     aVal = a.machineStatus?.Reject     || 0; bVal = b.machineStatus?.Reject     || 0; break;
      case "TotalBU": {
        const aShift = (a.machineStatus?.ActShift ?? 1); const aSD = aShift === 2 ? a.shift2 : aShift === 3 ? a.shift3 : a.shift1;
        const bShift = (b.machineStatus?.ActShift ?? 1); const bSD = bShift === 2 ? b.shift2 : bShift === 3 ? b.shift3 : b.shift1;
        aVal = (aSD?.ProducedSwabs ?? a.machineStatus?.Swabs ?? 0) / 7200;
        bVal = (bSD?.ProducedSwabs ?? b.machineStatus?.Swabs ?? 0) / 7200;
        break;
      }
      case "Speed":     aVal = a.machineStatus?.Speed      || 0; bVal = b.machineStatus?.Speed      || 0; break;
      case "IdleTime": {
        const aTimes = calcIdleErrorTime(a, Date.now());
        const bTimes = calcIdleErrorTime(b, Date.now());
        aVal = aTimes.idleMins; bVal = bTimes.idleMins; break;
      }
      case "ErrorTime": {
        const aTimes2 = calcIdleErrorTime(a, Date.now());
        const bTimes2 = calcIdleErrorTime(b, Date.now());
        aVal = aTimes2.errorMins; bVal = bTimes2.errorMins; break;
      }
      case "Sync":
        aVal = a.lastSyncStatus ? new Date(a.lastSyncStatus).getTime() : 0;
        bVal = b.lastSyncStatus ? new Date(b.lastSyncStatus).getTime() : 0;
        break;
      case "BU": {
        const ar = calcBuRunRate(a, shiftLengthMinutes, shiftStartedAt, plannedDowntimeMinutes);
        const br = calcBuRunRate(b, shiftLengthMinutes, shiftStartedAt, plannedDowntimeMinutes);
        aVal = ar?.rate ?? 0; bVal = br?.rate ?? 0; break;
      }
    }
    if (typeof aVal === "string")
      return asc ? aVal.localeCompare(bVal as string, undefined, { numeric: true }) : (bVal as string).localeCompare(aVal, undefined, { numeric: true });
    return asc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });
}

// ─────────────────────────────────────────────────────────────
// Cell group section
// ─────────────────────────────────────────────────────────────
function CellSection({
  title,
  icon,
  color,
  machines,
  onMachineClick,
  thresholds,
  shiftLengthMinutes,
  shiftStartedAt,
  now,
  defaultOpen = false,
  errorLookup,
}: {
  title: string;
  icon: string;
  color: string;
  machines: DashboardMachine[];
  onMachineClick: (code: string, packingFormat?: PackingFormat | null) => void;
  thresholds: Thresholds;
  shiftLengthMinutes: number;
  shiftStartedAt: number;
  now: number;
  defaultOpen?: boolean;
  errorLookup: Record<string, PlcErrorCode>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [sortCol, setSortCol]   = useState<CellSortCol>("Machine");
  const [sortAsc, setSortAsc]   = useState(true);
  const plannedDowntimeMins = thresholds.bu.plannedDowntimeMinutes ?? 0;

  function handleSort(col: CellSortCol) {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  }

  const sortedMachines = sortCellMachines(machines, sortCol, sortAsc, shiftLengthMinutes, shiftStartedAt, plannedDowntimeMins);

  // Compute cell-level stats
  let running = 0, nonOfflineCount = 0, effSum = 0, effCount = 0;
  let cellTotalBUs = 0, cellTotalIdleTime = 0, cellTotalErrorTime = 0;
  let totalDiscarded = 0, totalProduced = 0;
  let speedSum = 0, speedCount = 0, speedTargetSum = 0, speedTargetCount = 0;
  let cellProjected = 0, cellTarget = 0, cellMediocreTarget = 0;
  let effGoodSum = 0, effGoodCount = 0, effMedSum = 0, effMedCount = 0;
  let scrapGoodSum = 0, scrapGoodCount = 0, scrapMedSum = 0, scrapMedCount = 0;
  for (const m of machines) {
    const s = m.machineStatus?.Status?.toLowerCase();
    const isRunning = s === "run" || s === "running";
    const isOffline = s === "offline" || !s;
    if (isRunning) running++;
    // Uptime: use corrected efficiency (planned idle excluded from denominator)
    const corrEff = calcCorrectedEfficiency(m, plannedDowntimeMins);
    if (corrEff !== null) { effSum += corrEff; effCount++; }
    // Scrap: sum raw discarded/produced swabs across all non-offline machines
    const produced = m.machineStatus?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
    const discarded = m.machineStatus?.DisgardedSwabs ?? m.machineStatus?.DiscardedSwabs ?? 0;
    if (!isOffline && produced > 0) { totalProduced += produced; totalDiscarded += discarded; }
    const mActShift = m.machineStatus?.ActShift ?? 1;
    const mShiftData = mActShift === 2 ? m.shift2 : mActShift === 3 ? m.shift3 : m.shift1;
    if (!isOffline) {
      nonOfflineCount++;
      cellTotalBUs += (mShiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0) / 7200;
      const mTimes = calcIdleErrorTime(m, Date.now());
      cellTotalIdleTime  += mTimes.idleMins;
      cellTotalErrorTime += mTimes.errorMins;
    }
    // Speed: running machines only
    if (isRunning && m.machineStatus?.Speed) { speedSum += m.machineStatus.Speed; speedCount++; }
    if (m.speedTarget)               { speedTargetSum += m.speedTarget; speedTargetCount++; }
    // BU Run Rate: running machines get full calc; non-running still add their target (0 projected)
    const br = calcBuRunRate(m, shiftLengthMinutes, shiftStartedAt, plannedDowntimeMins);
    if (br) { cellProjected += br.projected; cellTarget += br.target; }
    else if (m.buTarget && m.buTarget > 0) { cellTarget += m.buTarget; }
    if (m.buMediocre && m.buMediocre > 0) { cellMediocreTarget += m.buMediocre; }
    if (m.efficiencyGood)     { effGoodSum   += m.efficiencyGood;     effGoodCount++; }
    if (m.efficiencyMediocre) { effMedSum    += m.efficiencyMediocre; effMedCount++;  }
    if (m.scrapGood)          { scrapGoodSum += m.scrapGood;          scrapGoodCount++; }
    if (m.scrapMediocre)      { scrapMedSum  += m.scrapMediocre;      scrapMedCount++;  }
  }
  const avgEff    = effCount > 0 ? effSum / effCount : null;
  // Weighted scrap: sum(discarded) / sum(produced) — not an average of per-machine rates
  const avgScrap  = totalProduced > 0 ? (totalDiscarded / totalProduced) * 100 : null;
  const avgSpeed  = speedCount > 0 ? speedSum / speedCount : null;
  const avgSpeedTarget = speedTargetCount > 0 ? speedTargetSum / speedTargetCount : null;
  const cellRate  = cellTarget > 0 ? cellProjected / cellTarget : null;
  // Use averaged per-machine targets for coloring (falls back to gray when no targets set)
  const avgEffGood   = effGoodCount   > 0 ? effGoodSum   / effGoodCount   : null;
  const avgEffMed    = effMedCount    > 0 ? effMedSum    / effMedCount    : null;
  const avgScrapGood = scrapGoodCount > 0 ? scrapGoodSum / scrapGoodCount : null;
  const avgScrapMed  = scrapMedCount  > 0 ? scrapMedSum  / scrapMedCount  : null;
  const ec   = applyMachineEfficiencyColor(avgEff,   avgEffGood,   avgEffMed);
  const sc   = applyMachineScrapColor     (avgScrap, avgScrapGood, avgScrapMed);
  const buCc = applyBuRunRateColor(cellProjected, cellTarget, cellMediocreTarget > 0 ? cellMediocreTarget : null);
  const spCc = applySpeedHeaderColor(avgSpeed, avgSpeedTarget);

  // Derive output label from machines' packing formats
  const formatSet = new Set(machines.map(m => m.packingFormat).filter((f): f is PackingFormat => !!f));
  const outputLabel = formatSet.size === 1
    ? PACKING_FORMATS[formatSet.values().next().value as PackingFormat]
    : formatSet.size === 0 ? "Blisters"
    : "Output";

  // Column definitions: label, sort key, percentage width
  // Percentages must sum to 100.
  type ColDef = { label: string; col: CellSortCol; pct: number };
  const colDefs: ColDef[] = [
    { label: "Machine",              col: "Machine",   pct: 10 },
    { label: "Status",               col: "Status",    pct: 12 },
    { label: "Uptime",               col: "Uptime",    pct: 8 },
    { label: "Scrap",                col: "Scrap",     pct: 8 },
    { label: "Total BUs",            col: "TotalBU",   pct: 10 },
    { label: "Expected Output",      col: "BU",        pct: 15 },
    { label: "Speed",                col: "Speed",     pct: 12 },
    { label: "Idle Time",            col: "IdleTime",  pct: 9 },
    { label: "Error Time",           col: "ErrorTime", pct: 9 },
    { label: "Last Sync",            col: "Sync",      pct: 7 },
  ];

  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          {/* ── colgroup pins every column to a fixed percentage width ── */}
          <colgroup>
            {colDefs.map((cd) => (
              <col key={cd.col} style={{ width: `${cd.pct}%` }} />
            ))}
          </colgroup>

          <thead>
            {/* ── Cell summary row — each KPI sits above its column ── */}
            <tr
              onClick={() => setOpen(!open)}
              className="bg-gray-800 border-b border-gray-700 cursor-pointer hover:bg-gray-750 transition-colors"
            >
              {/* Machine col → cell name */}
              <td className="px-4 py-3 whitespace-nowrap">
                <div className={!open ? "flex flex-col gap-0.5" : "flex items-center gap-2"}>
                  {!open && <span className="text-[10px] invisible">·</span>}
                  <div className="flex items-center gap-2">
                    <i className={`bi ${icon} ${color}`}></i>
                    <span className="text-white font-semibold text-sm">{title}</span>
                  </div>
                </div>
              </td>
              {/* Status col → running count, traffic-light colored */}
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex flex-col gap-0.5">
                  {!open && <span className="text-[10px] text-gray-500">{colDefs[1].label}</span>}
                  <span className={`text-xs font-semibold ${
                    machines.length === 0 ? "text-gray-500"
                    : running === machines.length ? "text-green-400"
                    : running > 0            ? "text-yellow-400"
                    :                          "text-red-400"
                  }`}>
                    {running}/{machines.length} running
                  </span>
                </div>
              </td>
              {/* Uptime col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {avgEff !== null && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[2].label}</span>}
                    <span className={`text-sm font-semibold ${ec.text}`}>{fmtPct(avgEff, 1)}</span>
                  </div>
                )}
              </td>
              {/* Scrap Rate col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {avgScrap !== null && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[3].label}</span>}
                    <span className={`text-sm font-semibold ${sc.text}`}>{fmtPct(avgScrap, 1)}</span>
                  </div>
                )}
              </td>
              {/* Total BUs col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {cellTotalBUs > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[4].label}</span>}
                    <span className="text-sm font-semibold text-white">
                      {Math.round(cellTotalBUs).toLocaleString()}{" "}
                      <span className="text-xs font-normal opacity-50">BUs</span>
                    </span>
                  </div>
                )}
              </td>
              {/* Expected Output col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {cellTarget > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[5].label}</span>}
                    <span className={`text-sm font-semibold ${buCc.text}`}>
                      {Math.round(cellProjected).toLocaleString()}{" "}
                      <span className="text-xs font-normal opacity-60">BUs</span>
                      {" "}<span className="text-xs font-normal opacity-70">{fmtN(Math.round((cellProjected / cellTarget) * 100))}%</span>
                    </span>
                  </div>
                ) : null}
              </td>
              {/* Speed col → avg speed of running machines, 0 when idle, hidden only when all offline */}
              <td className="px-4 py-3 whitespace-nowrap">
                {nonOfflineCount > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[6].label}</span>}
                    <span className={`text-sm font-semibold ${avgSpeed !== null ? spCc.text : "text-gray-400"}`}>
                      {Math.round(avgSpeed ?? 0).toLocaleString()}{" "}
                      <span className="text-xs font-normal opacity-60">pcs/min</span>
                    </span>
                  </div>
                )}
              </td>
              {/* Idle Time col */}
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex flex-col gap-0.5">
                  {!open && <span className="text-[10px] text-gray-500">{colDefs[7].label}</span>}
                  <span className={`text-sm font-semibold ${Math.round(cellTotalIdleTime) > 0 ? "text-white" : "text-gray-600"}`}>
                    {Math.round(cellTotalIdleTime) > 0 ? fmtDuration(cellTotalIdleTime) : "\u2013"}
                  </span>
                </div>
              </td>
              {/* Error Time col */}
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex flex-col gap-0.5">
                  {!open && <span className="text-[10px] text-gray-500">{colDefs[8].label}</span>}
                  <span className={`text-sm font-semibold ${Math.round(cellTotalErrorTime) > 0 ? "text-white" : "text-gray-600"}`}>
                    {Math.round(cellTotalErrorTime) > 0 ? fmtDuration(cellTotalErrorTime) : "\u2013"}
                  </span>
                </div>
              </td>
              {/* Last Sync col → collapse chevron */}
              <td className="px-4 py-3 text-right">
                <i className={`bi bi-chevron-${open ? "up" : "down"} text-gray-400 text-xs`}></i>
              </td>
            </tr>

            {/* ── Sortable column headers ── */}
            {open && (
              <tr className="bg-gray-800/70 border-b border-gray-700/50">
                {colDefs.map((cd) => (
                  <th
                    key={cd.col}
                    onClick={(e) => { e.stopPropagation(); handleSort(cd.col); }}
                    className={`px-4 py-2 text-left text-xs font-medium cursor-pointer select-none transition-colors
                      hover:text-cyan-400 hover:bg-cyan-900/10
                      ${sortCol === cd.col ? "text-white" : "text-gray-500"}`}
                  >
                    {cd.label}{sortCol === cd.col ? (sortAsc ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            )}
          </thead>

          {open && (
            <tbody className="divide-y divide-gray-700/50">
              {sortedMachines.map((m) => (
                <MachineRow key={m.machine} m={m} shiftLengthMinutes={shiftLengthMinutes} plannedDowntimeMinutes={plannedDowntimeMins} shiftStartedAt={shiftStartedAt} now={now} errorLookup={errorLookup} onClick={() => onMachineClick(m.machine, m.packingFormat)} />
              ))}
              {machines.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-gray-600 text-xs">
                    No machines in this cell
                  </td>
                </tr>
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Summary tile
// ─────────────────────────────────────────────────────────────
function SummaryTile({
  icon, label, value, sub, colorClass, borderClass,
}: {
  icon: string; label: string; value: string;
  sub?: string; colorClass: string; borderClass: string;
}) {
  return (
    <div className={`bg-gray-800/50 border-l-4 ${borderClass} rounded-lg px-5 py-4 flex flex-col gap-1`}>
      <div className="flex items-center gap-2 text-gray-400 text-xs">
        <i className={`bi ${icon}`}></i>
        {label}
      </div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function ParkSummaryTiles({
  machines, thresholds, shiftStartedAt,
}: {
  machines: Record<string, DashboardMachine>;
  thresholds: Thresholds;
  shiftStartedAt: number;
}) {
  const all = Object.values(machines);
  const total = all.length;
  const rawShiftMins = thresholds.bu.shiftLengthMinutes;
  const plannedDowntimeMins = thresholds.bu.plannedDowntimeMinutes ?? 0;

  let running = 0, effSum = 0, effCount = 0;
  let totalDiscarded = 0, totalProduced = 0;
  let scrapGoodSum = 0, scrapGoodCount = 0, scrapMedSum = 0, scrapMedCount = 0;
  let floorProjected = 0, floorTarget = 0, floorMediocreTarget = 0;
  for (const m of all) {
    const s = m.machineStatus?.Status?.toLowerCase();
    const isRunning = s === "run" || s === "running";
    if (isRunning) running++;
    const corrEff = calcCorrectedEfficiency(m, plannedDowntimeMins);
    if (corrEff !== null) { effSum += corrEff; effCount++; }
    // Scrap: sum raw discarded/produced swabs across all non-offline machines
    const isOffline = s === "offline" || !s;
    const produced  = m.machineStatus?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
    const discarded = m.machineStatus?.DisgardedSwabs ?? m.machineStatus?.DiscardedSwabs ?? 0;
    if (!isOffline && produced > 0) { totalProduced += produced; totalDiscarded += discarded; }
    // Accumulate per-machine scrap targets for color thresholds
    if (m.scrapGood)     { scrapGoodSum += m.scrapGood;     scrapGoodCount++; }
    if (m.scrapMediocre) { scrapMedSum  += m.scrapMediocre; scrapMedCount++;  }
    // BU: non-running machines still contribute their target
    const br = calcBuRunRate(m, rawShiftMins, shiftStartedAt, plannedDowntimeMins);
    if (br) { floorProjected += br.projected; floorTarget += br.target; }
    else if (m.buTarget && m.buTarget > 0) { floorTarget += m.buTarget; }
    if (m.buMediocre && m.buMediocre > 0) { floorMediocreTarget += m.buMediocre; }
  }

  const avgEff        = effCount   > 0 ? effSum / effCount : null;
  // Weighted scrap: sum(discarded) / sum(produced) — not an average of per-machine rates
  const avgScrap      = totalProduced > 0 ? (totalDiscarded / totalProduced) * 100 : null;
  const avgScrapGood  = scrapGoodCount  > 0 ? scrapGoodSum  / scrapGoodCount  : null;
  const avgScrapMed   = scrapMedCount   > 0 ? scrapMedSum   / scrapMedCount   : null;
  const floorRate     = floorTarget     > 0 ? floorProjected / floorTarget    : null;
  const ec            = applyEfficiencyColor(avgEff,   thresholds);
  const sc            = applyMachineScrapColor(avgScrap, avgScrapGood, avgScrapMed);
  const buc           = applyBuRunRateColor(floorProjected, floorTarget, floorMediocreTarget > 0 ? floorMediocreTarget : null);

  const onlineColor  = running === 0 ? "text-red-400" : running < total ? "text-yellow-400" : "text-green-400";
  const onlineBorder = running === 0 ? "border-red-600" : running < total ? "border-yellow-600" : "border-green-600";

  if (total === 0) return null;

  // Whether any machine has a BU target configured (regardless of online status)
  const hasAnyBuTarget = all.some(m => m.buTarget && m.buTarget > 0);

  const buValue = floorTarget > 0
    ? `${fmtN(Math.round(floorProjected))} / ${fmtN(Math.round(floorTarget))}`
    : "—";
  const buSub = floorRate !== null
    ? `${fmtN(Math.round(floorRate * 100))}% of target`
    : hasAnyBuTarget ? "No live data" : "No targets set";

  return (
    <div className="grid grid-cols-4 gap-3 mb-6">
      <SummaryTile
        icon="bi-activity"
        label="Machines Online"
        value={`${running} / ${total}`}
        sub="currently running"
        colorClass={onlineColor}
        borderClass={onlineBorder}
      />
      <SummaryTile
        icon="bi-speedometer2"
        label="Avg Uptime"
        value={fmtPct(avgEff, 1)}
        sub={avgEff !== null
          ? avgEff >= thresholds.efficiency.good ? "Good"
          : avgEff >= thresholds.efficiency.mediocre ? "Mediocre" : "Below target"
          : "No live data"}
        colorClass={ec.text}
        borderClass={ec.border}
      />
      <SummaryTile
        icon="bi-exclamation-triangle"
        label="Avg Scrap Rate"
        value={fmtPct(avgScrap, 1)}
        sub={avgScrap !== null
          ? (avgScrapGood === null || avgScrap <= avgScrapGood) ? "Good"
          : (avgScrapMed === null || avgScrap <= avgScrapMed) ? "Mediocre" : "Above target"
          : "No live data"}
        colorClass={sc.text}
        borderClass={sc.border}
      />
      <SummaryTile
        icon="bi-box-seam"
        label="Expected Output"
        value={buValue}
        sub={buSub}
        colorClass={buc.text}
        borderClass={buc.border}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Shift progress bar
// ─────────────────────────────────────────────────────────────
function fmtDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function ShiftAndBUProgress({
  shiftStartedAt,
  totalShiftMins,
  shiftName,
  currentTime,
  machines,
  thresholds,
}: {
  shiftStartedAt: number;
  totalShiftMins: number;
  shiftName: string;
  currentTime: Date;
  machines: Record<string, DashboardMachine>;
  thresholds: Thresholds;
}) {
  if (!shiftName || totalShiftMins <= 0) return null;

  // ── Shift elapsed ──
  const elapsedMins   = Math.max(0, (currentTime.getTime() - shiftStartedAt) / 60000);
  const shiftProgress = Math.min(1, elapsedMins / totalShiftMins);
  const shiftPct      = Math.round(shiftProgress * 100);

  // ── BU output ──
  const all = Object.values(machines);
  const rawShiftMins = thresholds.bu.shiftLengthMinutes;
  const plannedDowntimeMins = thresholds.bu.plannedDowntimeMinutes ?? 0;
  let totalCurrentBU = 0;
  let totalTargetBU  = 0;
  let floorProjected = 0;
  let floorMediocreTarget = 0;
  for (const m of all) {
    if (m.buTarget && m.buTarget > 0) totalTargetBU += m.buTarget;
    if (m.buMediocre && m.buMediocre > 0) floorMediocreTarget += m.buMediocre;
    const activeShift = m.machineStatus?.ActShift ?? 1;
    const shiftData   = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
    const swabs       = shiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
    totalCurrentBU += swabs / 7200;
    const br = calcBuRunRate(m, rawShiftMins, shiftStartedAt, plannedDowntimeMins);
    if (br) floorProjected += br.projected;
  }
  const hasBU      = totalTargetBU > 0;
  const buProgress = hasBU ? Math.min(1, totalCurrentBU / totalTargetBU) : 0;
  const buPct      = hasBU ? Math.round((totalCurrentBU / totalTargetBU) * 100) : 0;

  // BU bar color derived from expected output thresholds (same as KPI tile)
  const buc = applyBuRunRateColor(floorProjected, totalTargetBU, floorMediocreTarget > 0 ? floorMediocreTarget : null);
  const buBarColor =
    buc.text === "text-green-400"  ? "bg-green-500"
    : buc.text === "text-yellow-400" ? "bg-yellow-500"
    : buc.text === "text-red-400"    ? "bg-red-500"
    : "bg-gray-500";

  return (
    <div className="mb-6 bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-3 space-y-2">
      {/* Shift name */}
      <div className="text-xs font-semibold text-white tracking-wide uppercase">{shiftName}</div>

      {/* Elapsed time row */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <span className="text-xs text-gray-400 w-24 shrink-0">Elapsed time</span>
          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000 bg-cyan-500"
              style={{ width: `${shiftPct}%` }}
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 pl-[6.75rem]">
          <span className="text-white font-medium">{fmtDuration(elapsedMins)}</span>
          <span className="text-white"> / </span>
          <span className="text-white font-medium">{fmtDuration(totalShiftMins)}</span>
          {" elapsed"}
          <span className="mx-1.5 text-gray-600">|</span>
          <span className="text-white font-medium">{fmtN(shiftPct)}%</span>
          {" of shift"}
        </p>
      </div>

      {/* BU output row */}
      {hasBU && (
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xs text-gray-400 w-24 shrink-0">BU output</span>
            <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${buBarColor}`}
                style={{ width: `${Math.min(100, buPct)}%` }}
              />
            </div>
          </div>
          <p className="text-xs text-gray-500 pl-[6.75rem]">
            <span className="text-white font-medium">{Math.round(totalCurrentBU).toLocaleString()}</span>
            <span className="text-white"> / </span>
            <span className="text-white font-medium">{Math.round(totalTargetBU).toLocaleString()} BUs</span>
            {" produced"}
            <span className="mx-1.5 text-gray-600">|</span>
            <span className="text-white font-medium">{fmtN(buPct)}%</span>
            {" of target"}
          </p>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [machines, setMachines] = useState<Record<string, DashboardMachine>>({});
  const [cells, setCells] = useState<ProductionCell[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [currentShift, setCurrentShift] = useState<number>(0);
  const [sortColumn, setSortColumn] = useState<SortColumn>("Machine");
  const [sortAsc, setSortAsc] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [dbError, setDbError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [shiftConfig, setShiftConfig] = useState<ShiftConfig>(DEFAULT_SHIFT_CONFIG);
  const [todayTeams, setTodayTeams] = useState<(string | null)[]>([]);
  const [errorLookup, setErrorLookup] = useState<Record<string, PlcErrorCode>>({});
  const router = useRouter();
  const bridgeFailCount = useRef(0);
  const machinesRef = useRef<Record<string, DashboardMachine>>({});
  // Caches config columns (rarely change) so the polling loop only fetches live columns.
  type MachineConfig = Pick<DashboardMachine,
    "cellId" | "cellPosition" | "packingFormat" |
    "efficiencyGood" | "efficiencyMediocre" |
    "scrapGood" | "scrapMediocre" |
    "buTarget" | "buMediocre" | "speedTarget" | "displayName"
  >;
  const machineConfigRef  = useRef<Record<string, MachineConfig>>({});
  const displayNameMapRef = useRef<Record<string, string>>({});

  // Fetches config columns (name, thresholds, cell assignment) — rarely change.
  // Called once on mount, then refreshed every 5 minutes.
  const loadConfig = useCallback(async () => {
    try {
      const [registered, fetchedCells] = await Promise.all([
        fetchRegisteredMachines(),
        fetchProductionCells(),
      ]);
      setCells(fetchedCells);
      setDbError(null);

      const newConfig: Record<string, MachineConfig> = {};
      const newNames:  Record<string, string>         = {};
      for (const row of registered) {
        newConfig[row.machine_code] = {
          cellId:             row.cell_id,
          cellPosition:       row.cell_position ?? 0,
          packingFormat:      row.packing_format ?? null,
          efficiencyGood:     row.efficiency_good ?? null,
          efficiencyMediocre: row.efficiency_mediocre ?? null,
          scrapGood:          row.scrap_good ?? null,
          scrapMediocre:      row.scrap_mediocre ?? null,
          buTarget:           row.bu_target ?? null,
          buMediocre:         row.bu_mediocre ?? null,
          speedTarget:        row.speed_target ?? null,
          displayName:        row.name || row.machine_code,
        };
        newNames[row.machine_code] = row.name || row.machine_code;
      }
      machineConfigRef.current  = newConfig;
      displayNameMapRef.current = newNames;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to fetch machine config:", msg);
      setDbError(msg);
    }
  }, []);

  // Fetches only the live columns that change every few seconds (12 cols vs 22).
  // Merges with cached config so DashboardMachine objects stay complete.
  const loadData = useCallback(async () => {
    let liveRows: MachineLiveData[] = [];

    try {
      liveRows = await fetchMachineLiveData();
      setDbError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to fetch live machine data:", msg);
      setDbError(msg);
    } finally {
      setInitialLoading(false);
    }

    const config       = machineConfigRef.current;
    const displayNames = displayNameMapRef.current;

    const merged: Record<string, DashboardMachine> = {};
    for (const row of liveRows) {
      const cfg = config[row.machine_code] ?? {};
      merged[row.machine_code] = {
        ...offlinePlaceholder(row as unknown as RegisteredMachine),
        ...cfg,
        displayName: displayNames[row.machine_code] ?? row.machine_code,
      };
    }

    try {
      const state = await fetchMachines();
      bridgeFailCount.current = 0;
      setMqttConnected(state.mqttConnected);
      setCurrentShift(state.currentShiftNumber || 0);
      for (const [code, live] of Object.entries(state.machines)) {
        // Read statusSince from bridge (ISO string → unix ms).
        // The bridge tracks status transitions server-side and persists
        // to Supabase, so the timer survives page reloads and bridge restarts.
        const isoSince = (live as any).statusSince as string | undefined;
        const statusSince = isoSince ? new Date(isoSince).getTime() : Date.now();
        const idleTimeCalc  = (live as any).idleTimeCalc  as number | undefined;
        const errorTimeCalc = (live as any).errorTimeCalc as number | undefined;
        const activeErrors  = (live as any).activeErrors  as number[] | undefined;

        merged[code] = {
          ...live,
          cellId:            merged[code]?.cellId ?? null,
          cellPosition:      merged[code]?.cellPosition ?? 0,
          packingFormat:     merged[code]?.packingFormat ?? null,
          efficiencyGood:    merged[code]?.efficiencyGood ?? null,
          efficiencyMediocre: merged[code]?.efficiencyMediocre ?? null,
          scrapGood:         merged[code]?.scrapGood ?? null,
          scrapMediocre:     merged[code]?.scrapMediocre ?? null,
          buTarget:          merged[code]?.buTarget ?? null,
          buMediocre:        merged[code]?.buMediocre ?? null,
          speedTarget:       merged[code]?.speedTarget ?? null,
          displayName:       displayNames[code] ?? code,
          statusSince,
          idleTimeCalc:  idleTimeCalc  ?? 0,
          errorTimeCalc: errorTimeCalc ?? 0,
          activeErrors:  activeErrors  ?? [],
        };
      }
      machinesRef.current = merged;
      setMachines(merged);
    } catch {
      bridgeFailCount.current += 1;
      // Only show offline after 3 consecutive failed fetches (~6 s).
      // This prevents brief network hiccups from flashing the dashboard.
      if (bridgeFailCount.current >= 3) {
        setMqttConnected(false);
        machinesRef.current = merged;
        setMachines(merged);
      }
      // Otherwise keep the previous machines state (do nothing)
    }
  }, []);

  useEffect(() => {
    // Load config first, then start live polling once config is cached.
    loadConfig().then(() => loadData());
    fetchThresholds().then(setThresholds).catch(() => {/* use defaults */});
    fetchShiftConfig().then(setShiftConfig).catch(() => {/* use defaults */});
    fetchErrorCodeLookup().then(setErrorLookup).catch(() => {/* empty lookup */});
    const today = new Date().toISOString().slice(0, 10);
    fetchShiftAssignments(today, today)
      .then(rows => { if (rows[0]) setTodayTeams(rows[0].slot_teams); })
      .catch(() => {/* no assignment for today */});
    // Live data: poll every 5 s (bridge publishes every 5 s, so faster is wasteful).
    const dataInterval   = setInterval(loadData,   5_000);
    // Config: refresh every 5 minutes to pick up setting changes.
    const configInterval = setInterval(loadConfig, 5 * 60_000);
    const clockInterval  = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => {
      clearInterval(dataInterval);
      clearInterval(configInterval);
      clearInterval(clockInterval);
    };
  }, [loadData, loadConfig]);

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) setSortAsc(!sortAsc);
    else { setSortColumn(col); setSortAsc(true); }
  };

  const machineCount = Object.keys(machines).length;
  const hasData = machineCount > 0;

  type WithCell = { cellId?: string | null; cellPosition?: number };
  const machinesForCell = (cellId: string) =>
    Object.values(machines)
      .filter((m) => (m as WithCell).cellId === cellId)
      .sort((a, b) => ((a as WithCell).cellPosition ?? 0) - ((b as WithCell).cellPosition ?? 0));
  const unassigned = Object.values(machines).filter((m) => !(m as WithCell).cellId);

  const useCells = cells.length > 0;

  // Resolve the active slot by matching the current hour against configured startHour values.
  // This is independent of the PLC shift number, which may not match the number of configured slots.
  const activeSlotIndex = (() => {
    const slots = shiftConfig.slots;
    if (slots.length === 0 || currentShift === 0) return -1;
    const hour = currentTime.getHours();
    const sorted = [...slots.entries()].sort((a, b) => a[1].startHour - b[1].startHour);
    let idx = sorted[sorted.length - 1][0]; // default: last slot (started yesterday)
    for (const [i, slot] of sorted) {
      if (hour >= slot.startHour) idx = i;
    }
    return idx;
  })();
  const activeSlotName  = activeSlotIndex >= 0 ? shiftConfig.slots[activeSlotIndex]?.name ?? null : null;
  const activeTeam      = activeSlotIndex >= 0 ? (todayTeams[activeSlotIndex] ?? null) : null;
  // Badge label: show team if assigned, otherwise fall back to slot name
  const shiftBadgeLabel = activeTeam ?? activeSlotName;

  // Derive shift start wall-clock time from the active slot's configured startHour.
  // This is always accurate regardless of bridge restarts or deployments, because
  // the shift boundary is defined by the admin-configured startHour, not by when
  // the bridge first detected a PLC shift-number change.
  // Cross-midnight handled: if the computed start is in the future the shift began yesterday.
  const shiftStartedAt = (() => {
    if (activeSlotIndex < 0) return 0;
    const slot = shiftConfig.slots[activeSlotIndex];
    if (!slot) return 0;
    const d = new Date(currentTime);
    d.setHours(slot.startHour, 0, 0, 0);
    if (d.getTime() > currentTime.getTime()) {
      d.setDate(d.getDate() - 1);
    }
    return d.getTime();
  })();

  // Net production time available per shift (shift length minus planned downtime)
  const effectiveShiftMins = Math.max(
    1,
    thresholds.bu.shiftLengthMinutes - (thresholds.bu.plannedDowntimeMinutes ?? 0)
  );


  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Machine Park Live Status</h2>
        <div className="flex gap-2">
          <span className="bg-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-full">
            <i className="bi bi-calendar3 mr-1"></i>
            {currentTime.toLocaleString("de-DE")}
          </span>
          {initialLoading ? (
            <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></span>
              Loading...
            </span>
          ) : (
            <span className={`text-xs px-3 py-1.5 rounded-full flex items-center gap-1 ${mqttConnected ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
              <i className={`bi bi-${mqttConnected ? "wifi" : "wifi-off"}`}></i>
              {machineCount} Machines{!mqttConnected && <span className="ml-1">(Bridge offline)</span>}
            </span>
          )}
        </div>
      </div>

      {/* Error banner */}
      {dbError && (
        <div className="mb-4 bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-3 flex items-start gap-2">
          <i className="bi bi-exclamation-circle shrink-0 mt-0.5"></i>
          <div><span className="font-medium">Could not load machines from database:</span> {dbError}</div>
        </div>
      )}


      {/* ── Shift + BU progress ── */}
      {shiftBadgeLabel && shiftStartedAt > 0 && (
        <ShiftAndBUProgress
          shiftStartedAt={shiftStartedAt}
          totalShiftMins={thresholds.bu.shiftLengthMinutes}
          shiftName={shiftBadgeLabel}
          currentTime={currentTime}
          machines={machines}
          thresholds={thresholds}
        />
      )}

      {/* ── Park summary tiles ── */}
      {hasData && (
        <ParkSummaryTiles machines={machines} thresholds={thresholds} shiftStartedAt={shiftStartedAt} />
      )}

      {/* ── Grouped by production cell ── */}
      {useCells ? (
        <>
          {cells.map((cell) => (
            <CellSection
              key={cell.id}
              title={cell.name}
              icon="bi-collection"
              color="text-cyan-400"
              machines={machinesForCell(cell.id)}
              onMachineClick={(code, pf) => router.push(`/production?machine=${code}${pf ? `&packing=${pf}` : ""}`)}
              thresholds={thresholds}
              shiftLengthMinutes={thresholds.bu.shiftLengthMinutes}
              shiftStartedAt={shiftStartedAt}
              now={currentTime.getTime()}
              errorLookup={errorLookup}
            />
          ))}
          {unassigned.length > 0 && (
            <CellSection
              title="Unassigned"
              icon="bi-inbox"
              color="text-gray-400"
              machines={unassigned}
              onMachineClick={(code, pf) => router.push(`/production?machine=${code}${pf ? `&packing=${pf}` : ""}`)}
              thresholds={thresholds}
              shiftLengthMinutes={thresholds.bu.shiftLengthMinutes}
              shiftStartedAt={shiftStartedAt}
              now={currentTime.getTime()}
              errorLookup={errorLookup}
            />
          )}
        </>
      ) : (
        /* ── Flat table (no cells configured) ── */
        <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-800">
                <tr>
                  {(["Machine","Status","Speed","IdleTime","ErrorTime","Efficiency","Reject","LastSync"] as SortColumn[]).map((col) => (
                    <SortHeader
                      key={col}
                      col={col}
                      label={col === "IdleTime" ? "Total Idle Time" : col === "ErrorTime" ? "Total Error Time" : col === "LastSync" ? "Last Sync" : col === "Efficiency" ? "Uptime" : col}
                      sortColumn={sortColumn}
                      sortAsc={sortAsc}
                      onSort={handleSort}
                    />
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {sortMachineList(Object.values(machines), sortColumn, sortAsc).map((m) => (
                  <MachineRow
                    key={m.machine}
                    m={m as DashboardMachine}
                    shiftLengthMinutes={thresholds.bu.shiftLengthMinutes}
                    plannedDowntimeMinutes={thresholds.bu.plannedDowntimeMinutes ?? 0}
                    shiftStartedAt={shiftStartedAt}
                    now={currentTime.getTime()}
                    errorLookup={errorLookup}
                    onClick={() => router.push(`/production?machine=${m.machine}${(m as DashboardMachine).packingFormat ? `&packing=${(m as DashboardMachine).packingFormat}` : ""}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
