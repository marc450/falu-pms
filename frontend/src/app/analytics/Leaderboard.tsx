"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { fmtN, fmtPct } from "@/lib/fmt";
import {
  fetchMachineShiftSummary,
  fetchProductionCells,
} from "@/lib/supabase";
import type {
  DateRange, RegisteredMachine, MachineShiftRow,
  ProductionCell, TimeSlot, ShiftAssignment,
} from "@/lib/supabase";

// ─── Props ────────────────────────────────────────────────────────────────────

interface LeaderboardProps {
  dateRange:        DateRange;
  machines:         RegisteredMachine[];
  shiftSlots:       TimeSlot[];
  shiftAssignments: Record<string, ShiftAssignment>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function weightedAvg(
  rows: MachineShiftRow[],
  field: "bu_normalized" | "avg_efficiency" | "avg_scrap",
): number | null {
  const valid = rows.filter(r => r[field] != null && r.run_hours != null && r.run_hours > 0);
  if (valid.length === 0) return null;
  const totalHours = valid.reduce((s, r) => s + r.run_hours!, 0);
  if (totalHours === 0) return null;
  return valid.reduce((s, r) => s + (r[field]! * r.run_hours!), 0) / totalHours;
}

function simpleAvg(
  rows: MachineShiftRow[],
  field: "bu_normalized" | "avg_efficiency" | "avg_scrap",
): number | null {
  const valid = rows.filter(r => r[field] != null);
  if (valid.length === 0) return null;
  return valid.reduce((s, r) => s + r[field]!, 0) / valid.length;
}

// ─── Cell stats ───────────────────────────────────────────────────────────────

interface CellStats {
  cellId:        string;
  cellName:      string;
  actualBus:     number;        // Σ swabs_produced / 7200 across the period
  targetBus:     number;        // Σ bu_target across the (machine, shift) rows
  pctOfTarget:   number | null; // null when targetBus = 0
  avgEff:        number | null;
  avgScrap:      number | null;
  shifts:        number;        // unique (work_day, shift_crew) combos
}

// ─── Rank badge colors ────────────────────────────────────────────────────────

function rankStyle(rank: number): string {
  if (rank === 1) return "bg-yellow-500 text-gray-900";
  if (rank === 2) return "bg-gray-300 text-gray-900";
  if (rank === 3) return "bg-amber-700 text-white";
  return "bg-gray-700 text-gray-300";
}

function buColor(val: number | null, good: number, med: number): string {
  if (val === null) return "text-gray-500";
  if (val >= good) return "text-green-400";
  if (val >= med)  return "text-yellow-400";
  return "text-red-400";
}

// % of target → bar fill color. Green ≥ 95%, yellow ≥ 75%, red below.
function progressColor(pct: number | null): string {
  if (pct === null) return "bg-gray-700";
  if (pct >= 95) return "bg-green-500";
  if (pct >= 75) return "bg-yellow-500";
  return "bg-red-500";
}
function progressTextColor(pct: number | null): string {
  if (pct === null) return "text-gray-500";
  if (pct >= 95) return "text-green-400";
  if (pct >= 75) return "text-yellow-400";
  return "text-red-400";
}

function effColor(val: number | null): string {
  if (val === null) return "text-gray-500";
  if (val >= 75) return "text-green-400";
  if (val >= 55) return "text-yellow-400";
  return "text-red-400";
}

function scrapColor(val: number | null): string {
  if (val === null) return "text-gray-500";
  if (val <= 3)  return "text-green-400";
  if (val <= 5)  return "text-yellow-400";
  return "text-red-400";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Leaderboard({
  dateRange, machines, shiftSlots, shiftAssignments,
}: LeaderboardProps) {
  const [rows,    setRows]    = useState<MachineShiftRow[]>([]);
  const [cells,   setCells]   = useState<ProductionCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [shiftData, cellData] = await Promise.all([
        fetchMachineShiftSummary(dateRange, shiftSlots),
        fetchProductionCells(),
      ]);
      setRows(shiftData);
      setCells(cellData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  // ── Map machine_code → cell ──
  const machineCellMap = useMemo(() => {
    const m = new Map<string, string>(); // machine_code → cell_id
    for (const mc of machines) {
      if (mc.cell_id) m.set(mc.machine_code, mc.cell_id);
    }
    return m;
  }, [machines]);

  const cellNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cells) m.set(c.id, c.name);
    return m;
  }, [cells]);

