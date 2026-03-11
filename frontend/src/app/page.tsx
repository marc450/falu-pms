"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  fetchMachines,
  fetchRegisteredMachines,
  fetchProductionCells,
} from "@/lib/supabase";
import type { MachineData, RegisteredMachine, ProductionCell } from "@/lib/supabase";
import { getStatusColor, formatStatus } from "@/lib/utils";

type SortColumn = "Machine" | "Status" | "Speed" | "Swaps" | "Boxes" | "Efficiency" | "Reject" | "LastSync";

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
function MachineRow({ m, onClick }: { m: MachineData; onClick: () => void }) {
  const status = getStatusColor(m.machineStatus?.Status);
  return (
    <tr onClick={onClick} className="cursor-pointer hover:bg-white/5 transition-colors">
      <td className="px-4 py-3 font-bold text-cyan-400">{m.machine}</td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
          {formatStatus(m.machineStatus?.Status)}
        </span>
      </td>
      <td className="px-4 py-3">
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
      <td className="px-4 py-3">
        {m.machineStatus?.Efficiency ? `${m.machineStatus.Efficiency.toFixed(1)}%` : ""}
      </td>
      <td className={`px-4 py-3 ${(m.machineStatus?.Reject || 0) > 5 ? "text-red-400" : ""}`}>
        {m.machineStatus?.Reject ? `${m.machineStatus.Reject.toFixed(1)}%` : ""}
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
  sortColumn,
  sortAsc,
  onSort,
  onMachineClick,
  defaultOpen = true,
}: {
  title: string;
  icon: string;
  color: string;
  machines: MachineData[];
  sortColumn: SortColumn;
  sortAsc: boolean;
  onSort: (col: SortColumn) => void;
  onMachineClick: (code: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const sorted = sortMachineList(machines, sortColumn, sortAsc);

  return (
    <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden mb-4">
      {/* Section header */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-800 hover:bg-gray-750 transition-colors"
      >
        <div className="flex items-center gap-3">
          <i className={`bi ${icon} ${color}`}></i>
          <span className="text-white font-semibold text-sm">{title}</span>
          <span className="text-gray-500 text-xs">{machines.length} machine{machines.length !== 1 ? "s" : ""}</span>
        </div>
        <i className={`bi bi-chevron-${open ? "up" : "down"} text-gray-400 text-xs`}></i>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/70">
              <tr>
                {(["Machine","Status","Speed","Swaps","Boxes","Efficiency","Reject","LastSync"] as SortColumn[]).map((col) => (
                  <SortHeader
                    key={col}
                    col={col}
                    label={col === "Swaps" ? "Total Swabs" : col === "Boxes" ? "Total Blisters" : col === "LastSync" ? "Last Sync" : col}
                    sortColumn={sortColumn}
                    sortAsc={sortAsc}
                    onSort={onSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {sorted.map((m) => (
                <MachineRow
                  key={m.machine}
                  m={m}
                  onClick={() => onMachineClick(m.machine)}
                />
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-600 text-xs">
                    No machines in this cell
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [machines, setMachines] = useState<Record<string, MachineData & { cellId?: string | null }>>({});
  const [cells, setCells] = useState<ProductionCell[]>([]);
  const [mqttConnected, setMqttConnected] = useState(false);
  const [currentShift, setCurrentShift] = useState<number>(0);
  const [sortColumn, setSortColumn] = useState<SortColumn>("Machine");
  const [sortAsc, setSortAsc] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [dbError, setDbError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
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

    const merged: Record<string, MachineData & { cellId?: string | null; cellPosition?: number }> = {};
    for (const row of registered) {
      merged[row.machine_code] = {
        ...offlinePlaceholder(row),
        cellId: row.cell_id,
        cellPosition: row.cell_position ?? 0,
      };
    }

    try {
      const state = await fetchMachines();
      setMqttConnected(state.mqttConnected);
      setCurrentShift(state.currentShiftNumber || 0);
      for (const [code, live] of Object.entries(state.machines)) {
        merged[code] = {
          ...live,
          cellId: merged[code]?.cellId ?? null,
          cellPosition: merged[code]?.cellPosition ?? 0,
        };
      }
    } catch {
      setMqttConnected(false);
    }

    setMachines(merged);
  }, []);

  useEffect(() => {
    loadData();
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
              sortColumn={sortColumn}
              sortAsc={sortAsc}
              onSort={handleSort}
              onMachineClick={(code) => router.push(`/production?machine=${code}`)}
            />
          ))}
          {unassigned.length > 0 && (
            <CellSection
              title="Unassigned"
              icon="bi-inbox"
              color="text-gray-400"
              machines={unassigned}
              sortColumn={sortColumn}
              sortAsc={sortAsc}
              onSort={handleSort}
              onMachineClick={(code) => router.push(`/production?machine=${code}`)}
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
                      label={col === "Swaps" ? "Total Swabs" : col === "Boxes" ? "Total Blisters" : col === "LastSync" ? "Last Sync" : col}
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
                    m={m}
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
