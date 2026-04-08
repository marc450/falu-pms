"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { format, parseISO } from "date-fns";
import { fmtN, fmtH, fmtPct } from "@/lib/fmt";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  fetchMachineShiftSummary,
  shiftLabelToName,
  teamNameForShift,
} from "@/lib/supabase";
import type { DateRange, RegisteredMachine, MachineShiftRow, TimeSlot, ShiftAssignment } from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const BU_TARGET_DEFAULT   = 185;
const BU_MEDIOCRE_DEFAULT = 150;

const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "6px",
  fontSize: 12,
  color: "#e5e7eb",
};
const TOOLTIP_LABEL_STYLE = { color: "#9ca3af", marginBottom: 4 };
const TOOLTIP_ITEM_STYLE  = { color: "#e5e7eb", padding: "1px 0" };
const TICK_STYLE          = { fill: "#9ca3af", fontSize: 11 };
const GRID_COLOR          = "#374151";
const AXIS_COLOR          = "#4b5563";

const CREW_COLORS = ["#22d3ee", "#a78bfa", "#4ade80", "#fb923c", "#f472b6", "#facc15"];

type ColorMode = "simple" | "gradient";

// ─── Gradient helper (same as MachineAnalytics) ──────────────────────────────

function lerpHsl(
  t: number,
  stops: Array<{ t: number; h: number; s: number; l: number }>,
): string {
  if (t <= stops[0].t) {
    const s = stops[0];
    return `hsl(${s.h},${s.s}%,${s.l}%)`;
  }
  const last = stops[stops.length - 1];
  if (t >= last.t) return `hsl(${last.h},${last.s}%,${last.l}%)`;
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].t && t <= stops[i + 1].t) {
      const a = stops[i], b = stops[i + 1];
      const f = (t - a.t) / (b.t - a.t);
      return `hsl(${(a.h + f * (b.h - a.h)).toFixed(1)},${(a.s + f * (b.s - a.s)).toFixed(1)}%,${(a.l + f * (b.l - a.l)).toFixed(1)}%)`;
    }
  }
  return `hsl(0,0%,20%)`;
}

const GRADIENT_STOPS = [
  { t: 0.00, h:   4, s: 78, l: 22 },
  { t: 0.20, h:  14, s: 80, l: 27 },
  { t: 0.42, h:  36, s: 75, l: 30 },
  { t: 0.65, h:  72, s: 60, l: 28 },
  { t: 0.85, h: 128, s: 50, l: 28 },
  { t: 1.00, h: 148, s: 55, l: 26 },
];

function rangeGradientBg(val: number, min: number, max: number, invert = false): string {
  const range = max > min ? max - min : 1;
  let t = (val - min) / range;
  if (invert) t = 1 - t;
  return lerpHsl(Math.max(0, Math.min(1, t)), GRADIENT_STOPS);
}

interface CellStyle {
  className: string;
  style?:    React.CSSProperties;
}

function buCellStyle(val: number | null, mode: ColorMode, tMin = 0, tMax = 1): CellStyle {
  if (val === null || val === 0) return { className: "bg-gray-900 text-gray-600" };
  if (mode === "simple") {
    if (val >= BU_TARGET_DEFAULT)   return { className: "bg-green-900/40 text-green-300" };
    if (val >= BU_MEDIOCRE_DEFAULT) return { className: "bg-yellow-900/40 text-yellow-300" };
    return                                 { className: "bg-red-900/40 text-red-300" };
  }
  return { className: "text-white font-medium", style: { backgroundColor: rangeGradientBg(val, tMin, tMax) } };
}