  // ── Per-machine BU target lookup ──
  const machineTargetMap = useMemo(() => {
    const m = new Map<string, number>(); // machine_code → bu_target (per shift)
    for (const mc of machines) {
      if (mc.bu_target != null) m.set(mc.machine_code, mc.bu_target);
    }
    return m;
  }, [machines]);

  // ── Fleet-wide KPIs ──
  const fleetEff   = useMemo(() => simpleAvg(rows, "avg_efficiency"), [rows]);
  const fleetScrap = useMemo(() => simpleAvg(rows, "avg_scrap"), [rows]);

  // ── Per-cell stats ──
  // Production-driven leaderboard: each cell's "BU" is the actual BUs
  // produced in the period (Σ swabs / 7200), and its "target" is the sum
  // of per-shift bu_target values across the (machine, shift) rows in the
  // cell. The bar visualises actual / target. Cells are ranked by raw
  // actual BU output — highest wins, regardless of target.
  const cellStats: CellStats[] = useMemo(() => {
    const grouped = new Map<string, MachineShiftRow[]>();
    for (const r of rows) {
      const cellId = machineCellMap.get(r.machine_code);
      if (!cellId) continue;
      if (!grouped.has(cellId)) grouped.set(cellId, []);
      grouped.get(cellId)!.push(r);
    }

    const stats: CellStats[] = [];
    for (const [cellId, cellRows] of grouped) {
      const name = cellNameMap.get(cellId);
      if (!name) continue;

      const shiftKeys = new Set(cellRows.map(r => `${r.work_day}|${r.shift_crew}`));
      const actualBus = cellRows.reduce((s, r) => s + (r.swabs_produced / 7200), 0);
      // Target = sum of bu_target across (machine, shift) rows. A machine
      // missing a configured target contributes 0 to target, so cells with
      // unconfigured machines just look like they have a lower bar — better
      // than silently inflating the percentage.
      const targetBus = cellRows.reduce(
        (s, r) => s + (machineTargetMap.get(r.machine_code) ?? 0),
        0,
      );
      const pctOfTarget = targetBus > 0 ? (actualBus / targetBus) * 100 : null;

      stats.push({
        cellId,
        cellName:    name,
        actualBus,
        targetBus,
        pctOfTarget,
        avgEff:      simpleAvg(cellRows, "avg_efficiency"),
        avgScrap:    simpleAvg(cellRows, "avg_scrap"),
        shifts:      shiftKeys.size,
      });
    }

    // Rank by actual BU output (descending) — the user's spec: highest
    // production wins. Cells with zero output sort to the bottom.
    stats.sort((a, b) => b.actualBus - a.actualBus);
    return stats;
  }, [rows, machineCellMap, cellNameMap, machineTargetMap]);

  // ── Fleet totals for the header tile ──
  const fleetTotalBu = useMemo(() => cellStats.reduce((s, c) => s + c.actualBus, 0), [cellStats]);
  const fleetTotalTarget = useMemo(() => cellStats.reduce((s, c) => s + c.targetBus, 0), [cellStats]);
  const fleetPctOfTarget = fleetTotalTarget > 0 ? (fleetTotalBu / fleetTotalTarget) * 100 : null;

