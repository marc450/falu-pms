"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  fetchMachines,
  fetchRegisteredMachines,
  fetchProductionCells,
  fetchThresholds,
  fetchShiftConfig,
  fetchShiftAssignments,
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
import type { MachineData, RegisteredMachine, ProductionCell, Thresholds, PackingFormat, ShiftConfig } from "@/lib/supabase";
import { PACKING_FORMATS } from "@/lib/supabase";
import { getStatusColor, formatStatus } from "@/lib/utils";

type SortColumn  = "Machine" | "Status" | "Speed" | "Swabs" | "Boxes" | "Efficiency" | "Reject" | "LastSync";
type CellSortCol = "Machine" | "Status" | "Uptime" | "Scrap" | "BU" | "Speed" | "Swabs" | "Output" | "Sync";

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
  /** Unix ms timestamp of the last status transition (idle / error / offline / run). */
  statusSince?: number;
};

function formatStateDuration(sinceMs: number): string {
  const elapsed = Math.floor((Date.now() - sinceMs) / 1000);
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

// BU run rate: projected BUs at end of shift using user's formula
// projected = currentBUs + (currentSpeed / 7200) * remaining
// Elapsed is derived from the wall clock: (now - shiftStartedAt).
// The bridge records shiftStartedAt when it sees ActShift change, so
// this is always anchored to the real shift boundary, not PLC counters.
function calcBuRunRate(
  m: DashboardMachine,
  shiftLen: number,
  shiftStartedAt: number,
): { projected: number; target: number; rate: number } | null {
  const target = m.buTarget;
  if (!target || target <= 0) return null;
  // Only project for actively running machines
  const s = m.machineStatus?.Status?.toLowerCase();
  if (!s || s === "offline" || s === "idle" || s === "error") return null;

  // Read production from the shift that is actually active, not always shift1.
  const activeShift = m.machineStatus?.ActShift ?? 1;
  const activeShiftData = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
  const currentBUs = (activeShiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0) / 7200;
  const buPerMin   = (m.machineStatus?.Speed ?? 0) / 7200;

  // Use PLC-reported ProductionTime + IdleTime as elapsed shift time.
  // The wall clock (shiftStartedAt) resets every time the bridge restarts, which
  // makes elapsed ≈ 0 and inflates the projection to near a full shift.
  // The PLC counters are unaffected by bridge restarts and reflect actual machine time.
  // Fall back to wall clock only when no PLC shift data has arrived yet.
  const plcElapsed = (activeShiftData?.ProductionTime ?? 0) + (activeShiftData?.IdleTime ?? 0);
  const elapsed    = plcElapsed > 0
    ? plcElapsed
    : (Date.now() - shiftStartedAt) / 60000;
  if (elapsed <= 0) return null;

  const remaining = Math.max(0, shiftLen - elapsed);
  const projected = currentBUs + buPerMin * remaining;
  return { projected, target, rate: projected / target };
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
      case "Swabs":      aVal = a.machineStatus?.Swabs || 0; bVal = b.machineStatus?.Swabs || 0; break;
      case "Boxes":      aVal = a.machineStatus?.Boxes || 0; bVal = b.machineStatus?.Boxes || 0; break;
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
// Machine row
// ─────────────────────────────────────────────────────────────
function MachineRow({ m, shiftLengthMinutes, shiftStartedAt, onClick }: { m: DashboardMachine; shiftLengthMinutes: number; shiftStartedAt: number; onClick: () => void }) {
  const status     = getStatusColor(m.machineStatus?.Status);
  const effColor   = applyMachineEfficiencyColor(m.machineStatus?.Efficiency ?? null, m.efficiencyGood ?? null, m.efficiencyMediocre ?? null);
  const scpColor   = applyMachineScrapColor(m.machineStatus?.Reject ?? null, m.scrapGood ?? null, m.scrapMediocre ?? null);
  const spdColor   = applyMachineSpeedColor(m.machineStatus?.Speed ?? null, m.speedTarget ?? null);
  const buRate     = calcBuRunRate(m, shiftLengthMinutes, shiftStartedAt);
  const buColor    = applyBuRunRateColor(buRate?.projected ?? null, buRate?.target ?? null, m.buMediocre ?? null);
  const isOffline  = m.machineStatus?.Status?.toLowerCase() === "offline";
  const hasProduction = (m.machineStatus?.Swabs ?? 0) > 0;

  // In rows: suppress green — only yellow and red signal problems; good = plain white
  const toRowColor = (c: string) => c === "text-green-400" ? "text-white" : c;

  return (
    <tr onClick={onClick} className="cursor-pointer hover:bg-white/5 transition-colors">
      <td className="px-4 py-3 font-bold text-cyan-400">{m.machine}</td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${status.bg} ${status.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`}></span>
          {formatStatus(m.machineStatus?.Status)}
          {m.statusSince && (m.machineStatus?.Status?.toLowerCase() !== "run") && (
            <span className="opacity-70 font-normal">{formatStateDuration(m.statusSince)}</span>
          )}
        </span>
        {m.machineStatus?.Error && (
          <div
            className="text-xs text-gray-400 mt-0.5 max-w-[140px] truncate"
            title={m.machineStatus.Error}
          >
            {m.machineStatus.Error}
          </div>
        )}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(effColor.text)}`}>
        {!isOffline && hasProduction ? `${(m.machineStatus?.Efficiency ?? 0).toFixed(1)}%` : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(scpColor.text)}`}>
        {!isOffline && hasProduction ? `${(m.machineStatus?.Reject ?? 0).toFixed(1)}%` : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(buColor.text)}`}>
        {buRate !== null
          ? <>{Math.round(buRate.projected)} <span className="text-xs font-normal opacity-60">/ {buRate.target} BUs</span></>
          : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${spdColor.text}`}>
        {!isOffline ? (
          <>{(m.machineStatus?.Speed ?? 0).toLocaleString()} <span className="text-gray-500 text-xs">pcs/min</span></>
        ) : null}
      </td>
      <td className="px-4 py-3">
        {!isOffline ? (m.machineStatus?.Swabs ?? 0).toLocaleString() : ""}
      </td>
      <td className="px-4 py-3">
        {!isOffline ? (m.machineStatus?.Boxes ?? 0).toLocaleString() : ""}
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
  shiftLen: number,
  shiftStartedAt: number,
): DashboardMachine[] {
  return [...ms].sort((a, b) => {
    let aVal: string | number = 0;
    let bVal: string | number = 0;
    switch (col) {
      case "Machine": aVal = a.machine; bVal = b.machine; break;
      case "Status":  aVal = a.machineStatus?.Status || "zzz"; bVal = b.machineStatus?.Status || "zzz"; break;
      case "Uptime":  aVal = a.machineStatus?.Efficiency || 0; bVal = b.machineStatus?.Efficiency || 0; break;
      case "Scrap":   aVal = a.machineStatus?.Reject     || 0; bVal = b.machineStatus?.Reject     || 0; break;
      case "Speed":   aVal = a.machineStatus?.Speed      || 0; bVal = b.machineStatus?.Speed      || 0; break;
      case "Swabs":   aVal = a.machineStatus?.Swabs      || 0; bVal = b.machineStatus?.Swabs      || 0; break;
      case "Output":  aVal = a.machineStatus?.Boxes      || 0; bVal = b.machineStatus?.Boxes      || 0; break;
      case "Sync":
        aVal = a.lastSyncStatus ? new Date(a.lastSyncStatus).getTime() : 0;
        bVal = b.lastSyncStatus ? new Date(b.lastSyncStatus).getTime() : 0;
        break;
      case "BU": {
        const ar = calcBuRunRate(a, shiftLen, shiftStartedAt);
        const br = calcBuRunRate(b, shiftLen, shiftStartedAt);
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
  defaultOpen = false,
}: {
  title: string;
  icon: string;
  color: string;
  machines: DashboardMachine[];
  onMachineClick: (code: string, packingFormat?: PackingFormat | null) => void;
  thresholds: Thresholds;
  shiftLengthMinutes: number;
  shiftStartedAt: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [sortCol, setSortCol]   = useState<CellSortCol>("Machine");
  const [sortAsc, setSortAsc]   = useState(true);

  function handleSort(col: CellSortCol) {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(true); }
  }

  const sortedMachines = sortCellMachines(machines, sortCol, sortAsc, shiftLengthMinutes, shiftStartedAt);

  // Compute cell-level stats
  let running = 0, effSum = 0;
  let swabsTotal = 0, outputTotal = 0;
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
    // Uptime: all machines count — non-running contribute 0
    effSum += m.machineStatus?.Efficiency ?? 0;
    // Scrap: sum raw discarded/produced swabs across all non-offline machines
    const produced = m.machineStatus?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
    const discarded = m.machineStatus?.DiscardedSwabs ?? 0;
    if (!isOffline && produced > 0) { totalProduced += produced; totalDiscarded += discarded; }
    if (m.machineStatus?.Swabs)      swabsTotal  += m.machineStatus.Swabs;
    if (m.machineStatus?.Boxes)      outputTotal += m.machineStatus.Boxes;
    // Speed: running machines only
    if (isRunning && m.machineStatus?.Speed) { speedSum += m.machineStatus.Speed; speedCount++; }
    if (m.speedTarget)               { speedTargetSum += m.speedTarget; speedTargetCount++; }
    // BU Run Rate: running machines get full calc; non-running still add their target (0 projected)
    const br = calcBuRunRate(m, shiftLengthMinutes, shiftStartedAt);
    if (br) { cellProjected += br.projected; cellTarget += br.target; }
    else if (m.buTarget && m.buTarget > 0) { cellTarget += m.buTarget; }
    if (m.buMediocre && m.buMediocre > 0) { cellMediocreTarget += m.buMediocre; }
    if (m.efficiencyGood)     { effGoodSum   += m.efficiencyGood;     effGoodCount++; }
    if (m.efficiencyMediocre) { effMedSum    += m.efficiencyMediocre; effMedCount++;  }
    if (m.scrapGood)          { scrapGoodSum += m.scrapGood;          scrapGoodCount++; }
    if (m.scrapMediocre)      { scrapMedSum  += m.scrapMediocre;      scrapMedCount++;  }
  }
  const avgEff    = machines.length > 0 ? effSum / machines.length : null;
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

  // Column definitions: label, sort key, min-width
  type ColDef = { label: string; col: CellSortCol; minW: number };
  const colDefs: ColDef[] = [
    { label: "Machine",             col: "Machine", minW: 140 },
    { label: "Status",              col: "Status",  minW: 130 },
    { label: "Uptime",              col: "Uptime",  minW: 110 },
    { label: "Scrap Rate",          col: "Scrap",   minW: 110 },
    { label: "BU Run Rate",         col: "BU",      minW: 215 },
    { label: "Speed",               col: "Speed",   minW: 145 },
    { label: "Total Swabs",         col: "Swabs",   minW: 125 },
    { label: `Total ${outputLabel}`,col: "Output",  minW: 125 },
    { label: "Last Sync",           col: "Sync",    minW: 115 },
  ];

  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ tableLayout: "fixed" }}>
          {/* ── colgroup pins every column to a stable min-width ── */}
          <colgroup>
            {colDefs.map((cd) => (
              <col key={cd.col} style={{ minWidth: `${cd.minW}px` }} />
            ))}
          </colgroup>

          <thead>
            {/* ── Cell summary row — each KPI sits above its column ── */}
            <tr
              onClick={() => setOpen(!open)}
              className="bg-gray-800 border-b border-gray-700 cursor-pointer hover:bg-gray-750 transition-colors"
            >
              {/* Machine col → cell name */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[0].minW}px` }}>
                <div className={!open ? "flex flex-col gap-0.5" : "flex items-center gap-2"}>
                  {!open && <span className="text-[10px] invisible">·</span>}
                  <div className="flex items-center gap-2">
                    <i className={`bi ${icon} ${color}`}></i>
                    <span className="text-white font-semibold text-sm">{title}</span>
                  </div>
                </div>
              </td>
              {/* Status col → running count, traffic-light colored */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[1].minW}px` }}>
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
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[2].minW}px` }}>
                {avgEff !== null && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[2].label}</span>}
                    <span className={`text-sm font-semibold ${ec.text}`}>{avgEff.toFixed(1)}%</span>
                  </div>
                )}
              </td>
              {/* Scrap Rate col */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[3].minW}px` }}>
                {avgScrap !== null && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[3].label}</span>}
                    <span className={`text-sm font-semibold ${sc.text}`}>{avgScrap.toFixed(1)}%</span>
                  </div>
                )}
              </td>
              {/* BU Run Rate col */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[4].minW}px` }}>
                {cellTarget > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[4].label}</span>}
                    <span className={`text-sm font-semibold ${buCc.text}`}>
                      {Math.round(cellProjected)}{" "}
                      <span className="text-xs font-normal opacity-60">/ {Math.round(cellTarget)} BUs</span>
                    </span>
                  </div>
                ) : null}
              </td>
              {/* Speed col → avg speed with color if targets configured */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[5].minW}px` }}>
                {avgSpeed !== null && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[5].label}</span>}
                    <span className={`text-sm font-semibold ${spCc.text}`}>
                      {Math.round(avgSpeed).toLocaleString()}{" "}
                      <span className="text-xs font-normal opacity-60">pcs/min</span>
                    </span>
                  </div>
                )}
              </td>
              {/* Total Swabs col */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[6].minW}px` }}>
                {swabsTotal > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[6].label}</span>}
                    <span className="text-sm font-semibold text-white">
                      {swabsTotal.toLocaleString()}{" "}
                      <span className="text-xs font-normal opacity-50">swabs</span>
                    </span>
                  </div>
                )}
              </td>
              {/* Total Output col */}
              <td className="px-4 py-3 whitespace-nowrap" style={{ minWidth: `${colDefs[7].minW}px` }}>
                {outputTotal > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {!open && <span className="text-[10px] text-gray-500">{colDefs[7].label}</span>}
                    <span className="text-sm font-semibold text-white">
                      {outputTotal.toLocaleString()}{" "}
                      <span className="text-xs font-normal opacity-50">{outputLabel.toLowerCase()}</span>
                    </span>
                  </div>
                )}
              </td>
              {/* Last Sync col → collapse chevron */}
              <td className="px-4 py-3 text-right" style={{ minWidth: `${colDefs[8].minW}px` }}>
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
                    style={{ minWidth: `${cd.minW}px` }}
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
                <MachineRow key={m.machine} m={m} shiftLengthMinutes={shiftLengthMinutes} shiftStartedAt={shiftStartedAt} onClick={() => onMachineClick(m.machine, m.packingFormat)} />
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
  const effectiveShiftMins = Math.max(1, thresholds.bu.shiftLengthMinutes - (thresholds.bu.plannedDowntimeMinutes ?? 0));

  let running = 0, effSum = 0, effCount = 0;
  let totalDiscarded = 0, totalProduced = 0;
  let scrapGoodSum = 0, scrapGoodCount = 0, scrapMedSum = 0, scrapMedCount = 0;
  let floorProjected = 0, floorTarget = 0, floorMediocreTarget = 0;
  for (const m of all) {
    const s = m.machineStatus?.Status?.toLowerCase();
    const isRunning = s === "run" || s === "running";
    if (isRunning) running++;
    if (m.machineStatus?.Efficiency) { effSum += m.machineStatus.Efficiency; effCount++; }
    // Scrap: sum raw discarded/produced swabs across all non-offline machines
    const isOffline = s === "offline" || !s;
    const produced  = m.machineStatus?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
    const discarded = m.machineStatus?.DiscardedSwabs ?? 0;
    if (!isOffline && produced > 0) { totalProduced += produced; totalDiscarded += discarded; }
    // Accumulate per-machine scrap targets for color thresholds
    if (m.scrapGood)     { scrapGoodSum += m.scrapGood;     scrapGoodCount++; }
    if (m.scrapMediocre) { scrapMedSum  += m.scrapMediocre; scrapMedCount++;  }
    // BU: non-running machines still contribute their target
    const br = calcBuRunRate(m, effectiveShiftMins, shiftStartedAt);
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
    ? `${Math.round(floorProjected)} / ${Math.round(floorTarget)}`
    : "—";
  const buSub = floorRate !== null
    ? `BUs / shift`
    : hasAnyBuTarget ? "No live data" : "No targets set";

  return (
    <div className="grid grid-cols-3 gap-3 mb-6">
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
        value={avgEff !== null ? `${avgEff.toFixed(1)}%` : "—"}
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
        value={avgScrap !== null ? `${avgScrap.toFixed(1)}%` : "—"}
        sub={avgScrap !== null
          ? (avgScrapGood === null || avgScrap <= avgScrapGood) ? "Good"
          : (avgScrapMed === null || avgScrap <= avgScrapMed) ? "Mediocre" : "Above target"
          : "No live data"}
        colorClass={sc.text}
        borderClass={sc.border}
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
}: {
  shiftStartedAt: number;
  totalShiftMins: number;
  shiftName: string;
  currentTime: Date;
  machines: Record<string, DashboardMachine>;
}) {
  if (!shiftName || totalShiftMins <= 0) return null;

  // ── Shift elapsed ──
  const elapsedMins   = Math.max(0, (currentTime.getTime() - shiftStartedAt) / 60000);
  const remainingMins = Math.max(0, totalShiftMins - elapsedMins);
  const shiftProgress = Math.min(1, elapsedMins / totalShiftMins);
  const shiftPct      = Math.round(shiftProgress * 100);

  const shiftBarColor =
    shiftProgress < 0.75 ? "bg-cyan-500"
    : shiftProgress < 0.90 ? "bg-yellow-500"
    : "bg-red-500";

  // ── BU output ──
  const all = Object.values(machines);
  let totalCurrentBU = 0;
  let totalTargetBU  = 0;
  for (const m of all) {
    if (m.buTarget && m.buTarget > 0) totalTargetBU += m.buTarget;
    const activeShift = m.machineStatus?.ActShift ?? 1;
    const shiftData   = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
    const swabs       = shiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
    totalCurrentBU += swabs / 7200;
  }
  const hasBU      = totalTargetBU > 0;
  const buProgress = hasBU ? Math.min(1, totalCurrentBU / totalTargetBU) : 0;
  const buPct      = Math.round(buProgress * 100);
  const buBarColor =
    buProgress >= 0.9 ? "bg-green-500"
    : buProgress >= 0.7 ? "bg-yellow-500"
    : "bg-purple-500";

  return (
    <div className="mb-6 bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-4 space-y-4">
      {/* Shift elapsed */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <i className="bi bi-hourglass-split"></i>
            <span>Elapsed time <span className="text-gray-500">|</span> <span className="text-white">{shiftName}</span></span>
          </div>
          <span className="text-xs text-gray-500">{shiftPct}%</span>
        </div>
        <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mb-2">
          <div
            className={`h-full rounded-full transition-all duration-1000 ${shiftBarColor}`}
            style={{ width: `${shiftPct}%` }}
          />
        </div>
        <div className="flex justify-between text-xs">
          <span className="text-gray-400">
            <span className="text-white font-medium">{fmtDuration(elapsedMins)}</span>
            <span className="text-gray-600 ml-1">elapsed</span>
          </span>
          <span className="text-gray-400">
            <span className="text-gray-600 mr-1">remaining</span>
            <span className="text-white font-medium">{fmtDuration(remainingMins)}</span>
          </span>
        </div>
      </div>

      {/* BU output */}
      {hasBU && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <i className="bi bi-box-seam"></i>
              <span>BU output</span>
            </div>
            <span className="text-xs text-gray-500">{buPct}%</span>
          </div>
          <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-all duration-1000 ${buBarColor}`}
              style={{ width: `${buPct}%` }}
            />
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-400">
              <span className="text-white font-medium">{Math.round(totalCurrentBU)} BUs</span>
              <span className="text-gray-600 ml-1">produced</span>
            </span>
            <span className="text-gray-400">
              <span className="text-gray-600 mr-1">target</span>
              <span className="text-white font-medium">{Math.round(totalTargetBU)} BUs</span>
            </span>
          </div>
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
  // Shift mismatch warning: dismissed timestamp persisted in localStorage (4h suppression)
  const [shiftWarnDismissedAt, setShiftWarnDismissedAt] = useState<number>(() => {
    if (typeof window !== "undefined") {
      const v = localStorage.getItem("shiftMismatchDismissedAt");
      return v ? parseInt(v, 10) : 0;
    }
    return 0;
  });
  const router = useRouter();
  const bridgeFailCount = useRef(0);

  const loadData = useCallback(async () => {
    let registered: RegisteredMachine[] = [];
    let fetchedCells: ProductionCell[] = [];

    try {
      [registered, fetchedCells] = await Promise.all([
        fetchRegisteredMachines(),
        fetchProductionCells(),
      ]);
      setCells(fetchedCells);
      setDbError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Failed to fetch from Supabase:", msg);
      setDbError(msg);
    } finally {
      setInitialLoading(false);
    }

    const merged: Record<string, DashboardMachine> = {};
    for (const row of registered) {
      merged[row.machine_code] = {
        ...offlinePlaceholder(row),
        cellId:            row.cell_id,
        cellPosition:      row.cell_position ?? 0,
        packingFormat:     row.packing_format ?? null,
        efficiencyGood:    row.efficiency_good ?? null,
        efficiencyMediocre: row.efficiency_mediocre ?? null,
        scrapGood:         row.scrap_good ?? null,
        scrapMediocre:     row.scrap_mediocre ?? null,
        buTarget:          row.bu_target ?? null,
        buMediocre:        row.bu_mediocre ?? null,
        speedTarget:       row.speed_target ?? null,
      };
    }

    try {
      const state = await fetchMachines();
      bridgeFailCount.current = 0;
      setMqttConnected(state.mqttConnected);
      setCurrentShift(state.currentShiftNumber || 0);
      for (const [code, live] of Object.entries(state.machines)) {
        // Determine statusSince: carry forward if status unchanged, reset on change
        const prevStatus = machines[code]?.machineStatus?.Status?.toLowerCase();
        const nextStatus = live.machineStatus?.Status?.toLowerCase();
        const prevSince  = machines[code]?.statusSince;
        const statusSince =
          nextStatus && nextStatus !== prevStatus
            ? Date.now()
            : (prevSince ?? Date.now());

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
          statusSince,
        };
      }
      setMachines(merged);
    } catch {
      bridgeFailCount.current += 1;
      // Only show offline after 3 consecutive failed fetches (~6 s).
      // This prevents brief network hiccups from flashing the dashboard.
      if (bridgeFailCount.current >= 3) {
        setMqttConnected(false);
        setMachines(merged);
      }
      // Otherwise keep the previous machines state (do nothing)
    }
  }, []);

  useEffect(() => {
    loadData();
    fetchThresholds().then(setThresholds).catch(() => {/* use defaults */});
    fetchShiftConfig().then(setShiftConfig).catch(() => {/* use defaults */});
    const today = new Date().toISOString().slice(0, 10);
    fetchShiftAssignments(today, today)
      .then(rows => { if (rows[0]) setTodayTeams(rows[0].slot_teams); })
      .catch(() => {/* no assignment for today */});
    const dataInterval = setInterval(loadData, 2000);
    const clockInterval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => { clearInterval(dataInterval); clearInterval(clockInterval); };
  }, [loadData]);

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

  // Shift mismatch: any online machine whose ActShift doesn't match what the app
  // expects right now based on the configured slot schedule.
  // activeSlotIndex is 0-based; PLC ActShift is 1-based → expected = activeSlotIndex + 1.
  // This catches both "too many shifts" and "shift boundaries at wrong times".
  // Only run the check once the active slot is known (activeSlotIndex >= 0).
  const expectedShift = activeSlotIndex >= 0 ? activeSlotIndex + 1 : null;
  const SHIFT_WARN_DISMISS_MS = 4 * 60 * 60 * 1000;
  const mismatchedMachines = expectedShift === null ? [] : Object.entries(machines)
    .filter(([, m]) => {
      const status = m.machineStatus?.Status?.toLowerCase();
      if (!status || status === "offline") return false; // skip offline
      const actShift = m.machineStatus?.ActShift ?? 0;
      if (actShift === 0) return false;                  // skip no-data
      return actShift !== expectedShift;
    })
    .map(([code, m]) => ({ code, actShift: m.machineStatus?.ActShift ?? 0 }));
  const showShiftMismatch =
    mismatchedMachines.length > 0 &&
    (shiftWarnDismissedAt === 0 || Date.now() - shiftWarnDismissedAt > SHIFT_WARN_DISMISS_MS);

  const dismissShiftMismatch = () => {
    const now = Date.now();
    setShiftWarnDismissedAt(now);
    localStorage.setItem("shiftMismatchDismissedAt", String(now));
  };

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
          {shiftBadgeLabel && (
            <span className="bg-blue-900/40 text-blue-300 text-xs px-3 py-1.5 rounded-full flex items-center gap-1">
              <i className="bi bi-clock mr-1"></i>{shiftBadgeLabel}
            </span>
          )}
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

      {/* Shift mismatch warning */}
      {showShiftMismatch && (
        <div className="mb-4 bg-amber-900/30 border border-amber-600/50 rounded-lg px-4 py-3 flex items-start gap-3">
          <i className="bi bi-exclamation-triangle-fill shrink-0 mt-0.5 text-amber-400"></i>
          <div className="flex-1 text-sm">
            <p className="font-semibold text-amber-200 mb-1">Shift configuration mismatch</p>
            <p className="text-amber-300/90 leading-relaxed">
              {mismatchedMachines.map((m, i) => (
                <span key={m.code}>
                  {i > 0 && ", "}
                  <span className="font-mono font-semibold text-amber-200">{m.code}</span>
                  {" "}(reporting shift {m.actShift})
                </span>
              ))}
              {mismatchedMachines.length === 1 ? " is" : " are"} out of sync with the current shift schedule.
              {" "}Based on the configured shift structure, shift <span className="font-semibold text-amber-200">{expectedShift}</span> is expected right now,
              but {mismatchedMachines.length === 1 ? "this machine is" : "these machines are"} signalling a different shift boundary.
              {" "}This usually means the machine&apos;s internal shift schedule does not match the rest of the machine park.
              {" "}Please adapt the machine&apos;s shift settings accordingly.
              {" "}Refer to the machine manual or contact{" "}
              <a href="mailto:support@falu.com" className="underline hover:text-amber-200 transition-colors">support@falu.com</a>.
            </p>
          </div>
          <button
            onClick={dismissShiftMismatch}
            className="shrink-0 text-amber-600 hover:text-amber-300 transition-colors p-0.5"
            title="Dismiss for 4 hours"
          >
            <i className="bi bi-x-lg text-sm"></i>
          </button>
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
              shiftLengthMinutes={effectiveShiftMins}
              shiftStartedAt={shiftStartedAt}
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
              shiftLengthMinutes={effectiveShiftMins}
              shiftStartedAt={shiftStartedAt}
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
                  {(["Machine","Status","Speed","Swabs","Boxes","Efficiency","Reject","LastSync"] as SortColumn[]).map((col) => (
                    <SortHeader
                      key={col}
                      col={col}
                      label={col === "Swabs" ? "Total Swabs" : col === "Boxes" ? "Total Blisters" : col === "LastSync" ? "Last Sync" : col === "Efficiency" ? "Uptime" : col}
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
                    shiftLengthMinutes={effectiveShiftMins}
                    shiftStartedAt={shiftStartedAt}
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
