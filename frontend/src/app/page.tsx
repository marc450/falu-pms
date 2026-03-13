"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  fetchMachines,
  fetchRegisteredMachines,
  fetchProductionCells,
  fetchThresholds,
  applyEfficiencyColor,
  applyScrapColor,
  applyMachineEfficiencyColor,
  applyMachineScrapColor,
  applyMachineSpeedColor,
  applySpeedHeaderColor,
  applyRunRateColor,
  DEFAULT_THRESHOLDS,
} from "@/lib/supabase";
import type { MachineData, RegisteredMachine, ProductionCell, Thresholds, PackingFormat } from "@/lib/supabase";
import { PACKING_FORMATS } from "@/lib/supabase";
import { getStatusColor, formatStatus } from "@/lib/utils";

type SortColumn = "Machine" | "Status" | "Speed" | "Swaps" | "Boxes" | "Efficiency" | "Reject" | "LastSync";

type DashboardMachine = MachineData & {
  cellId?: string | null;
  cellPosition?: number;
  packingFormat?: PackingFormat | null;
  efficiencyGood?: number | null;
  efficiencyMediocre?: number | null;
  scrapGood?: number | null;
  scrapMediocre?: number | null;
  buTarget?: number | null;
  speedTarget?: number | null;
};

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
  // Don't project for offline machines — they skew the floor aggregate to 0 %
  if (!m.machineStatus || m.machineStatus.Status === "offline") return null;
  const elapsedMs  = Date.now() - shiftStartedAt;
  const elapsed    = elapsedMs / 60000;               // ms → minutes
  if (elapsed <= 0) return null;
  const currentBUs = (m.shift1?.ProducedSwaps ?? m.machineStatus?.Swaps ?? 0) / 7200;
  const buPerMin   = (m.machineStatus?.Speed ?? 0) / 7200;
  const remaining  = Math.max(0, shiftLen - elapsed);
  const projected  = currentBUs + buPerMin * remaining;
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
      Swaps: 0,
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
      case "Swaps":      aVal = a.machineStatus?.Swaps || 0; bVal = b.machineStatus?.Swaps || 0; break;
      case "Boxes":      aVal = a.machineStatus?.Boxes || 0; bVal = b.machineStatus?.Boxes || 0; break;
      case "Efficiency": aVal = a.machineStatus?.Efficiency || 0; bVal = b.machineStatus?.Efficiency || 0; break;
      case "Reject":     aVal = a.machineStatus?.Reject || 0; bVal = b.machineStatus?.Reject || 0; break;
      case "LastSync":
        aVal = a.lastSyncStatus ? new Date(a.lastSyncStatus).getTime() : 0;
        bVal = b.lastSyncStatus ? new Date(b.lastSyncStatus).getTime() : 0;
        break;
    }
    if (typeof aVal === "string") return asc ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
    return asc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });
}

