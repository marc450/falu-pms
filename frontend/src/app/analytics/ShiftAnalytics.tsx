"use client";

import { useEffect, useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from "recharts";
import {
  fetchMachineShiftSummary,
} from "@/lib/supabase";
import type { DateRange, RegisteredMachine, MachineShiftRow } from "@/lib/supabase";

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

// ─── Props ────────────────────────────────────────────────────────────────────

interface ShiftAnalyticsProps {
  dateRange: DateRange;
  machines:  RegisteredMachine[];
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function ShiftAnalytics({ dateRange, machines }: ShiftAnalyticsProps) {
  const [rows, setRows]       = useState<MachineShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

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

  // ── Machine code → display name (user-set name, fallback to UID) ──
  const machineNameMap = new Map<string, string>();
  for (const m of machines) machineNameMap.set(m.machine_code, m.name || m.machine_code);
  const displayName = (code: string) => machineNameMap.get(code) ?? code;

  // ── Aggregations ──
  const shiftARows = rows.filter(r => r.shift_label === "A");
  const shiftBRows = rows.filter(r => r.shift_label === "B");

  const shiftAAvgBu   = avgBu(shiftARows);
  const shiftBAvgBu   = avgBu(shiftBRows);

  const avgRunHoursA = shiftARows.length > 0
    ? shiftARows.reduce((s, r) => s + r.run_hours, 0) / shiftARows.length
    : null;
  const avgRunHoursB = shiftBRows.length > 0
    ? shiftBRows.reduce((s, r) => s + r.run_hours, 0) / shiftBRows.length
    : null;

  // ── Bar chart: fleet avg BU per work_day, grouped by shift ──
  const workDays = Array.from(new Set(rows.map(r => r.work_day))).sort();
  const last30Days = workDays.slice(-30);

  const chartData = last30Days.map(day => {
    const dayA = rows.filter(r => r.work_day === day && r.shift_label === "A");
    const dayB = rows.filter(r => r.work_day === day && r.shift_label === "B");
    const buA  = avgBu(dayA);
    const buB  = avgBu(dayB);
    let dateLabel = day;
    try { dateLabel = format(parseISO(day), "dd.MM"); } catch { /* noop */ }
    return { day, dateLabel, buA: buA ?? 0, buB: buB ?? 0 };
  });

  // ── Machine comparison table ──
  const allMachineCodes = Array.from(new Set(rows.map(r => r.machine_code))).sort();
  const machineComparison = allMachineCodes.map(code => {
    const mA = rows.filter(r => r.machine_code === code && r.shift_label === "A");
    const mB = rows.filter(r => r.machine_code === code && r.shift_label === "B");
    const buA = avgBu(mA);
    const buB = avgBu(mB);
    const delta = buA !== null && buB !== null ? buA - buB : null;
    const better = delta === null ? "N/A" : delta > 0.5 ? "A" : delta < -0.5 ? "B" : "Even";
    return { code, buA, buB, delta, better };
  }).sort((a, b) => {
    const avgA = a.buA !== null && a.buB !== null ? (a.buA + a.buB) / 2 : a.buA ?? a.buB ?? 0;
    const avgB = b.buA !== null && b.buB !== null ? (b.buA + b.buB) / 2 : b.buA ?? b.buB ?? 0;
    return avgB - avgA;
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
      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Shift A Fleet Avg BU"
          value={shiftAAvgBu !== null ? shiftAAvgBu.toFixed(1) : "—"}
          sub="Normalized to 12 h shift"
          colorClass={buColor(shiftAAvgBu)}
        />
        <KpiTile
          label="Shift B Fleet Avg BU"
          value={shiftBAvgBu !== null ? shiftBAvgBu.toFixed(1) : "—"}
          sub="Normalized to 12 h shift"
          colorClass={buColor(shiftBAvgBu)}
        />
        <KpiTile
          label="Shift A Avg Run Hours"
          value={avgRunHoursA !== null ? `${avgRunHoursA.toFixed(1)} h` : "—"}
          sub="Per machine per shift"
          colorClass="text-gray-300"
        />
        <KpiTile
          label="Shift B Avg Run Hours"
          value={avgRunHoursB !== null ? `${avgRunHoursB.toFixed(1)} h` : "—"}
          sub="Per machine per shift"
          colorClass="text-gray-300"
        />
      </div>

      {/* Bar chart */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-white">Fleet Avg BU per Day (Shift A vs B)</h3>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: "#22d3ee" }}></span>
              Shift A
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-2 rounded-sm inline-block" style={{ background: "#a78bfa" }}></span>
              Shift B
            </span>
          </div>
        </div>
        {chartData.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-500 text-sm">No data</div>
        ) : (
          <ResponsiveContainer width="100%" height={240}>
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
                  name === "buA" ? "Shift A" : "Shift B",
                ]}
              />
              <Bar dataKey="buA" name="buA" radius={[2, 2, 0, 0]} barSize={10}>
                {chartData.map((d, i) => (
                  <Cell key={`a-${i}`} fill={d.buA > 0 ? barColor(d.buA) : "#374151"} fillOpacity={0.85} />
                ))}
              </Bar>
              <Bar dataKey="buB" name="buB" radius={[2, 2, 0, 0]} barSize={10}>
                {chartData.map((d, i) => (
                  <Cell key={`b-${i}`} fill={d.buB > 0 ? "#a78bfa" : "#374151"} fillOpacity={0.75} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Comparison table */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-white">Machine Shift Comparison</h3>
          <p className="text-xs text-gray-500 mt-0.5">Ranked by avg BU across both shifts</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 bg-gray-900/40">
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-400">Machine</th>
                <th className="text-right  px-4 py-2 text-xs font-semibold text-gray-400">Shift A Avg BU</th>
                <th className="text-right  px-4 py-2 text-xs font-semibold text-gray-400">Shift B Avg BU</th>
                <th className="text-right  px-4 py-2 text-xs font-semibold text-gray-400">Delta (A minus B)</th>
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-400">Better Shift</th>
              </tr>
            </thead>
            <tbody>
              {machineComparison.map(({ code, buA, buB, delta, better }) => (
                <tr key={code} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                  <td className="px-4 py-2 text-xs font-medium text-gray-300 text-center" title={code}>{displayName(code)}</td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${buColor(buA)}`}>
                    {buA !== null ? buA.toFixed(1) : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${buColor(buB)}`}>
                    {buB !== null ? buB.toFixed(1) : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-right font-mono ${
                    delta === null ? "text-gray-600"
                    : delta > 0 ? "text-green-400"
                    : delta < 0 ? "text-red-400"
                    : "text-gray-400"
                  }`}>
                    {delta !== null ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)}` : "—"}
                  </td>
                  <td className={`px-4 py-2 text-xs text-center font-medium ${
                    better === "A" ? "text-cyan-400"
                    : better === "B" ? "text-purple-400"
                    : "text-gray-500"
                  }`}>
                    {better}
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
