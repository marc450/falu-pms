"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { fmtN, fmtPct } from "@/lib/fmt";
import {
  fetchMachineShiftSummary,
  fetchProductionCells,
  fetchRegisteredMachines,
  fetchShiftConfig,
  fetchShiftAssignments,
} from "@/lib/supabase";
import type {
  RegisteredMachine, MachineShiftRow,
  ProductionCell, ShiftConfig, ShiftAssignment,
} from "@/lib/supabase";

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

// ─── Types ────────────────────────────────────────────────────────────────────

interface CellStats {
  cellId:   string;
  cellName: string;
  avgBu:    number | null;
  avgEff:   number | null;
  avgScrap: number | null;
}

// ─── Styling helpers ──────────────────────────────────────────────────────────

function rankBg(rank: number): string {
  if (rank === 1) return "bg-yellow-500/15 border-yellow-500/40";
  if (rank === 2) return "bg-gray-400/10 border-gray-400/30";
  if (rank === 3) return "bg-amber-700/15 border-amber-700/40";
  return "bg-gray-800/40 border-gray-700/40";
}

function rankBadge(rank: number): string {
  if (rank === 1) return "bg-yellow-500 text-gray-900";
  if (rank === 2) return "bg-gray-300 text-gray-900";
  if (rank === 3) return "bg-amber-700 text-white";
  return "bg-gray-700 text-gray-400";
}

function buColor(val: number | null, good: number, med: number): string {
  if (val === null) return "text-gray-600";
  if (val >= good) return "text-green-400";
  if (val >= med)  return "text-yellow-400";
  return "text-red-400";
}

function effColor(val: number | null): string {
  if (val === null) return "text-gray-600";
  if (val >= 75) return "text-green-400";
  if (val >= 55) return "text-yellow-400";
  return "text-red-400";
}

function scrapColor(val: number | null): string {
  if (val === null) return "text-gray-600";
  if (val <= 3)  return "text-green-400";
  if (val <= 5)  return "text-yellow-400";
  return "text-red-400";
}

// ─── Auto-refresh interval (ms) ──────────────────────────────────────────────

const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ─── Component ────────────────────────────────────────────────────────────────

