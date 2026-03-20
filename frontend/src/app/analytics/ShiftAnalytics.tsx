"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { format, parseISO } from "date-fns";
import { fmtN, fmtH, fmtPct } from "@/lib/fmt";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine, Legend,
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
  winRate:    number | null;  // % of shifts beating fleet avg
}

function CrewCard({ crew, isBest }: { crew: CrewStats; isBest: boolean }) {
  return (
    <div className={`relative bg-gray-800/50 border rounded-lg px-4 py-4 flex flex-col gap-2 ${
      isBest ? "border-yellow-500/60 ring-1 ring-yellow-500/20" : "border-gray-700"
    }`}>
      {isBest && (
        <span className="absolute -top-2.5 right-3 bg-yellow-500/20 text-yellow-400 text-[10px] font-bold px-2 py-0.5 rounded-full border border-yellow-500/30 uppercase tracking-wider">
          Top Crew
        </span>
      )}
      <div className="flex items-center gap-2">
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
          <div className="text-[10px] text-gray-500 uppercase tracking-wide">Win Rate</div>
          <div className="text-lg font-bold text-gray-200">{crew.winRate !== null ? fmtPct(crew.winRate, 0) : "—"}</div>
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

  // ── Fleet avg BU (for win rate calculation) ──
  const fleetAvgBu = useMemo(() => avgBu(annotated), [annotated]);

  // ── Per-crew stats ──
  const crewStats: CrewStats[] = useMemo(() => {
    return crewsInData.map((name, i) => {
      const crewR = annotated.filter(r => r.crewName === name);

      // Count "shifts" as unique (work_day, shift_label) combos
      const shiftKeys = new Set(crewR.map(r => `${r.work_day}|${r.shift_label}`));
      const shiftCount = shiftKeys.size;

      // Win rate: % of shift-days where crew avg BU > fleet avg
      let wins = 0;
      let counted = 0;
      if (fleetAvgBu !== null) {
        for (const sk of shiftKeys) {
          const [wd, sl] = sk.split("|");
          const shiftR = crewR.filter(r => r.work_day === wd && r.shift_label === sl);
          const shiftBu = avgBu(shiftR);
          if (shiftBu !== null) {
            counted++;
            if (shiftBu >= fleetAvgBu) wins++;
          }
        }
      }

      return {
        name,
        color: CREW_COLORS[i % CREW_COLORS.length],
        avgBu: avgBu(crewR),
        avgRun: avgField(crewR, "run_hours"),
        avgEff: avgField(crewR, "avg_efficiency"),
        avgScrap: avgField(crewR, "avg_scrap"),
        shiftCount,
        winRate: counted > 0 ? (wins / counted) * 100 : null,
      };
    });
  }, [crewsInData, annotated, fleetAvgBu]);

  // ── Best crew ──
  const bestCrew = useMemo(() => {
    let best: string | null = null;
    let bestVal = -Infinity;
    for (const c of crewStats) {
      if (c.avgBu !== null && c.avgBu > bestVal) {
        bestVal = c.avgBu;
        best = c.name;
      }
    }
    return best;
  }, [crewStats]);

  // ── Crew color map ──
  const crewColorMap = useMemo(() => {
    const m = new Map<string, string>();
    crewStats.forEach(c => m.set(c.name, c.color));
    return m;
  }, [crewStats]);

  // ── Pairwise comparison selection ──
  const [pick1, setPick1] = useState<string>("");
  const [pick2, setPick2] = useState<string>("");
  const pick1Eff = pick1 || crewsInData[0] || "";
  const pick2Eff = pick2 || crewsInData[1] || crewsInData[0] || "";

  const crew1Color = crewColorMap.get(pick1Eff) ?? "#22d3ee";
  const crew2Color = crewColorMap.get(pick2Eff) ?? "#a78bfa";

  // ── Per-day chart data for two selected crews ──
  const chartData = useMemo(() => {
    const workDays = Array.from(new Set(annotated.map(r => r.work_day))).sort();
    const days = workDays.slice(-30);
    return days.map(day => {
      const d1 = annotated.filter(r => r.work_day === day && r.crewName === pick1Eff);
      const d2 = annotated.filter(r => r.work_day === day && r.crewName === pick2Eff);
      let dateLabel = day;
      try { dateLabel = format(parseISO(day), "dd.MM"); } catch { /* noop */ }
      return { day, dateLabel, bu1: avgBu(d1) ?? 0, bu2: avgBu(d2) ?? 0 };
    });
  }, [annotated, pick1Eff, pick2Eff]);

  // ── Verdict ──
  const verdict = useMemo(() => {
    const c1Rows = annotated.filter(r => r.crewName === pick1Eff);
    const c2Rows = annotated.filter(r => r.crewName === pick2Eff);
    const bu1 = avgBu(c1Rows);
    const bu2 = avgBu(c2Rows);
    if (bu1 === null || bu2 === null) return null;
    const diff = bu1 - bu2;
    if (Math.abs(diff) < 0.5) return { text: "Virtually tied", leader: null, diff: 0 };
    const leader = diff > 0 ? pick1Eff : pick2Eff;
    return { text: `${leader} leads by +${fmtN(Math.abs(diff), 1)} BU`, leader, diff: Math.abs(diff) };
  }, [annotated, pick1Eff, pick2Eff]);

  // ── Machine comparison for two selected crews ──
  const machineComparison = useMemo(() => {
    const allCodes = Array.from(new Set(annotated.map(r => r.machine_code))).sort();
    return allCodes.map(code => {
      const m1 = annotated.filter(r => r.machine_code === code && r.crewName === pick1Eff);
      const m2 = annotated.filter(r => r.machine_code === code && r.crewName === pick2Eff);
      const bu1 = avgBu(m1);
      const bu2 = avgBu(m2);
      const delta = bu1 !== null && bu2 !== null ? bu1 - bu2 : null;
      const better = delta === null ? "N/A" : delta > 0.5 ? "1" : delta < -0.5 ? "2" : "Even";

      // Consistency: std dev of BU values per shift for each crew
      const buVals1 = m1.filter(r => r.bu_normalized !== null).map(r => r.bu_normalized!);
      const buVals2 = m2.filter(r => r.bu_normalized !== null).map(r => r.bu_normalized!);

      return { code, bu1, bu2, delta, better, std1: stdDev(buVals1), std2: stdDev(buVals2) };
    }).sort((a, b) => {
      const sA = a.bu1 !== null && a.bu2 !== null ? (a.bu1 + a.bu2) / 2 : a.bu1 ?? a.bu2 ?? 0;
      const sB = b.bu1 !== null && b.bu2 !== null ? (b.bu1 + b.bu2) / 2 : b.bu1 ?? b.bu2 ?? 0;
      return sB - sA;
    });
  }, [annotated, pick1Eff, pick2Eff]);

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
            .map(crew => (
              <CrewCard key={crew.name} crew={crew} isBest={crew.name === bestCrew} />
            ))
          }
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SECTION 2: HEAD-TO-HEAD COMPARISON
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        {/* Picker row */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="bi bi-people-fill text-cyan-400"></i>
            Head to Head
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <select
              value={pick1Eff}
              onChange={e => setPick1(e.target.value)}
              className="bg-gray-900 border text-xs font-semibold rounded px-2.5 py-1.5 focus:outline-none"
              style={{ borderColor: crew1Color + "99", color: crew1Color }}
            >
              {crewsInData.map(c => (
                <option key={c} value={c} className="bg-gray-800 text-white">{c}</option>
              ))}
            </select>
            <span className="text-xs text-gray-500 font-medium">vs</span>
            <select
              value={pick2Eff}
              onChange={e => setPick2(e.target.value)}
              className="bg-gray-900 border text-xs font-semibold rounded px-2.5 py-1.5 focus:outline-none"
              style={{ borderColor: crew2Color + "99", color: crew2Color }}
            >
              {crewsInData.map(c => (
                <option key={c} value={c} className="bg-gray-800 text-white">{c}</option>
              ))}
            </select>
          </div>
        </div>

        {/* KPI comparison row */}
        {(() => {
          const c1 = annotated.filter(r => r.crewName === pick1Eff);
          const c2 = annotated.filter(r => r.crewName === pick2Eff);
          const kpis = [
            { label: "Avg BU", v1: avgBu(c1), v2: avgBu(c2), fmt: (v: number | null) => fmtN(v, 1), colorFn: buColor },
            { label: "Avg Run", v1: avgField(c1, "run_hours"), v2: avgField(c2, "run_hours"), fmt: (v: number | null) => fmtH(v, 1), colorFn: () => "text-gray-200" },
            { label: "Avg Eff", v1: avgField(c1, "avg_efficiency"), v2: avgField(c2, "avg_efficiency"), fmt: (v: number | null) => fmtPct(v, 1), colorFn: () => "text-gray-200" },
            { label: "Avg Scrap", v1: avgField(c1, "avg_scrap"), v2: avgField(c2, "avg_scrap"), fmt: (v: number | null) => fmtPct(v, 1), colorFn: () => "text-gray-200" },
          ];
          return (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {kpis.map(k => {
                const better = k.label === "Avg Scrap"
                  ? (k.v1 !== null && k.v2 !== null ? (k.v1 < k.v2 ? 1 : k.v1 > k.v2 ? 2 : 0) : 0)
                  : (k.v1 !== null && k.v2 !== null ? (k.v1 > k.v2 ? 1 : k.v1 < k.v2 ? 2 : 0) : 0);
                return (
                  <div key={k.label} className="bg-gray-900/40 rounded-lg px-3 py-3">
                    <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-2">{k.label}</div>
                    <div className="flex items-end justify-between gap-2">
                      <div>
                        <div className={`text-base font-bold ${k.colorFn(k.v1)}`} style={better === 1 ? { textDecoration: "underline", textDecorationColor: crew1Color, textUnderlineOffset: "3px" } : {}}>
                          {k.fmt(k.v1)}
                        </div>
                        <div className="text-[10px] mt-0.5" style={{ color: crew1Color }}>{pick1Eff}</div>
                      </div>
                      <div className="text-gray-600 text-xs pb-1">vs</div>
                      <div className="text-right">
                        <div className={`text-base font-bold ${k.colorFn(k.v2)}`} style={better === 2 ? { textDecoration: "underline", textDecorationColor: crew2Color, textUnderlineOffset: "3px" } : {}}>
                          {k.fmt(k.v2)}
                        </div>
                        <div className="text-[10px] mt-0.5 text-right" style={{ color: crew2Color }}>{pick2Eff}</div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Verdict badge */}
        {verdict && (
          <div className={`text-center text-xs font-medium py-1.5 px-3 rounded-full w-fit mx-auto mb-4 ${
            verdict.leader ? "bg-gray-700/60 text-gray-200" : "bg-gray-700/40 text-gray-400"
          }`}>
            {verdict.leader && (
              <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: crewColorMap.get(verdict.leader) ?? "#9ca3af" }}></span>
            )}
            {verdict.text}
          </div>
        )}

        {/* Bar chart */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-gray-400">Fleet Avg BU per Day</span>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: crew1Color }}></span>
              {pick1Eff}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: crew2Color }}></span>
              {pick2Eff}
            </span>
          </div>
        </div>
        {chartData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">No data</div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 16 }} barCategoryGap="25%">
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
              <ReferenceLine y={BU_TARGET_DEFAULT}   stroke="#4ade80" strokeDasharray="6 3" strokeOpacity={0.5} />
              <ReferenceLine y={BU_MEDIOCRE_DEFAULT} stroke="#eab308" strokeDasharray="6 3" strokeOpacity={0.35} />
              <XAxis
                dataKey="dateLabel"
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={{ stroke: AXIS_COLOR }}
                interval={chartData.length > 14 ? Math.ceil(chartData.length / 14) - 1 : 0}
              />
              <YAxis
                domain={[0, "auto"]}
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
                formatter={(v: any, name: any) => [
                  `${fmtN(Number(v), 1)} BU`,
                  name === "bu1" ? pick1Eff : pick2Eff,
                ]}
              />
              <Bar dataKey="bu1" name="bu1" radius={[2, 2, 0, 0]} barSize={10}>
                {chartData.map((d, i) => (
                  <Cell key={`1-${i}`} fill={d.bu1 > 0 ? crew1Color : "#374151"} fillOpacity={0.85} />
                ))}
              </Bar>
              <Bar dataKey="bu2" name="bu2" radius={[2, 2, 0, 0]} barSize={10}>
                {chartData.map((d, i) => (
                  <Cell key={`2-${i}`} fill={d.bu2 > 0 ? crew2Color : "#374151"} fillOpacity={0.75} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          SECTION 3: PER-MACHINE BREAKDOWN
          ═══════════════════════════════════════════════════════════════════ */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-white">Per-Machine Breakdown</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {pick1Eff} vs {pick2Eff} — ranked by avg BU, with consistency (lower = more consistent)
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 bg-gray-900/40">
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-400">Machine</th>
                <th className="text-right px-4 py-2 text-xs font-semibold" style={{ color: crew1Color }}>{pick1Eff} BU</th>
                <th className="text-right px-3 py-2 text-[10px] font-medium text-gray-500">Consistency</th>
                <th className="text-right px-4 py-2 text-xs font-semibold" style={{ color: crew2Color }}>{pick2Eff} BU</th>
                <th className="text-right px-3 py-2 text-[10px] font-medium text-gray-500">Consistency</th>
                <th className="text-right px-4 py-2 text-xs font-semibold text-gray-400">Delta</th>
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-400">Better</th>
              </tr>
            </thead>
            <tbody>
              {machineComparison.map(({ code, bu1, bu2, delta, better, std1, std2 }) => (
                <tr key={code} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                  <td className="px-4 py-2 text-xs font-medium text-gray-300 text-center" title={code}>
                    {displayName(code)}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${buColor(bu1)}`}>
                    {fmtN(bu1, 1)}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-right font-mono text-gray-500">
                    {std1 !== null ? `±${fmtN(std1, 1)}` : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${buColor(bu2)}`}>
                    {fmtN(bu2, 1)}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-right font-mono text-gray-500">
                    {std2 !== null ? `±${fmtN(std2, 1)}` : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${
                    delta === null ? "text-gray-600"
                    : delta > 0    ? "text-green-400"
                    : delta < 0    ? "text-red-400"
                    :                "text-gray-400"
                  }`}>
                    {delta !== null ? `${delta > 0 ? "+" : ""}${fmtN(delta, 1)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-center font-medium">
                    {better === "1"
                      ? <span style={{ color: crew1Color }}>{pick1Eff}</span>
                      : better === "2"
                      ? <span style={{ color: crew2Color }}>{pick2Eff}</span>
                      : <span className="text-gray-500">{better}</span>
                    }
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