function GradientSwatch({ fn, labelLeft, labelRight }: {
  fn: (t: number) => string;
  labelLeft:  string;
  labelRight: string;
}) {
  const steps = 32;
  const gradient = Array.from({ length: steps }, (_, i) => fn(i / (steps - 1))).join(", ");
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-gray-500 text-xs">{labelLeft}</span>
      <span
        className="w-20 h-3 rounded-sm"
        style={{ background: `linear-gradient(to right, ${gradient})` }}
      />
      <span className="text-gray-500 text-xs">{labelRight}</span>
    </span>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface ShiftAnalyticsProps {
  dateRange:        DateRange;
  machines:         RegisteredMachine[];
  shiftSlots:       TimeSlot[];
  shiftAssignments: Record<string, ShiftAssignment>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface AnnotatedRow extends MachineShiftRow {
  crewName: string;
}

function avgBu(rows: MachineShiftRow[]): number | null {
  const valid = rows.filter(r => r.bu_normalized !== null && r.run_hours != null && r.run_hours > 0);
  if (valid.length === 0) return null;
  const totalHours = valid.reduce((s, r) => s + r.run_hours!, 0);
  if (totalHours === 0) return null;
  return valid.reduce((s, r) => s + (r.bu_normalized! * r.run_hours!), 0) / totalHours;
}

function avgField(rows: MachineShiftRow[], field: "run_hours" | "avg_efficiency" | "avg_scrap"): number | null {
  const valid = rows.filter(r => r[field] != null && r[field]! > 0);
  if (valid.length === 0) return null;
  return valid.reduce((s, r) => s + r[field]!, 0) / valid.length;
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Simple linear regression slope (BU per day) */
function trendSlope(points: { x: number; y: number }[]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const sumX  = points.reduce((s, p) => s + p.x, 0);
  const sumY  = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return null;
  return (n * sumXY - sumX * sumY) / denom;
}

function buColor(val: number | null): string {
  if (val === null) return "text-gray-500";
  if (val >= BU_TARGET_DEFAULT)   return "text-green-400";
  if (val >= BU_MEDIOCRE_DEFAULT) return "text-yellow-400";
  return "text-red-400";
}

// ─── Crew Scorecard ──────────────────────────────────────────────────────────

interface CrewStats {
  name:       string;
  color:      string;
  avgBu:      number | null;
  avgRun:     number | null;
  avgEff:     number | null;
  avgScrap:   number | null;
  shiftCount: number;
}

const RANK_BORDER = [
  "border-yellow-500/70 ring-1 ring-yellow-500/30",   // #1 gold
  "border-gray-400/50 ring-1 ring-gray-400/20",       // #2 silver
  "border-amber-600/50 ring-1 ring-amber-600/20",     // #3 bronze
];
const RANK_BADGE = [
  "text-yellow-400 bg-yellow-500/20 border border-yellow-500/40",
  "text-gray-300 bg-gray-400/20 border border-gray-400/40",
  "text-amber-500 bg-amber-600/20 border border-amber-600/40",
];

function CrewCard({ crew, rank }: { crew: CrewStats; rank: number }) {
  const border = RANK_BORDER[rank - 1] ?? "border-gray-700";
  const badge = RANK_BADGE[rank - 1] ?? "text-gray-500 bg-gray-600/20 border border-gray-600/40";
  return (
    <div className={`bg-gray-800/50 border rounded-lg px-4 py-4 flex flex-col gap-2 ${border}`}>
      <div className="flex items-center gap-2">
        <span className={`w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center text-sm font-extrabold ${badge}`}>
          {rank}
        </span>
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: crew.color }}></span>
        <span className="text-sm font-bold text-white">{crew.name}</span>
        <span className="ml-auto text-[10px] text-gray-500">{crew.shiftCount} shifts</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-1">
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Avg BU</div>
          <div className={`text-lg font-bold ${buColor(crew.avgBu)}`}>{fmtN(crew.avgBu, 1)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Avg Scrap</div>
          <div className="text-sm text-gray-300">{fmtPct(crew.avgScrap, 1)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Avg Run</div>
          <div className="text-sm text-gray-300">{fmtH(crew.avgRun, 1)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Avg Eff</div>
          <div className="text-sm text-gray-300">{fmtPct(crew.avgEff, 1)}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ShiftAnalytics({
  dateRange, machines, shiftSlots, shiftAssignments,
}: ShiftAnalyticsProps) {
  const [rows,    setRows]    = useState<MachineShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("gradient");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMachineShiftSummary(dateRange, shiftSlots);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  // ── Machine code → display name ──
  const machineNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const mc of machines) m.set(mc.machine_code, mc.name || mc.machine_code);
    return m;
  }, [machines]);
  const displayName = (code: string) => machineNameMap.get(code) ?? code;

  // ── Annotate rows with crew name from shift assignments ──
  const annotated: AnnotatedRow[] = useMemo(() => rows.map(r => ({
    ...r,
    crewName: teamNameForShift(r.work_day, r.shift_label, shiftAssignments, shiftSlots),
  })), [rows, shiftAssignments, shiftSlots]);

  // ── Crew list (from configured teams, filtered to those with data) ──
  const crewsInData = useMemo(() => {
    const dataCrews = new Set(annotated.map(r => r.crewName));
    // Return only crews that actually have data, ordered by config
    return Array.from(dataCrews).sort();
  }, [annotated]);

  // ── Per-crew stats ──
  const crewStats: CrewStats[] = useMemo(() => {
    return crewsInData.map((name, i) => {
      const crewR = annotated.filter(r => r.crewName === name);

      // Count "shifts" as unique (work_day, shift_label) combos
      const shiftKeys = new Set(crewR.map(r => `${r.work_day}|${r.shift_label}`));
      const shiftCount = shiftKeys.size;

      return {
        name,
        color: CREW_COLORS[i % CREW_COLORS.length],
        avgBu: avgBu(crewR),
        avgRun: avgField(crewR, "run_hours"),
        avgEff: avgField(crewR, "avg_efficiency"),
        avgScrap: avgField(crewR, "avg_scrap"),
        shiftCount,
      };
    });
  }, [crewsInData, annotated]);

  // ── Crew color map ──
  const crewColorMap = useMemo(() => {
    const m = new Map<string, string>();
    crewStats.forEach(c => m.set(c.name, c.color));
    return m;
  }, [crewStats]);

  // ── Per-day chart data for ALL crews (only on-duty days) ──
  const chartData = useMemo(() => {
    const workDays = Array.from(new Set(annotated.map(r => r.work_day))).sort();
    const days = workDays.slice(-30);
    return days.map(day => {
      let dateLabel = day;
      try { dateLabel = format(parseISO(day), "dd.MM"); } catch { /* noop */ }
      const entry: Record<string, string | number | undefined> = { day, dateLabel };
      for (const crew of crewsInData) {
        const crewRows = annotated.filter(r => r.work_day === day && r.crewName === crew);
        // Only include a value when the crew actually worked that day
        const bu = avgBu(crewRows);
        entry[crew] = bu !== null ? bu : undefined;
      }
      return entry;
    });
  }, [annotated, crewsInData]);

  // ── Per-machine comparison for ALL crews ──
  const machineComparison = useMemo(() => {
    const allCodes = Array.from(new Set(annotated.map(r => r.machine_code))).sort();
    return allCodes.map(code => {
      const perCrew: Record<string, { bu: number | null; std: number | null }> = {};
      let totalBu = 0;
      let buCount = 0;
      for (const crew of crewsInData) {
        const mRows = annotated.filter(r => r.machine_code === code && r.crewName === crew);
        const bu = avgBu(mRows);
        const buVals = mRows.filter(r => r.bu_normalized !== null).map(r => r.bu_normalized!);
        perCrew[crew] = { bu, std: stdDev(buVals) };
        if (bu !== null) { totalBu += bu; buCount++; }
      }
      const avgAll = buCount > 0 ? totalBu / buCount : 0;
      // Find best crew for this machine
      let bestCrew: string | null = null;
      let bestBu = -Infinity;
      for (const crew of crewsInData) {
        const bu = perCrew[crew]?.bu;
        if (bu !== null && bu !== undefined && bu > bestBu) { bestBu = bu; bestCrew = crew; }
      }
      return { code, perCrew, avgAll, bestCrew };
    }).sort((a, b) => b.avgAll - a.avgAll);
  }, [annotated, crewsInData]);

  // ── Table BU min/max for gradient scaling ──
  const tableBuRange = useMemo(() => {
    const allBu = machineComparison.flatMap(m =>
      Object.values(m.perCrew).map(d => d.bu).filter((v): v is number => v !== null && v > 0)
    );
    return { min: allBu.length > 0 ? Math.min(...allBu) : 0, max: allBu.length > 0 ? Math.max(...allBu) : 1 };
  }, [machineComparison]);

  // ── Per-crew trend (slope + consistency) ──
  const crewTrends = useMemo(() => {
    return crewStats.map(c => {
      // Get daily BU values for this crew
      const dailyBu: { x: number; y: number }[] = [];
      const workDays = Array.from(new Set(annotated.filter(r => r.crewName === c.name).map(r => r.work_day))).sort();
      workDays.forEach((day, i) => {
        const dayRows = annotated.filter(r => r.work_day === day && r.crewName === c.name);
        const bu = avgBu(dayRows);
        if (bu !== null) dailyBu.push({ x: i, y: bu });
      });
      const slope = trendSlope(dailyBu);
      const buValues = dailyBu.map(p => p.y);
      const std = stdDev(buValues);
      const minBu = buValues.length > 0 ? Math.min(...buValues) : null;
      const maxBu = buValues.length > 0 ? Math.max(...buValues) : null;
      return { name: c.name, color: c.color, slope, std, minBu, maxBu, days: buValues.length };
    });
  }, [crewStats, annotated]);

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
        Loading crew data...
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

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <i className="bi bi-inbox text-3xl text-gray-600"></i>
        <p className="text-sm text-gray-500">No shift data for this period</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">

      {/* ═══════════════════════════════════════════════════════════════════
          SECTION 1: CREW SCORECARD
          ═══════════════════════════════════════════════════════════════════ */}
      <div>
        <p className="text-xs text-gray-500 mb-2 flex items-center gap-1.5">
          <i className="bi bi-trophy"></i>
          Crew Scorecard
        </p>
        <div className={`grid gap-3 ${
          crewStats.length <= 2 ? "grid-cols-2" :
          crewStats.length === 3 ? "grid-cols-3" :
          "grid-cols-2 sm:grid-cols-4"
        }`}>
          {crewStats
            .slice()
            .sort((a, b) => (b.avgBu ?? 0) - (a.avgBu ?? 0))
            .map((crew, i) => (
              <CrewCard key={crew.name} crew={crew} rank={i + 1} />
            ))
          }
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SECTION 2: CREW BU TREND
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold text-white flex items-center gap-2">
            BU Trend
          </span>
          <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap justify-end">
            {crewStats.map(c => (
              <span key={c.name} className="flex items-center gap-1.5">
                <span className="w-3 h-2 rounded-sm inline-block" style={{ background: c.color }}></span>
                {c.name}
              </span>
            ))}
          </div>
        </div>

        {/* Line chart */}
        {chartData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">No data</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
              <ReferenceLine y={BU_TARGET_DEFAULT}   stroke="#4ade80" strokeDasharray="6 3" strokeOpacity={0.5} label={{ value: "Target", position: "right", fill: "#4ade80", fontSize: 10 }} />
              <ReferenceLine y={BU_MEDIOCRE_DEFAULT} stroke="#eab308" strokeDasharray="6 3" strokeOpacity={0.35} />
              <XAxis
                dataKey="dateLabel"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={{ stroke: AXIS_COLOR }}
                interval={chartData.length > 14 ? Math.ceil(chartData.length / 14) - 1 : 0}
              />
              <YAxis
                domain={[100, "auto"]}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => String(v)}
              />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(v: any, name: any) => [`${fmtN(Number(v), 1)} BU`, name]}
              />
              {crewStats.map(c => (
                <Line
                  key={c.name}
                  type="monotone"
                  dataKey={c.name}
                  name={c.name}
                  stroke={c.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  connectNulls={true}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}

        {/* Trend summary row */}
        <div className={`grid gap-3 mt-4 ${
          crewTrends.length <= 2 ? "grid-cols-2" :
          crewTrends.length === 3 ? "grid-cols-3" :
          "grid-cols-2 sm:grid-cols-4"
        }`}>
          {crewTrends.map(t => {
            const trendLabel = t.slope === null ? "N/A"
              : t.slope > 0.3 ? "Improving"
              : t.slope < -0.3 ? "Declining"
              : "Stable";
            const trendColor = t.slope === null ? "text-gray-500"
              : t.slope > 0.3 ? "text-green-400"
              : t.slope < -0.3 ? "text-red-400"
              : "text-gray-400";
            const trendIcon = t.slope === null ? "bi-dash"
              : t.slope > 0.3 ? "bi-arrow-up-right"
              : t.slope < -0.3 ? "bi-arrow-down-right"
              : "bi-arrow-right";
            return (
              <div key={t.name} className="bg-gray-900/40 rounded-lg px-3 py-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: t.color }}></span>
                  <span className="text-xs font-semibold text-white">{t.name}</span>
                </div>
                <div className="flex items-center gap-2 mb-1.5">
                  <i className={`bi ${trendIcon} ${trendColor}`}></i>
                  <span className={`text-sm font-bold ${trendColor}`}>{trendLabel}</span>
                  {t.slope !== null && (
                    <span className="text-[10px] text-gray-500">
                      ({t.slope > 0 ? "+" : ""}{fmtN(t.slope, 2)} BU/day)
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <span>Range: {fmtN(t.minBu, 0)}{"\u2013"}{fmtN(t.maxBu, 0)} BU</span>
                  <span>±{fmtN(t.std, 1)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SECTION 3: PER-MACHINE BREAKDOWN (ALL CREWS)
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-white">Per Machine Breakdown</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              All crews ranked by avg BU
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Color mode toggle */}
            <div className="flex rounded-md overflow-hidden border border-gray-600">
              <button
                onClick={() => setColorMode("simple")}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  colorMode === "simple" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                Target
              </button>
              <button
                onClick={() => setColorMode("gradient")}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  colorMode === "gradient" ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                Gradient
              </button>
            </div>
            {/* Legend */}
            {colorMode === "simple" ? (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-900/60"></span><span className="text-gray-500">&ge; {BU_TARGET_DEFAULT} BU</span></span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-yellow-900/60"></span><span className="text-gray-500">&ge; {BU_MEDIOCRE_DEFAULT} BU</span></span>
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-900/60"></span><span className="text-gray-500">&lt; {BU_MEDIOCRE_DEFAULT} BU</span></span>
              </div>
            ) : (
              <GradientSwatch
                fn={(t) => lerpHsl(t, GRADIENT_STOPS)}
                labelLeft={fmtN(tableBuRange.min, 0)}
                labelRight={fmtN(tableBuRange.max, 0)}
              />
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 bg-gray-900/40">
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-400">Machine</th>
                {crewStats.slice().sort((a, b) => (b.avgBu ?? 0) - (a.avgBu ?? 0)).map(c => (
                  <th key={c.name} className="text-center px-3 py-2 text-xs font-semibold" style={{ color: c.color }}>
                    {c.name}
                  </th>
                ))}
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-400">Best</th>
              </tr>
            </thead>
            <tbody>
              {machineComparison.map(({ code, perCrew, bestCrew: best }) => (
                <tr key={code} className="border-b border-gray-700/50">
                  <td className="px-4 py-2 text-xs font-medium text-gray-300 text-center" title={code}>
                    {displayName(code)}
                  </td>
                  {crewStats.slice().sort((a, b) => (b.avgBu ?? 0) - (a.avgBu ?? 0)).map(c => {
                    const data = perCrew[c.name];
                    const bu = data?.bu ?? null;
                    const cs = buCellStyle(bu, colorMode, tableBuRange.min, tableBuRange.max);
                    return (
                      <td key={c.name} className={`px-3 py-1.5 text-center text-xs font-mono ${cs.className}`} style={cs.style}>
                        {fmtN(bu, 1)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-xs text-center font-medium">
                    {best ? (
                      <span style={{ color: crewColorMap.get(best) ?? "#9ca3af" }}>{best}</span>
                    ) : (
                      <span className="text-gray-500">N/A</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