  // ── Current shift info ──
  const currentCrew = useMemo(() => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;
    const hour = today.getHours();

    // Determine which slot is active based on configured start hours
    let activeSlotIdx = 0;
    for (let i = shiftSlots.length - 1; i >= 0; i--) {
      if (hour >= shiftSlots[i].startHour) { activeSlotIdx = i; break; }
    }

    const assignment = shiftAssignments[dateStr];
    const team = assignment?.slot_teams?.[activeSlotIdx];

    const slotLabel = shiftSlots[activeSlotIdx]
      ? `Slot ${activeSlotIdx + 1} (${String(shiftSlots[activeSlotIdx].startHour).padStart(2, "0")}:00)`
      : `Slot ${activeSlotIdx + 1}`;

    return { team: team ?? "Unknown", slotLabel };
  }, [shiftSlots, shiftAssignments]);

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
        Loading leaderboard...
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-3">
        <i className="bi bi-exclamation-circle mr-2"></i>{error}
      </div>
    );
  }

  if (cellStats.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <i className="bi bi-trophy text-3xl text-gray-600"></i>
        <p className="text-sm text-gray-500">No cell data for this period. Assign machines to cells in Settings.</p>
      </div>
    );
  }

  // No fleet-average divider any more — ranking is by raw production now,
  // not against a normalized average.

  return (
    <div className="flex flex-col gap-5">

      {/* ═══════════════════════════════════════════════════════════════════
          HEADER: FLOOR KPIs + CURRENT SHIFT
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex flex-wrap items-stretch gap-3">
        {/* Current shift */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-3 flex items-center gap-3">
          <i className="bi bi-clock text-blue-400"></i>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Current Shift</div>
            <div className="text-sm font-bold text-white">{currentCrew.team}</div>
            <div className="text-[10px] text-gray-500">{currentCrew.slotLabel}</div>
          </div>
        </div>

        {/* Floor Efficiency */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-3 flex items-center gap-3">
          <i className="bi bi-speedometer2 text-cyan-400"></i>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Floor Efficiency</div>
            <div className={`text-xl font-bold ${effColor(fleetEff)}`}>{fmtPct(fleetEff, 1)}</div>
          </div>
        </div>

        {/* Floor Scrap */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-3 flex items-center gap-3">
          <i className="bi bi-trash3 text-orange-400"></i>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Floor Waste</div>
            <div className={`text-xl font-bold ${scrapColor(fleetScrap)}`}>{fmtPct(fleetScrap, 1)}</div>
          </div>
        </div>

        {/* Fleet Total BU + target progress */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-3 flex items-center gap-3">
          <i className="bi bi-box-seam text-green-400"></i>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Fleet Total BU</div>
            <div className={`text-xl font-bold ${progressTextColor(fleetPctOfTarget)}`}>{fmtN(fleetTotalBu, 0)}</div>
            <div className="text-[10px] text-gray-500">
              {fleetTotalTarget > 0
                ? `${fmtN(fleetTotalTarget, 0)} target · ${fmtN(fleetPctOfTarget, 0)}%`
                : "No target configured"}
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          CELL LEADERBOARD
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-700 flex items-center gap-2">
          <i className="bi bi-trophy-fill text-yellow-400"></i>
          <h3 className="text-sm font-bold text-white">Cell Leaderboard</h3>
          <span className="text-xs text-gray-500 ml-2">Ranked by total BU production</span>
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700 bg-gray-900/40">
              <th className="w-16 px-4 py-2.5 text-center text-xs font-semibold text-gray-400">#</th>
              <th className="px-4 py-2.5 text-left   text-xs font-semibold text-gray-400">Cell</th>
              <th className="px-4 py-2.5 text-left   text-xs font-semibold text-gray-400">Production vs. Target</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400">Efficiency</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400">Waste</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400 hidden sm:table-cell">Shifts</th>
            </tr>
          </thead>
          <tbody>
            {cellStats.map((cell, idx) => {
              const rank = idx + 1;
              // Cap the bar fill at 100 % of the rail; the textual label
              // still shows the true percentage so over-target cells are
              // visible without breaking the layout.
              const fillPct = cell.pctOfTarget != null
                ? Math.min(100, Math.max(0, cell.pctOfTarget))
                : 0;

              return (
                <tr key={cell.cellId} className="border-b border-gray-700/40 hover:bg-gray-700/20 transition-colors">
                  <td className="w-16 px-4 py-3 text-center">
                    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${rankStyle(rank)}`}>
                      {rank}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-left">
                    <span className="text-sm font-semibold text-white">{cell.cellName}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-2.5 bg-gray-900/60 rounded-full overflow-hidden min-w-[120px]">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${progressColor(cell.pctOfTarget)}`}
                          style={{ width: `${fillPct}%` }}
                        />
                      </div>
                      <div className="flex flex-col items-end leading-tight min-w-[150px]">
                        <span className="text-sm font-bold font-mono text-white tabular-nums">
                          {fmtN(cell.actualBus, 0)}
                          <span className="text-gray-500 font-normal">
                            {cell.targetBus > 0 ? ` / ${fmtN(cell.targetBus, 0)} BU` : " BU"}
                          </span>
                        </span>
                        {cell.pctOfTarget != null && (
                          <span className={`text-[10px] font-mono ${progressTextColor(cell.pctOfTarget)}`}>
                            {fmtN(cell.pctOfTarget, 0)}%
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className={`px-4 py-3 text-right text-sm font-mono ${effColor(cell.avgEff)}`}>
                    {fmtPct(cell.avgEff, 1)}
                  </td>
                  <td className={`px-4 py-3 text-right text-sm font-mono ${scrapColor(cell.avgScrap)}`}>
                    {fmtPct(cell.avgScrap, 1)}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-gray-500 hidden sm:table-cell">
                    {cell.shifts}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}
