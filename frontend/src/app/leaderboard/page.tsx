"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { fmtN, fmtPct } from "@/lib/fmt";
import {
  fetchMachineShiftSummary,
  fetchProductionCells,
  fetchRegisteredMachines,
  fetchShiftConfig,
  fetchShiftAssignments,
  fetchMachines,
} from "@/lib/supabase";
import type {
  RegisteredMachine, MachineShiftRow,
  ProductionCell, ShiftConfig, ShiftAssignment, BridgeState,
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
  cellId:        string;
  cellName:      string;
  actualBus:     number;        // Σ swabs_produced / 7200 across the period
  targetBus:     number;        // Σ bu_target across (machine, shift) rows in the cell
  pctOfTarget:   number | null; // null when targetBus = 0
  avgEff:        number | null;
  avgScrap:      number | null;
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

// % of target → fill color for the production-vs-target bar.
// 100 %+ gets its own brighter shade so a cell that overruns target is
// visually distinct from one that just hit it; the bar itself stays
// capped at the rail width so the layout doesn't shift.
function progressBarColor(pct: number | null): string {
  if (pct === null) return "bg-gray-700";
  if (pct >= 100) return "bg-emerald-400";
  if (pct >= 95)  return "bg-green-500";
  if (pct >= 75)  return "bg-yellow-500";
  return "bg-red-500";
}
function progressTextColor(pct: number | null): string {
  if (pct === null) return "text-gray-500";
  if (pct >= 100) return "text-emerald-300";
  if (pct >= 95)  return "text-green-400";
  if (pct >= 75)  return "text-yellow-400";
  return "text-red-400";
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
    // large-arc = 0 (no zone spans > 180° of the full circle)
    // sweep = 1 (clockwise in SVG screen coords = upward arc)
    return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
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
  const [bridge,   setBridge]   = useState<BridgeState | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [lastLoad, setLastLoad] = useState<Date>(new Date());

  // Heavy load: historical data (every 5 min)
  const load = useCallback(async () => {
    try {
      const to   = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 7);
      const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      const [shiftCfg, machineList, cellList, bridgeData] = await Promise.all([
        fetchShiftConfig(),
        fetchRegisteredMachines(),
        fetchProductionCells(),
        fetchMachines().catch(() => null),
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
      if (bridgeData) setBridge(bridgeData);
      setLastLoad(new Date());
    } catch (e) {
      console.error("Leaderboard load error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Heavy refresh every 5 min
  useEffect(() => {
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Light poll: bridge state only (every 10s for live bars)
  useEffect(() => {
    const poll = () => fetchMachines().then(setBridge).catch(() => {});
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, []);

  // ── Maps ──
  const cellNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cells) m.set(c.id, c.name);
    return m;
  }, [cells]);

  // ── Fleet KPIs ──
  const fleetEff   = useMemo(() => simpleAvg(rows, "avg_efficiency"), [rows]);
  const fleetScrap = useMemo(() => simpleAvg(rows, "avg_scrap"), [rows]);

  // ── Cell stats — live in-progress shift, ranked by % of target ──
  // The leaderboard hangs above the production floor and represents *the
  // current shift only*, not a multi-day aggregate. Source the numbers
  // from the bridge's in-memory state (machineStatus) so the bars tick
  // up live as production accumulates, and divide by the per-machine
  // single-shift bu_target so 100 % fill = shift target hit.
  const cellStats: CellStats[] = useMemo(() => {
    if (!bridge) return [];
    const grouped = new Map<string, typeof machines>();
    for (const mc of machines) {
      if (!mc.cell_id) continue;
      if (!grouped.has(mc.cell_id)) grouped.set(mc.cell_id, []);
      grouped.get(mc.cell_id)!.push(mc);
    }
    const stats: CellStats[] = [];
    for (const [cellId, cellMachines] of grouped) {
      const name = cellNameMap.get(cellId);
      if (!name) continue;
      let actualBus = 0;
      let targetBus = 0;
      let effSum = 0, effCount = 0;
      let scrapSum = 0, scrapCount = 0;
      for (const reg of cellMachines) {
        if (reg.bu_target && reg.bu_target > 0) targetBus += reg.bu_target;
        const bm = bridge.machines[reg.machine_code];
        if (!bm) continue;
        const swabs = bm.machineStatus?.ProducedSwabs ?? bm.machineStatus?.Swabs ?? 0;
        actualBus += swabs / 7200;
        const eff = bm.machineStatus?.Efficiency;
        if (typeof eff === "number" && eff > 0) { effSum += eff; effCount++; }
        const scrap = bm.machineStatus?.Reject;
        if (typeof scrap === "number") { scrapSum += scrap; scrapCount++; }
      }
      stats.push({
        cellId,
        cellName:   name,
        actualBus,
        targetBus,
        pctOfTarget: targetBus > 0 ? (actualBus / targetBus) * 100 : null,
        avgEff:     effCount   > 0 ? effSum   / effCount   : null,
        avgScrap:   scrapCount > 0 ? scrapSum / scrapCount : null,
      });
    }
    // Rank by % of target — overrunners on top, slowest behind.
    stats.sort((a, b) => (b.pctOfTarget ?? -1) - (a.pctOfTarget ?? -1));
    return stats;
  }, [bridge, machines, cellNameMap]);

  // ── Fleet totals for the header tile ──
  const fleetTotalBu     = useMemo(() => cellStats.reduce((s, c) => s + c.actualBus, 0), [cellStats]);
  const fleetTotalTarget = useMemo(() => cellStats.reduce((s, c) => s + c.targetBus, 0), [cellStats]);
  const fleetPctOfTarget = fleetTotalTarget > 0 ? (fleetTotalBu / fleetTotalTarget) * 100 : null;

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

  // ── Compute true shift start from configured slot times (same as dashboard) ──
  const shiftStartedAt = useMemo(() => {
    if (!config || config.slots.length === 0) return 0;
    const now = clock;
    const hour = now.getHours();
    // Sort slots by startHour then pick the latest one whose startHour <= current hour.
    // If none match (e.g. 2am, all slots start later), default to the last sorted slot
    // (the night shift that started yesterday). This matches the dashboard logic exactly.
    const sorted = config.slots.map((s, i) => ({ i, startHour: s.startHour })).sort((a, b) => a.startHour - b.startHour);
    let activeSlotIdx = sorted[sorted.length - 1].i; // default: last slot
    for (const s of sorted) {
      if (hour >= s.startHour) activeSlotIdx = s.i;
    }
    const slot = config.slots[activeSlotIdx];
    if (!slot) return 0;
    const d = new Date(now);
    d.setHours(slot.startHour, 0, 0, 0);
    if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
    return d.getTime();
  }, [config, clock]);

  // ── Live shift race bars ──
  const shiftRace = useMemo(() => {
    if (!bridge || !config || shiftStartedAt <= 0) return null;
    const shiftMins = config.shiftDurationHours * 60;
    const elapsed = Math.max(0, (Date.now() - shiftStartedAt) / 60000);
    const shiftPct = Math.min(100, (elapsed / shiftMins) * 100);

    // Sum BU across all machines
    let totalCurrentBU = 0;
    let totalTargetBU  = 0;
    for (const m of Object.values(bridge.machines)) {
      // Find matching registered machine for BU target
      const reg = machines.find(rm => rm.machine_code === m.machine);
      if (reg?.bu_target && reg.bu_target > 0) totalTargetBU += reg.bu_target;
      const activeShift = m.machineStatus?.ActShift ?? 1;
      const shiftData = activeShift === 2 ? m.shift2 : activeShift === 3 ? m.shift3 : m.shift1;
      const swabs = shiftData?.ProducedSwabs ?? m.machineStatus?.Swabs ?? 0;
      totalCurrentBU += swabs / 7200;
    }
    const buPct = totalTargetBU > 0 ? Math.min(100, (totalCurrentBU / totalTargetBU) * 100) : 0;

    // Color: is BU pacing ahead of time or behind?
    const buBarColor = buPct >= shiftPct ? "bg-green-500" : buPct >= shiftPct * 0.85 ? "bg-yellow-500" : "bg-red-500";

    return {
      shiftPct: Math.round(shiftPct),
      buPct: Math.round(buPct),
      buBarColor,
      elapsedH: Math.floor(elapsed / 60),
      elapsedM: Math.round(elapsed % 60),
      totalH: Math.floor(shiftMins / 60),
      totalCurrentBU: Math.round(totalCurrentBU),
      totalTargetBU: Math.round(totalTargetBU),
    };
  }, [bridge, config, machines, clock]); // clock triggers re-render every second

  // No fleet-average divider — ranking is by raw production now.

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
        <div>
          <h1 className="text-3xl font-black text-white tracking-tight">Production Leaderboard</h1>
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
          TOP ROW: Gauges + Shift Race
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-[1fr_1fr_2fr] gap-4">
        {/* Gauge: Floor Uptime */}
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-6 py-5">
          <Gauge
            value={fleetEff}
            min={0}
            max={100}
            zones={[55, 75]}
            label="Floor Uptime"
            display={fmtPct(fleetEff, 1)}
          />
        </div>

        {/* Gauge: Floor Waste */}
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

        {/* Shift Race */}
        <div className="bg-gray-900/60 border border-gray-800 rounded-2xl px-6 py-5 flex flex-col justify-center gap-4">
          <p className="text-sm text-gray-400 uppercase tracking-wider font-bold text-center">Current Shift</p>

          {shiftRace ? (
            <>
              {/* Elapsed time bar */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-300 flex items-center gap-2">
                    <i className="bi bi-clock text-cyan-400 text-lg"></i>
                    Time Elapsed
                  </span>
                  <span className="text-2xl font-black text-cyan-400 tabular-nums">
                    {shiftRace.shiftPct}%
                  </span>
                </div>
                <div className="h-5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-1000 bg-cyan-500"
                    style={{ width: `${shiftRace.shiftPct}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {shiftRace.elapsedH}h {String(shiftRace.elapsedM).padStart(2, "0")}m / {shiftRace.totalH}h
                </p>
              </div>

              {/* BU output bar */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-gray-300 flex items-center gap-2">
                    <i className="bi bi-box-seam text-green-400 text-lg"></i>
                    BU Output
                  </span>
                  <span className={`text-2xl font-black tabular-nums ${
                    shiftRace.buPct >= shiftRace.shiftPct ? "text-green-400"
                    : shiftRace.buPct >= shiftRace.shiftPct * 0.85 ? "text-yellow-400"
                    : "text-red-400"
                  }`}>
                    {shiftRace.buPct}%
                  </span>
                </div>
                <div className="h-5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-1000 ${shiftRace.buBarColor}`}
                    style={{ width: `${Math.min(100, shiftRace.buPct)}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {shiftRace.totalCurrentBU.toLocaleString()} / {shiftRace.totalTargetBU.toLocaleString()} BU
                </p>
              </div>
            </>
          ) : (
            <p className="text-gray-600 text-center text-sm">Waiting for live data...</p>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          CELL LEADERBOARD
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col gap-3 min-h-0">
        <div className="flex items-center gap-3">
          <i className="bi bi-trophy-fill text-yellow-400 text-2xl"></i>
          <h2 className="text-2xl font-bold text-white">Cell Ranking</h2>
          <span className="text-sm text-gray-500 ml-2">by % of shift target</span>
          {fleetTotalTarget > 0 && (
            <span className={`ml-4 text-sm font-bold tabular-nums ${progressTextColor(fleetPctOfTarget)}`}>
              Fleet: {fmtN(fleetTotalBu, 0)} / {fmtN(fleetTotalTarget, 0)} BU
              <span className="ml-1 text-xs font-medium">({fmtN(fleetPctOfTarget, 0)}%)</span>
            </span>
          )}
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
              // Cap the visual bar at 100 % of the rail; the textual label
              // still shows the true percentage so over-target cells are
              // visible without breaking the layout.
              const fillPct = cell.pctOfTarget != null
                ? Math.min(100, Math.max(0, cell.pctOfTarget))
                : 0;

              return (
                <div key={cell.cellId} className={`flex items-center gap-6 px-6 py-4 rounded-xl border ${rankBg(rank)} transition-colors`}>
                    {/* Rank */}
                    <span className={`flex items-center justify-center w-12 h-12 rounded-full text-xl font-black shrink-0 ${rankBadge(rank)}`}>
                      {rank}
                    </span>

                    {/* Cell name */}
                    <span className="text-2xl font-bold text-white min-w-[140px]">
                      {cell.cellName}
                    </span>

                    {/* Production vs target */}
                    <div className="flex-1 flex items-center gap-3">
                      <div className="flex-1">
                        <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-700 ${progressBarColor(cell.pctOfTarget)}`}
                            style={{ width: `${fillPct}%` }}
                          ></div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end leading-tight min-w-[180px]">
                        <span className="text-3xl font-black tabular-nums text-white">
                          {fmtN(cell.actualBus, 0)}
                          <span className="text-sm text-gray-500 font-medium ml-2">
                            {cell.targetBus > 0 ? `/ ${fmtN(cell.targetBus, 0)} BU` : "BU"}
                          </span>
                        </span>
                        {cell.pctOfTarget != null && (
                          <span className={`text-xs font-bold tabular-nums ${progressTextColor(cell.pctOfTarget)}`}>
                            {fmtN(cell.pctOfTarget, 0)}% of target
                          </span>
                        )}
                      </div>
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
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