// ─────────────────────────────────────────────────────────────
// Machine row
// ─────────────────────────────────────────────────────────────
function MachineRow({ m, shiftLengthMinutes, shiftStartedAt, onClick }: { m: DashboardMachine; shiftLengthMinutes: number; shiftStartedAt: number; onClick: () => void }) {
  const status   = getStatusColor(m.machineStatus?.Status);
  const effColor = applyMachineEfficiencyColor(m.machineStatus?.Efficiency ?? null, m.efficiencyGood ?? null, m.efficiencyMediocre ?? null);
  const scpColor = applyMachineScrapColor(m.machineStatus?.Reject ?? null, m.scrapGood ?? null, m.scrapMediocre ?? null);
  const spdColor = applyMachineSpeedColor(m.machineStatus?.Speed ?? null, m.speedTarget ?? null);
  const buRate   = calcBuRunRate(m, shiftLengthMinutes, shiftStartedAt);
  const buColor  = applyRunRateColor(buRate?.rate ?? null);

  // In rows: suppress green — only yellow and red signal problems; good = plain white
  const toRowColor = (c: string) => c === "text-green-400" ? "text-white" : c;

  return (
    <tr onClick={onClick} className="cursor-pointer hover:bg-white/5 transition-colors">
      <td className="px-4 py-3 font-bold text-cyan-400">{m.machine}</td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
          {formatStatus(m.machineStatus?.Status)}
        </span>
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(effColor.text)}`}>
        {m.machineStatus?.Efficiency ? `${m.machineStatus.Efficiency.toFixed(1)}%` : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(scpColor.text)}`}>
        {m.machineStatus?.Reject ? `${m.machineStatus.Reject.toFixed(1)}%` : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${toRowColor(buColor.text)}`}>
        {buRate !== null
          ? <>{Math.round(buRate.projected)} <span className="text-xs font-normal opacity-60">/ {buRate.target} BUs</span></>
          : m.buTarget ? <span className="text-gray-600">—</span> : ""}
      </td>
      <td className={`px-4 py-3 font-medium ${spdColor.text}`}>
        {m.machineStatus?.Speed ? (
          <>{m.machineStatus.Speed.toLocaleString()} <span className="text-gray-500 text-xs">pcs/min</span></>
        ) : null}
      </td>
      <td className="px-4 py-3">
        {m.machineStatus?.Swaps ? m.machineStatus.Swaps.toLocaleString() : ""}
      </td>
      <td className="px-4 py-3">
        {m.machineStatus?.Boxes ? m.machineStatus.Boxes.toLocaleString() : ""}
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
  defaultOpen = true,
}: {
  title: string;
  icon: string;
  color: string;
  machines: DashboardMachine[];
  onMachineClick: (code: string) => void;
  thresholds: Thresholds;
  shiftLengthMinutes: number;
  shiftStartedAt: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Compute cell-level stats
  let running = 0, effSum = 0, effCount = 0, scrapSum = 0, scrapCount = 0;
  let swabsTotal = 0, outputTotal = 0;
  let speedSum = 0, speedCount = 0, speedTargetSum = 0, speedTargetCount = 0;
  let cellProjected = 0, cellTarget = 0;
  for (const m of machines) {
    const s = m.machineStatus?.Status?.toLowerCase();
    if (s && s !== "offline" && s !== "error") running++;
    if (m.machineStatus?.Efficiency) { effSum += m.machineStatus.Efficiency; effCount++; }
    if (m.machineStatus?.Reject)     { scrapSum += m.machineStatus.Reject;   scrapCount++; }
    if (m.machineStatus?.Swaps)      swabsTotal  += m.machineStatus.Swaps;
    if (m.machineStatus?.Boxes)      outputTotal += m.machineStatus.Boxes;
    if (m.machineStatus?.Speed)      { speedSum += m.machineStatus.Speed; speedCount++; }
    if (m.speedTarget)               { speedTargetSum += m.speedTarget; speedTargetCount++; }
    const br = calcBuRunRate(m, shiftLengthMinutes, shiftStartedAt);
    if (br) { cellProjected += br.projected; cellTarget += br.target; }
  }
  const avgEff    = machines.length > 0 ? (effCount   > 0 ? effSum   / effCount   : 0) : null;
  const avgScrap  = machines.length > 0 ? (scrapCount > 0 ? scrapSum / scrapCount : 0) : null;
  const avgSpeed  = speedCount > 0 ? speedSum / speedCount : null;
  const avgSpeedTarget = speedTargetCount > 0 ? speedTargetSum / speedTargetCount : null;
  const cellRate  = cellTarget > 0 ? cellProjected / cellTarget : null;
  const ec   = applyEfficiencyColor(avgEff,   thresholds);
  const sc   = applyScrapColor     (avgScrap, thresholds);
  const buCc = applyRunRateColor   (cellRate);
  const spCc = applySpeedHeaderColor(avgSpeed, avgSpeedTarget);

  // Derive output label from machines' packing formats
  const formatSet = new Set(machines.map(m => m.packingFormat).filter((f): f is PackingFormat => !!f));
  const outputLabel = formatSet.size === 1
    ? PACKING_FORMATS[formatSet.values().next().value as PackingFormat]
    : formatSet.size === 0 ? "Blisters"
    : "Output";

  const colHeaders = [
    "Machine", "Status", "Uptime", "Scrap Rate", "BU Run Rate",
    "Speed", `Total Swabs`, `Total ${outputLabel}`, "Last Sync",
  ];

  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            {/* ── Cell summary row — each KPI sits above its column ── */}
            <tr
              onClick={() => setOpen(!open)}
              className="bg-gray-800 border-b border-gray-700 cursor-pointer hover:bg-gray-750 transition-colors"
            >
              {/* Machine col → cell name */}
              <td className="px-4 py-3 whitespace-nowrap">
                <div className="flex items-center gap-2">
                  <i className={`bi ${icon} ${color}`}></i>
                  <span className="text-white font-semibold text-sm">{title}</span>
                </div>
              </td>
              {/* Status col → running count, traffic-light colored */}
              <td className="px-4 py-3 whitespace-nowrap">
                <span className={`text-xs font-semibold ${
                  machines.length === 0 ? "text-gray-500"
                  : running === machines.length ? "text-green-400"
                  : running > 0            ? "text-yellow-400"
                  :                          "text-red-400"
                }`}>
                  {running}/{machines.length} running
                </span>
              </td>
              {/* Efficiency col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {avgEff !== null && (
                  <span className={`text-sm font-semibold ${ec.text}`}>{avgEff.toFixed(1)}%</span>
                )}
              </td>
              {/* Scrap Rate col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {avgScrap !== null && (
                  <span className={`text-sm font-semibold ${sc.text}`}>{avgScrap.toFixed(1)}%</span>
                )}
              </td>
              {/* BU Run Rate col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {cellTarget > 0 ? (
                  <span className={`text-sm font-semibold ${buCc.text}`}>
                    {Math.round(cellProjected)}{" "}
                    <span className="text-xs font-normal opacity-60">/ {Math.round(cellTarget)} BUs</span>
                    {cellRate !== null && (
                      <span className="opacity-70 ml-1 text-xs">({Math.round(cellRate * 100)}%)</span>
                    )}
                  </span>
                ) : null}
              </td>
              {/* Speed col → avg speed with color if targets configured */}
              <td className="px-4 py-3 whitespace-nowrap">
                {avgSpeed !== null && (
                  <span className={`text-sm font-semibold ${spCc.text}`}>
                    {Math.round(avgSpeed).toLocaleString()}{" "}
                    <span className="text-xs font-normal opacity-60">pcs/min</span>
                  </span>
                )}
              </td>
              {/* Total Swabs col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {swabsTotal > 0 && (
                  <span className="text-sm font-semibold text-white">
                    {swabsTotal.toLocaleString()}{" "}
                    <span className="text-xs font-normal opacity-50">swabs</span>
                  </span>
                )}
              </td>
              {/* Total Output col */}
              <td className="px-4 py-3 whitespace-nowrap">
                {outputTotal > 0 && (
                  <span className="text-sm font-semibold text-white">
                    {outputTotal.toLocaleString()}{" "}
                    <span className="text-xs font-normal opacity-50">{outputLabel.toLowerCase()}</span>
                  </span>
                )}
              </td>
              {/* Last Sync col → collapse chevron */}
              <td className="px-4 py-3 text-right">
                <i className={`bi bi-chevron-${open ? "up" : "down"} text-gray-400 text-xs`}></i>
              </td>
            </tr>

            {/* ── Column headers ── */}
            {open && (
              <tr className="bg-gray-800/70 border-b border-gray-700/50">
                {colHeaders.map((label) => (
                  <th key={label} className="px-4 py-2 text-left text-xs font-medium text-gray-500">
                    {label}
                  </th>
                ))}
              </tr>
            )}
          </thead>

          {open && (
            <tbody className="divide-y divide-gray-700/50">
              {machines.map((m) => (
                <MachineRow key={m.machine} m={m} shiftLengthMinutes={shiftLengthMinutes} shiftStartedAt={shiftStartedAt} onClick={() => onMachineClick(m.machine)} />
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

  let running = 0, effSum = 0, effCount = 0, scrapSum = 0, scrapCount = 0;
  let floorProjected = 0, floorTarget = 0;
  for (const m of all) {
    const s = m.machineStatus?.Status?.toLowerCase();
    if (s && s !== "offline" && s !== "error") running++;
    if (m.machineStatus?.Efficiency) { effSum += m.machineStatus.Efficiency; effCount++; }
    if (m.machineStatus?.Reject)     { scrapSum += m.machineStatus.Reject;   scrapCount++; }
    const br = calcBuRunRate(m, effectiveShiftMins, shiftStartedAt);
    if (br) { floorProjected += br.projected; floorTarget += br.target; }
  }

  const avgEff      = effCount   > 0 ? effSum   / effCount   : null;
  const avgScrap    = scrapCount > 0 ? scrapSum / scrapCount : null;
  const floorRate   = floorTarget > 0 ? floorProjected / floorTarget : null;
  const ec          = applyEfficiencyColor(avgEff,   thresholds);
  const sc          = applyScrapColor     (avgScrap, thresholds);
  const buc         = applyRunRateColor   (floorRate);

  const onlineColor  = running === 0 ? "text-red-400" : running < total ? "text-yellow-400" : "text-green-400";
  const onlineBorder = running === 0 ? "border-red-600" : running < total ? "border-yellow-600" : "border-green-600";

  if (total === 0) return null;

  // Whether any machine has a BU target configured (regardless of online status)
  const hasAnyBuTarget = all.some(m => m.buTarget && m.buTarget > 0);

  const buValue = floorTarget > 0
    ? `${Math.round(floorProjected)} / ${Math.round(floorTarget)}`
    : "—";
  const buSub = floorRate !== null
    ? `${Math.round(floorRate * 100)}% of target · BUs/shift`
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
          ? avgScrap <= thresholds.scrap.good ? "Good"
          : avgScrap <= thresholds.scrap.mediocre ? "Mediocre" : "Above target"
          : "No live data"}
        colorClass={sc.text}
        borderClass={sc.border}
      />
      <SummaryTile
        icon="bi-bullseye"
        label="Total BU Run Rate"
        value={buValue}
        sub={buSub}
        colorClass={buc.text}
        borderClass={buc.border}
      />
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
  const [shiftStartedAt, setShiftStartedAt] = useState<number>(Date.now());
  const [sortColumn, setSortColumn] = useState<SortColumn>("Machine");
  const [sortAsc, setSortAsc] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [dbError, setDbError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const router = useRouter();

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
        speedTarget:       row.speed_target ?? null,
      };
    }

    try {
      const state = await fetchMachines();
      setMqttConnected(state.mqttConnected);
      setCurrentShift(state.currentShiftNumber || 0);
      if (state.shiftStartedAt) setShiftStartedAt(state.shiftStartedAt);
      for (const [code, live] of Object.entries(state.machines)) {
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
          speedTarget:       merged[code]?.speedTarget ?? null,
        };
      }
    } catch {
      setMqttConnected(false);
    }

    setMachines(merged);
  }, []);

  useEffect(() => {
    loadData();
    fetchThresholds().then(setThresholds).catch(() => {/* use defaults */});
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
          {currentShift > 0 && (
            <span className="bg-blue-900/40 text-blue-300 text-xs px-3 py-1.5 rounded-full flex items-center gap-1">
              <i className="bi bi-clock mr-1"></i>Shift {currentShift}
            </span>
          )}
          {initialLoading ? (
            <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></span>
              Loading...
            </span>
          ) : !hasData ? (
            <span className="bg-gray-700 text-gray-400 text-xs px-3 py-1.5 rounded-full">
              <i className="bi bi-database mr-1"></i>0 machines registered
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
              onMachineClick={(code) => router.push(`/production?machine=${code}`)}
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
              onMachineClick={(code) => router.push(`/production?machine=${code}`)}
              thresholds={thresholds}
              shiftLengthMinutes={effectiveShiftMins}
              shiftStartedAt={shiftStartedAt}
            />
          )}
          {!hasData && (
            <div className="bg-gray-800/50 rounded-lg border border-gray-700 px-4 py-12 text-center text-gray-500">
              No machines registered. Add machines in Supabase to see them here.
            </div>
          )}
        </>
      ) : (
        /* ── Flat table (no cells configured) ── */
        <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-800">
                <tr>
                  {(["Machine","Status","Speed","Swaps","Boxes","Efficiency","Reject","LastSync"] as SortColumn[]).map((col) => (
                    <SortHeader
                      key={col}
                      col={col}
                      label={col === "Swaps" ? "Total Swabs" : col === "Boxes" ? "Total Blisters" : col === "LastSync" ? "Last Sync" : col === "Efficiency" ? "Uptime" : col}
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
                    onClick={() => router.push(`/production?machine=${m.machine}`)}
                  />
                ))}
                {Object.keys(machines).length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                      No machines registered. Add machines in Supabase to see them here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
