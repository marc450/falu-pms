"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { fmtN, fmtPct } from "@/lib/fmt";
import {
  fetchMachineShiftSummary,
  fetchProductionCells,
  teamNameForShift,
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
  cellId:   string;
  cellName: string;
  avgBu:    number | null;
  avgEff:   number | null;
  avgScrap: number | null;
  shifts:   number;          // unique (work_day, shift_label) combos
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

  // ── BU thresholds from machine targets ──
  const buGood = useMemo(() => {
    const targets = machines.map(m => m.bu_target).filter((v): v is number => v != null);
    return targets.length > 0 ? targets.reduce((s, v) => s + v, 0) / targets.length : 185;
  }, [machines]);
  const buMed = useMemo(() => {
    const meds = machines.map(m => m.bu_mediocre).filter((v): v is number => v != null);
    return meds.length > 0 ? meds.reduce((s, v) => s + v, 0) / meds.length : 150;
  }, [machines]);

  // ── Fleet-wide KPIs ──
  const fleetEff   = useMemo(() => simpleAvg(rows, "avg_efficiency"), [rows]);
  const fleetScrap = useMemo(() => simpleAvg(rows, "avg_scrap"), [rows]);

  // ── Per-cell stats ──
  const cellStats: CellStats[] = useMemo(() => {
    // Group rows by cell
    const grouped = new Map<string, MachineShiftRow[]>();
    for (const r of rows) {
      const cellId = machineCellMap.get(r.machine_code);
      if (!cellId) continue; // skip unassigned machines
      if (!grouped.has(cellId)) grouped.set(cellId, []);
      grouped.get(cellId)!.push(r);
    }

    const stats: CellStats[] = [];
    for (const [cellId, cellRows] of grouped) {
      const name = cellNameMap.get(cellId);
      if (!name) continue;

      const shiftKeys = new Set(cellRows.map(r => `${r.work_day}|${r.shift_label}`));

      stats.push({
        cellId,
        cellName: name,
        avgBu:    weightedAvg(cellRows, "bu_normalized"),
        avgEff:   simpleAvg(cellRows, "avg_efficiency"),
        avgScrap: simpleAvg(cellRows, "avg_scrap"),
        shifts:   shiftKeys.size,
      });
    }

    // Sort by avgBu descending (nulls last)
    stats.sort((a, b) => {
      if (a.avgBu === null && b.avgBu === null) return 0;
      if (a.avgBu === null) return 1;
      if (b.avgBu === null) return -1;
      return b.avgBu - a.avgBu;
    });

    return stats;
  }, [rows, machineCellMap, cellNameMap]);

  // ── Fleet avg BU for the divider line ──
  const fleetAvgBu = useMemo(() => weightedAvg(rows, "bu_normalized"), [rows]);

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

  // Find index where cells drop below fleet average (for the divider)
  const dividerIdx = fleetAvgBu !== null
    ? cellStats.findIndex(c => c.avgBu !== null && c.avgBu < fleetAvgBu)
    : -1;

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

        {/* Fleet Avg BU */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-3 flex items-center gap-3">
          <i className="bi bi-box-seam text-green-400"></i>
          <div>
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Fleet Avg BU</div>
            <div className={`text-xl font-bold ${buColor(fleetAvgBu, buGood, buMed)}`}>{fmtN(fleetAvgBu, 1)}</div>
            <div className="text-[10px] text-gray-500">Normalized to 12 h shift</div>
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
          <span className="text-xs text-gray-500 ml-2">Ranked by Avg BU Output</span>
        </div>

        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700 bg-gray-900/40">
              <th className="w-16 px-4 py-2.5 text-center text-xs font-semibold text-gray-400">#</th>
              <th className="px-4 py-2.5 text-left   text-xs font-semibold text-gray-400">Cell</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400">Avg BU</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400">Efficiency</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400">Waste</th>
              <th className="px-4 py-2.5 text-right  text-xs font-semibold text-gray-400 hidden sm:table-cell">Shifts</th>
            </tr>
          </thead>
          <tbody>
            {cellStats.map((cell, idx) => {
              const rank = idx + 1;
              const showDivider = dividerIdx > 0 && idx === dividerIdx;

              return (
                <React.Fragment key={cell.cellId}>
                  {/* Divider row above first below-average cell */}
                  {showDivider && (
                    <tr>
                      <td colSpan={6} className="px-4 py-0">
                        <div className="flex items-center gap-2 py-1.5">
                          <div className="flex-1 border-t border-dashed border-gray-600"></div>
                          <span className="text-[10px] text-gray-500 uppercase tracking-wider whitespace-nowrap">Fleet Average ({fmtN(fleetAvgBu, 1)} BU)</span>
                          <div className="flex-1 border-t border-dashed border-gray-600"></div>
                        </div>
                      </td>
                    </tr>
                  )}
                  <tr className="border-b border-gray-700/40 hover:bg-gray-700/20 transition-colors">
                    <td className="w-16 px-4 py-3 text-center">
                      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${rankStyle(rank)}`}>
                        {rank}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-left">
                      <span className="text-sm font-semibold text-white">{cell.cellName}</span>
                    </td>
                    <td className={`px-4 py-3 text-right text-base font-bold font-mono ${buColor(cell.avgBu, buGood, buMed)}`}>
                      {fmtN(cell.avgBu, 1)}
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
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
}
