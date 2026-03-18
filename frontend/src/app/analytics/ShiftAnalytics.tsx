"use client";

import { useEffect, useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
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

// Colors for first four slots/teams
const SLOT_COLORS = ["#22d3ee", "#a78bfa", "#4ade80", "#fb923c"];

// ─── Props ────────────────────────────────────────────────────────────────────

interface ShiftAnalyticsProps {
  dateRange:        DateRange;
  machines:         RegisteredMachine[];
  shiftSlots:       TimeSlot[];
  shiftAssignments: Record<string, ShiftAssignment>;
}

// ─── KPI tile ─────────────────────────────────────────────────────────────────

function KpiTile({ label, value, sub, colorClass }: {
  label: string; value: string; sub?: string; colorClass: string;
}) {
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-5 py-4 flex flex-col gap-1">
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avgBu(rows: MachineShiftRow[]): number | null {
  const valid = rows.filter(r => r.bu_normalized !== null && r.run_hours > 0);
  if (valid.length === 0) return null;
  const totalHours = valid.reduce((s, r) => s + r.run_hours, 0);
  if (totalHours === 0) return null;
  return valid.reduce((s, r) => s + (r.bu_normalized! * r.run_hours), 0) / totalHours;
}

function buColor(val: number | null): string {
  if (val === null) return "text-gray-500";
  if (val >= BU_TARGET_DEFAULT)   return "text-green-400";
  if (val >= BU_MEDIOCRE_DEFAULT) return "text-yellow-400";
  return "text-red-400";
}

function barColor(val: number): string {
  if (val >= BU_TARGET_DEFAULT)   return "#4ade80";
  if (val >= BU_MEDIOCRE_DEFAULT) return "#eab308";
  return "#ef4444";
}

// ─── Annotated row type ───────────────────────────────────────────────────────

interface AnnotatedRow extends MachineShiftRow {
  crewName: string;   // team name from assignments, e.g. "SHIFT C"
  slotName: string;   // generic slot name, e.g. "Shift A"
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
      const data = await fetchMachineShiftSummary(dateRange);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  // ── Machine code → display name ──
  const machineNameMap = new Map<string, string>();
  for (const m of machines) machineNameMap.set(m.machine_code, m.name || m.machine_code);
  const displayName = (code: string) => machineNameMap.get(code) ?? code;

  // ── Annotate rows with crew name from shift assignments ──
  // crewName: the actual team assigned to that slot on that day (e.g. "SHIFT C")
  // slotName: the generic configured slot name (e.g. "Shift A")
  const annotated: AnnotatedRow[] = rows.map(r => ({
    ...r,
    crewName: teamNameForShift(r.work_day, r.shift_label, shiftAssignments, shiftSlots),
    slotName: shiftLabelToName(r.shift_label, shiftSlots),
  }));

  // ── Available slot labels and crew names in the data ──
  const availableSlots = Array.from(new Set(annotated.map(r => r.shift_label))).sort();
  const availableCrews = Array.from(new Set(annotated.map(r => r.crewName))).sort();

  // ── Pairwise comparison selection ──
  // Default to first two available slots/crews on first load
  const [pick1, setPick1] = useState<string>("");
  const [pick2, setPick2] = useState<string>("");

  // Set defaults when crews are first known
  const pick1Eff = pick1 || availableCrews[0] || "";
  const pick2Eff = pick2 || availableCrews[1] || availableCrews[0] || "";

  // ── Per-crew aggregation: groups ALL shifts a crew worked (any slot, any day) ──
  function crewRows(crewName: string): AnnotatedRow[] {
    return annotated.filter(r => r.crewName === crewName);
  }

  // ── Slot-based overview data ──
  // Groups by slot label (time-window) to show overall slot performance
  const slotOverview = availableSlots.map((label, i) => {
    const slotR = annotated.filter(r => r.shift_label === label);
    return {
      label,
      name:  shiftLabelToName(label, shiftSlots),
      bu:    avgBu(slotR),
      hours: slotR.length > 0 ? slotR.reduce((s, r) => s + r.run_hours, 0) / slotR.length : null,
      color: SLOT_COLORS[i] ?? "#9ca3af",
    };
  });

  // ── Per-day chart data for the two selected crews ──
  const workDays = Array.from(new Set(annotated.map(r => r.work_day))).sort();
  const chartDays = workDays.slice(-30);

  const chartData = chartDays.map(day => {
    const d1 = annotated.filter(r => r.work_day === day && r.crewName === pick1Eff);
    const d2 = annotated.filter(r => r.work_day === day && r.crewName === pick2Eff);
    let dateLabel = day;
    try { dateLabel = format(parseISO(day), "dd.MM"); } catch { /* noop */ }
    return { day, dateLabel, bu1: avgBu(d1) ?? 0, bu2: avgBu(d2) ?? 0 };
  });

  // ── Machine comparison for the two selected crews ──
  const allMachineCodes = Array.from(new Set(annotated.map(r => r.machine_code))).sort();
  const machineComparison = allMachineCodes.map(code => {
    const m1 = annotated.filter(r => r.machine_code === code && r.crewName === pick1Eff);
    const m2 = annotated.filter(r => r.machine_code === code && r.crewName === pick2Eff);
    const bu1 = avgBu(m1);
    const bu2 = avgBu(m2);
    const delta = bu1 !== null && bu2 !== null ? bu1 - bu2 : null;
    const better = delta === null ? "N/A" : delta > 0.5 ? "1" : delta < -0.5 ? "2" : "Even";
    return { code, bu1, bu2, delta, better };
  }).sort((a, b) => {
    const sA = a.bu1 !== null && a.bu2 !== null ? (a.bu1 + a.bu2) / 2 : a.bu1 ?? a.bu2 ?? 0;
    const sB = b.bu1 !== null && b.bu2 !== null ? (b.bu1 + b.bu2) / 2 : b.bu1 ?? b.bu2 ?? 0;
    return sB - sA;
  });

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
        Loading shift data...
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

      {/* ── Slot overview: one KPI tile per time slot ─────────────────────── */}
      <div>
        <p className="text-xs text-gray-500 mb-2 flex items-center gap-1.5">
          <i className="bi bi-clock"></i>
          Overview by time slot
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {slotOverview.map(s => (
            <KpiTile
              key={s.label}
              label={`${s.name} Fleet Avg BU`}
              value={s.bu !== null ? s.bu.toFixed(1) : "—"}
              sub="Normalized to 12 h shift"
              colorClass={buColor(s.bu)}
            />
          ))}
        </div>
      </div>

      {/* ── Crew comparison selector ──────────────────────────────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span className="text-sm font-semibold text-white flex items-center gap-2">
            <i className="bi bi-people-fill text-cyan-400"></i>
            Compare crews
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {/* Crew 1 picker */}
            <select
              value={pick1 || availableCrews[0] || ""}
              onChange={e => setPick1(e.target.value)}
              className="bg-gray-900 border border-cyan-700/60 text-cyan-300 text-xs font-semibold rounded px-2.5 py-1.5 focus:outline-none focus:border-cyan-400"
            >
              {availableCrews.map(c => (
                <option key={c} value={c} className="bg-gray-800 text-white">{c}</option>
              ))}
            </select>
            <span className="text-xs text-gray-500">vs</span>
            {/* Crew 2 picker */}
            <select
              value={pick2 || availableCrews[1] || availableCrews[0] || ""}
              onChange={e => setPick2(e.target.value)}
              className="bg-gray-900 border border-purple-700/60 text-purple-300 text-xs font-semibold rounded px-2.5 py-1.5 focus:outline-none focus:border-purple-400"
            >
              {availableCrews.map(c => (
                <option key={c} value={c} className="bg-gray-800 text-white">{c}</option>
              ))}
            </select>
          </div>
        </div>

        {/* KPI row for the selected two crews */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
          <KpiTile
            label={`${pick1Eff} Fleet Avg BU`}
            value={avgBu(crewRows(pick1Eff))?.toFixed(1) ?? "—"}
            sub="Normalized to 12 h shift"
            colorClass={buColor(avgBu(crewRows(pick1Eff)))}
          />
          <KpiTile
            label={`${pick2Eff} Fleet Avg BU`}
            value={avgBu(crewRows(pick2Eff))?.toFixed(1) ?? "—"}
            sub="Normalized to 12 h shift"
            colorClass={buColor(avgBu(crewRows(pick2Eff)))}
          />
          <KpiTile
            label={`${pick1Eff} Avg Run Hours`}
            value={crewRows(pick1Eff).length > 0
              ? `${(crewRows(pick1Eff).reduce((s, r) => s + r.run_hours, 0) / crewRows(pick1Eff).length).toFixed(1)} h`
              : "—"}
            sub="Per machine per shift"
            colorClass="text-gray-300"
          />
          <KpiTile
            label={`${pick2Eff} Avg Run Hours`}
            value={crewRows(pick2Eff).length > 0
              ? `${(crewRows(pick2Eff).reduce((s, r) => s + r.run_hours, 0) / crewRows(pick2Eff).length).toFixed(1)} h`
              : "—"}
            sub="Per machine per shift"
            colorClass="text-gray-300"
          />
        </div>

        {/* Bar chart: selected two crews over time */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-gray-400">Fleet Avg BU per Day</span>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: "#22d3ee" }}></span>
              {pick1Eff}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: "#a78bfa" }}></span>
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
                  `${Number(v).toFixed(1)} BU`,
                  name === "bu1" ? pick1Eff : pick2Eff,
                ]}
              />
              <Bar dataKey="bu1" name="bu1" radius={[2, 2, 0, 0]} barSize={10}>
                {chartData.map((d, i) => (
                  <Cell key={`1-${i}`} fill={d.bu1 > 0 ? barColor(d.bu1) : "#374151"} fillOpacity={0.85} />
                ))}
              </Bar>
              <Bar dataKey="bu2" name="bu2" radius={[2, 2, 0, 0]} barSize={10}>
                {chartData.map((d, i) => (
                  <Cell key={`2-${i}`} fill={d.bu2 > 0 ? "#a78bfa" : "#374151"} fillOpacity={0.75} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Comparison table */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-white">Machine Crew Comparison</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {pick1Eff} vs {pick2Eff} — ranked by avg BU across both crews
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 bg-gray-900/40">
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-400">Machine</th>
                <th className="text-right  px-4 py-2 text-xs font-semibold text-cyan-400">{pick1Eff} Avg BU</th>
                <th className="text-right  px-4 py-2 text-xs font-semibold text-purple-400">{pick2Eff} Avg BU</th>
                <th className="text-right  px-4 py-2 text-xs font-semibold text-gray-400">
                  Delta ({pick1Eff} − {pick2Eff})
                </th>
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-400">Better</th>
              </tr>
            </thead>
            <tbody>
              {machineComparison.map(({ code, bu1, bu2, delta, better }) => (
                <tr key={code} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                  <td className="px-4 py-2 text-xs font-medium text-gray-300 text-center" title={code}>
                    {displayName(code)}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${buColor(bu1)}`}>
                    {bu1 !== null ? bu1.toFixed(1) : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${buColor(bu2)}`}>
                    {bu2 !== null ? bu2.toFixed(1) : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${
                    delta === null ? "text-gray-600"
                    : delta > 0    ? "text-green-400"
                    : delta < 0    ? "text-red-400"
                    :                "text-gray-400"
                  }`}>
                    {delta !== null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}` : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-center font-medium ${
                    better === "1" ? "text-cyan-400"
                    : better === "2" ? "text-purple-400"
                    : "text-gray-500"
                  }`}>
                    {better === "1" ? pick1Eff : better === "2" ? pick2Eff : better}
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