export default function LeaderboardPage() {
  const [rows,     setRows]     = useState<MachineShiftRow[]>([]);
  const [cells,    setCells]    = useState<ProductionCell[]>([]);
  const [machines, setMachines] = useState<RegisteredMachine[]>([]);
  const [config,   setConfig]   = useState<ShiftConfig | null>(null);
  const [assigns,  setAssigns]  = useState<Record<string, ShiftAssignment>>({});
  const [loading,  setLoading]  = useState(true);
  const [lastLoad, setLastLoad] = useState<Date>(new Date());

  const load = useCallback(async () => {
    try {
      // Date range: last 7 days
      const to   = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 7);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const [shiftCfg, machineList, cellList] = await Promise.all([
        fetchShiftConfig(),
        fetchRegisteredMachines(),
        fetchProductionCells(),
      ]);

      const assignRows = await fetchShiftAssignments(fmt(from), fmt(to), shiftCfg.teams);

      const shiftData = await fetchMachineShiftSummary(
        { start: from, end: to },
        shiftCfg.slots,
      );

      setConfig(shiftCfg);
      setMachines(machineList);
      setCells(cellList);
      setAssigns(Object.fromEntries(assignRows.map(a => [a.shift_date, a])));
      setRows(shiftData);
      setLastLoad(new Date());
    } catch (e) {
      console.error("Leaderboard load error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  // ── Maps ──
  const machineCellMap = useMemo(() => {
    const m = new Map<string, string>();
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

  // ── BU thresholds ──
  const buGood = useMemo(() => {
    const t = machines.map(m => m.bu_target).filter((v): v is number => v != null);
    return t.length > 0 ? t.reduce((s, v) => s + v, 0) / t.length : 185;
  }, [machines]);
  const buMed = useMemo(() => {
    const t = machines.map(m => m.bu_mediocre).filter((v): v is number => v != null);
    return t.length > 0 ? t.reduce((s, v) => s + v, 0) / t.length : 150;
  }, [machines]);

  // ── Fleet KPIs ──
  const fleetBu    = useMemo(() => weightedAvg(rows, "bu_normalized"), [rows]);
  const fleetEff   = useMemo(() => simpleAvg(rows, "avg_efficiency"), [rows]);
  const fleetScrap = useMemo(() => simpleAvg(rows, "avg_scrap"), [rows]);

  // ── Cell stats ──
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
      stats.push({
        cellId,
        cellName: name,
        avgBu:    weightedAvg(cellRows, "bu_normalized"),
        avgEff:   simpleAvg(cellRows, "avg_efficiency"),
        avgScrap: simpleAvg(cellRows, "avg_scrap"),
      });
    }
    stats.sort((a, b) => {
      if (a.avgBu === null && b.avgBu === null) return 0;
      if (a.avgBu === null) return 1;
      if (b.avgBu === null) return -1;
      return b.avgBu - a.avgBu;
    });
    return stats;
  }, [rows, machineCellMap, cellNameMap]);

  // ── Current crew ──
  const currentCrew = useMemo(() => {
    if (!config) return null;
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;
    const hour = now.getHours();
    let activeSlotIdx = 0;
    for (let i = config.slots.length - 1; i >= 0; i--) {
      if (hour >= config.slots[i].startHour) { activeSlotIdx = i; break; }
    }
    const team = assigns[dateStr]?.slot_teams?.[activeSlotIdx];
    return team ?? null;
  }, [config, assigns]);

  // ── Clock ──
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const timeStr = clock.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = clock.toLocaleDateString("de-CH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // ── Fleet avg divider index ──
  const dividerIdx = fleetBu !== null
    ? cellStats.findIndex(c => c.avgBu !== null && c.avgBu < fleetBu)
    : -1;

  // ── Loading state ──
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <span className="inline-block w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></span>
          <p className="text-gray-400 text-xl">Loading Leaderboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col p-6 gap-6">

      {/* ═══════════════════════════════════════════════════════════════════
          TOP BAR: Clock + Current Crew
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <i className="bi bi-building text-blue-400 text-3xl"></i>
          <div>
            <h1 className="text-3xl font-black text-white tracking-tight">U.S. COTTON</h1>
            <p className="text-lg text-gray-500">Production Leaderboard</p>
          </div>
        </div>
        <div className="flex items-center gap-8">
          {currentCrew && (
            <div className="text-right">
              <p className="text-sm text-gray-500 uppercase tracking-wider">Current Crew</p>
              <p className="text-2xl font-black text-cyan-400">{currentCrew}</p>
            </div>
          )}
          <div className="text-right">
            <p className="text-4xl font-mono font-bold text-white tabular-nums">{timeStr}</p>
            <p className="text-sm text-gray-500">{dateStr}</p>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          FLOOR KPI TILES
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-3 gap-4">
        {/* Fleet Avg BU */}
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-8 py-6 flex items-center gap-6">
          <i className="bi bi-box-seam text-5xl text-blue-400"></i>
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wider font-semibold">Fleet Avg BU</p>
            <p className={`text-5xl font-black tabular-nums ${buColor(fleetBu, buGood, buMed)}`}>
              {fmtN(fleetBu, 1)}
            </p>
            <p className="text-xs text-gray-600 mt-1">Normalized to 12 h shift</p>
          </div>
        </div>

        {/* Floor Efficiency */}
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-8 py-6 flex items-center gap-6">
          <i className="bi bi-speedometer2 text-5xl text-cyan-400"></i>
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wider font-semibold">Floor Efficiency</p>
            <p className={`text-5xl font-black tabular-nums ${effColor(fleetEff)}`}>
              {fmtPct(fleetEff, 1)}
            </p>
            <p className="text-xs text-gray-600 mt-1">Last 7 days</p>
          </div>
        </div>

        {/* Floor Waste */}
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-8 py-6 flex items-center gap-6">
          <i className="bi bi-trash3 text-5xl text-orange-400"></i>
          <div>
            <p className="text-sm text-gray-500 uppercase tracking-wider font-semibold">Floor Waste</p>
            <p className={`text-5xl font-black tabular-nums ${scrapColor(fleetScrap)}`}>
              {fmtPct(fleetScrap, 1)}
            </p>
            <p className="text-xs text-gray-600 mt-1">Last 7 days</p>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          CELL LEADERBOARD
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col gap-3 min-h-0">
        <div className="flex items-center gap-3">
          <i className="bi bi-trophy-fill text-yellow-400 text-2xl"></i>
          <h2 className="text-2xl font-bold text-white">Cell Ranking</h2>
          <span className="text-sm text-gray-500 ml-2">by Avg BU Output</span>
          <span className="ml-auto text-xs text-gray-600">
            Updated {lastLoad.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>

        {cellStats.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-2xl text-gray-600">No cell data available</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-2 overflow-auto">
            {cellStats.map((cell, idx) => {
              const rank = idx + 1;
              const showDivider = dividerIdx > 0 && idx === dividerIdx;

              return (
                <React.Fragment key={cell.cellId}>
                  {showDivider && (
                    <div className="flex items-center gap-4 px-4 py-1">
                      <div className="flex-1 border-t-2 border-dashed border-gray-700"></div>
                      <span className="text-xs text-gray-500 uppercase tracking-widest font-semibold whitespace-nowrap">
                        Fleet Average  {fmtN(fleetBu, 1)} BU
                      </span>
                      <div className="flex-1 border-t-2 border-dashed border-gray-700"></div>
                    </div>
                  )}
                  <div className={`flex items-center gap-6 px-6 py-4 rounded-xl border ${rankBg(rank)} transition-colors`}>
                    {/* Rank */}
                    <span className={`flex items-center justify-center w-12 h-12 rounded-full text-xl font-black shrink-0 ${rankBadge(rank)}`}>
                      {rank}
                    </span>

                    {/* Cell name */}
                    <span className="text-2xl font-bold text-white min-w-[140px]">
                      {cell.cellName}
                    </span>

                    {/* BU */}
                    <div className="flex-1 flex items-center gap-3">
                      <div className="flex-1">
                        <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${
                              cell.avgBu !== null && cell.avgBu >= buGood ? "bg-green-500"
                              : cell.avgBu !== null && cell.avgBu >= buMed ? "bg-yellow-500"
                              : "bg-red-500"
                            }`}
                            style={{ width: `${Math.min(100, ((cell.avgBu ?? 0) / (buGood * 1.15)) * 100)}%` }}
                          ></div>
                        </div>
                      </div>
                      <span className={`text-3xl font-black tabular-nums min-w-[120px] text-right ${buColor(cell.avgBu, buGood, buMed)}`}>
                        {fmtN(cell.avgBu, 1)}
                      </span>
                      <span className="text-sm text-gray-600 font-medium">BU</span>
                    </div>

                    {/* Efficiency */}
                    <div className="text-right min-w-[100px]">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Eff</p>
                      <p className={`text-xl font-bold tabular-nums ${effColor(cell.avgEff)}`}>
                        {fmtPct(cell.avgEff, 1)}
                      </p>
                    </div>

                    {/* Waste */}
                    <div className="text-right min-w-[100px]">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Waste</p>
                      <p className={`text-xl font-bold tabular-nums ${scrapColor(cell.avgScrap)}`}>
                        {fmtPct(cell.avgScrap, 1)}
                      </p>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
