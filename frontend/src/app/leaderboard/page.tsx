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

// ─── Gauge component ─────────────────────────────────────────────────────────

/**
 * Semicircle gauge with red → yellow → green zones.
 * `value` is the current reading, `min`/`max` define the arc range.
 * `zones` defines where colors change: [redEnd, yellowEnd] as values.
 * If `invert` is true, low values are good (green on left, red on right).
 */
function Gauge({
  value, min, max, zones, label, display, invert = false,
}: {
  value:   number | null;
  min:     number;
  max:     number;
  zones:   [number, number]; // [boundary1, boundary2] — thresholds between zones
  label:   string;
  display: string;
  invert?: boolean;
}) {
  const cx = 120, cy = 110, r = 90, stroke = 18;
  // Arc from 180deg (left) to 0deg (right) = PI to 0
  const startAngle = Math.PI;
  const endAngle   = 0;
  const totalArc   = Math.PI; // semicircle

  // Clamp value to [min, max]
  const clamped = value !== null ? Math.max(min, Math.min(max, value)) : min;
  const pct = (clamped - min) / (max - min);
  const needleAngle = startAngle - pct * totalArc;

  // Zone boundaries as fractions
  const z1 = (zones[0] - min) / (max - min);
  const z2 = (zones[1] - min) / (max - min);

  // Colors: normal = red→yellow→green (left to right), inverted = green→yellow→red
  const c1 = invert ? "#22c55e" : "#ef4444";
  const c2 = "#eab308";
  const c3 = invert ? "#ef4444" : "#22c55e";

  // Helper to draw an arc path
  const arcPath = (fromFrac: number, toFrac: number) => {
    const a1 = startAngle - fromFrac * totalArc;
    const a2 = startAngle - toFrac * totalArc;
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy - r * Math.sin(a2);
    // In a semicircle (180° total), no zone ever spans > 180° of the full
    // circle, so large-arc-flag is always 0.  Sweep-flag 0 draws the short
    // arc counter-clockwise (left → right along the top in screen coords).
    return `M ${x1} ${y1} A ${r} ${r} 0 0 0 ${x2} ${y2}`;
  };

  // Needle endpoint
  const needleLen = r - 8;
  const nx = cx + needleLen * Math.cos(needleAngle);
  const ny = cy - needleLen * Math.sin(needleAngle);

  // Needle color from value
  const needleColor = value === null ? "#6b7280"
    : invert
      ? (value <= zones[0] ? "#22c55e" : value <= zones[1] ? "#eab308" : "#ef4444")
      : (value >= zones[1] ? "#22c55e" : value >= zones[0] ? "#eab308" : "#ef4444");

  return (
    <div className="flex flex-col items-center">
      <p className="text-sm text-gray-400 uppercase tracking-wider font-bold mb-1">{label}</p>
      <svg viewBox="0 0 240 135" className="w-full max-w-[280px]">
        {/* Zone arcs */}
        <path d={arcPath(0, z1)} fill="none" stroke={c1} strokeWidth={stroke} strokeLinecap="butt" />
        <path d={arcPath(z1, z2)} fill="none" stroke={c2} strokeWidth={stroke} strokeLinecap="butt" />
        <path d={arcPath(z2, 1)} fill="none" stroke={c3} strokeWidth={stroke} strokeLinecap="butt" />

        {/* Needle */}
        {value !== null && (
          <>
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={needleColor} strokeWidth={4} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={6} fill={needleColor} />
          </>
        )}

        {/* Center dot */}
        <circle cx={cx} cy={cy} r={3} fill="#1f2937" />
      </svg>
      <p className={`-mt-3 text-4xl font-black tabular-nums ${
        value === null ? "text-gray-600" : ""
      }`} style={value !== null ? { color: needleColor } : {}}>
        {display}
      </p>
    </div>
  );
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
          FLOOR KPI GAUGES
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-6 py-5">
          <Gauge
            value={fleetEff}
            min={0}
            max={100}
            zones={[55, 75]}
            label="Floor Efficiency"
            display={fmtPct(fleetEff, 1)}
          />
        </div>

        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-6 py-5">
          <Gauge
            value={fleetBu}
            min={0}
            max={buGood * 1.3}
            zones={[buMed, buGood]}
            label="Fleet Avg BU"
            display={fmtN(fleetBu, 1)}
          />
        </div>

        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-6 py-5">
          <Gauge
            value={fleetScrap}
            min={0}
            max={10}
            zones={[3, 5]}
            label="Floor Waste"
            display={fmtPct(fleetScrap, 1)}
            invert
          />
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
