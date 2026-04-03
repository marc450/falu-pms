"use client";

import { useEffect, useState, useCallback, useMemo, Fragment, useRef } from "react";
import { parseISO } from "date-fns";
import { fmtN } from "@/lib/fmt";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Line, ComposedChart, Area, AreaChart,
  Legend,
} from "recharts";
import {
  fetchErrorShiftSummary,
  fetchErrorCodeLookup,
  teamNameForShift,
} from "@/lib/supabase";
import type {
  DateRange, RegisteredMachine, ErrorShiftSummaryRow,
  PlcErrorCode, TimeSlot, ShiftAssignment,
} from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const GRID_COLOR  = "#374151";
const AXIS_COLOR  = "#4b5563";
const TICK_STYLE  = { fill: "#9ca3af", fontSize: 11 };
const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "6px",
  fontSize: 12,
  color: "#e5e7eb",
};
const TOOLTIP_LABEL_STYLE = { color: "#9ca3af", marginBottom: 4 };

// Top N error codes to show individually; rest grouped as "Other"
const TOP_N = 8;

// Color palette for stacked area chart
const AREA_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#6b7280",
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface DowntimeAnalyticsProps {
  dateRange:        DateRange;
  machines:         RegisteredMachine[];
  shiftSlots:       TimeSlot[];
  shiftAssignments: Record<string, ShiftAssignment>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function secsToHours(s: number): number { return s / 3600; }
function secsToMin(s: number): number { return s / 60; }

function fmtDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDateShort(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}. ${MONTH_ABBR[d.getMonth()]}`;
}

// ─── Machine filter dropdown (styled like date picker) ────────────────────────

function MachineFilterDropdown({ value, onChange, machinesWithErrors, machines }: {
  value: string;
  onChange: (v: string) => void;
  machinesWithErrors: string[];
  machines: RegisteredMachine[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const label = value === "all"
    ? "All machines"
    : machines.find(m => m.machine_code === value)?.name ?? value;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
      >
        <i className="bi bi-pc-display text-xs text-gray-500"></i>
        {label}
        <i className={`bi bi-chevron-${open ? "up" : "down"} text-xs text-gray-500`}></i>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden py-2 min-w-[180px] w-fit max-h-[400px] overflow-y-auto">
          <button
            onClick={() => { onChange("all"); setOpen(false); }}
            className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${
              value === "all"
                ? "text-cyan-400 bg-cyan-950/50"
                : "text-gray-400 hover:text-white hover:bg-gray-800"
            }`}
          >
            All machines
          </button>
          {machinesWithErrors.map(mc => {
            const reg = machines.find(m => m.machine_code === mc);
            return (
              <button
                key={mc}
                onClick={() => { onChange(mc); setOpen(false); }}
                className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${
                  value === mc
                    ? "text-cyan-400 bg-cyan-950/50"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
              >
                {reg?.name ?? mc}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DowntimeAnalytics({ dateRange, machines, shiftSlots, shiftAssignments }: DowntimeAnalyticsProps) {
  const [rows, setRows]           = useState<ErrorShiftSummaryRow[]>([]);
  const [lookup, setLookup]       = useState<Record<string, PlcErrorCode>>({});
  const [loading, setLoading]     = useState(true);
  const [machineFilter, setMachineFilter] = useState<string>("all");

  const load = useCallback(async () => {
    setLoading(true);
    const [summaryData, lookupData] = await Promise.all([
      fetchErrorShiftSummary(dateRange),
      fetchErrorCodeLookup(),
    ]);
    setRows(summaryData);
    setLookup(lookupData);
    setLoading(false);
  }, [dateRange]);

  useEffect(() => { load(); }, [load]);

  // Filter by machine
  const filtered = useMemo(() => {
    if (machineFilter === "all") return rows;
    return rows.filter(r => r.machine_code === machineFilter);
  }, [rows, machineFilter]);

  // Unique machines that have error data, sorted naturally by display name
  const machinesWithErrors = useMemo(() => {
    const codes = new Set(rows.map(r => r.machine_code));
    return Array.from(codes).sort((a, b) => {
      const nameA = machines.find(m => m.machine_code === a)?.name ?? a;
      const nameB = machines.find(m => m.machine_code === b)?.name ?? b;
      return nameA.localeCompare(nameB, undefined, { numeric: true });
    });
  }, [rows, machines]);

  // ─── 1. Pareto data: error codes ranked by total downtime ────────────────

  const paretoData = useMemo(() => {
    const byCode: Record<string, { code: string; totalSecs: number; totalOccurrences: number; machines: Set<string> }> = {};
    for (const r of filtered) {
      if (!byCode[r.error_code]) byCode[r.error_code] = { code: r.error_code, totalSecs: 0, totalOccurrences: 0, machines: new Set() };
      byCode[r.error_code].totalSecs += r.total_duration_secs;
      byCode[r.error_code].totalOccurrences += r.occurrence_count;
      byCode[r.error_code].machines.add(r.machine_code);
    }
    const sorted = Object.values(byCode).sort((a, b) => b.totalSecs - a.totalSecs);
    const grandTotal = sorted.reduce((s, r) => s + r.totalSecs, 0);
    let cumulative = 0;
    return sorted.map(r => {
      cumulative += r.totalSecs;
      return {
        code: r.code,
        label: lookup[r.code] ? `${r.code} ${lookup[r.code].description}` : r.code,
        shortLabel: r.code,
        description: lookup[r.code]?.description ?? "",
        totalHours: secsToHours(r.totalSecs),
        totalSecs: r.totalSecs,
        totalOccurrences: r.totalOccurrences,
        machineCount: r.machines.size,
        cumulativePct: grandTotal > 0 ? (cumulative / grandTotal) * 100 : 0,
      };
    });
  }, [filtered, lookup]);

  // ─── 2. Trend data: daily downtime stacked by top error codes ────────────

  const { trendData, trendCodes } = useMemo(() => {
    // Identify top N codes by total duration
    const topCodes = paretoData.slice(0, TOP_N).map(r => r.code);
    const topSet = new Set(topCodes);

    // Group by date
    const byDate: Record<string, Record<string, number>> = {};
    for (const r of filtered) {
      if (!byDate[r.shift_date]) byDate[r.shift_date] = {};
      const key = topSet.has(r.error_code) ? r.error_code : "Other";
      byDate[r.shift_date][key] = (byDate[r.shift_date][key] || 0) + r.total_duration_secs;
    }

    const codes = [...topCodes];
    // Check if there are "Other" entries
    const hasOther = Object.values(byDate).some(d => d["Other"]);
    if (hasOther) codes.push("Other");

    const data = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => {
        const row: Record<string, string | number> = { date };
        for (const c of codes) {
          row[c] = secsToMin(vals[c] || 0);
        }
        return row;
      });

    return { trendData: data, trendCodes: codes };
  }, [filtered, paretoData]);

  // ─── 3. Breakdown table: sortable detail ─────────────────────────────────

  type SortCol = "code" | "totalSecs" | "occurrences" | "avgDuration" | "machines";
  const [sortCol, setSortCol] = useState<SortCol>("totalSecs");
  const [sortAsc, setSortAsc] = useState(false);

  const tableData = useMemo(() => {
    const byCode: Record<string, {
      code: string;
      description: string;
      cause: string | null;
      solution: string | null;
      totalSecs: number;
      occurrences: number;
      machines: Set<string>;
      byMachine: Record<string, { secs: number; count: number }>;
      byShift: Record<number, { secs: number; count: number }>;
    }> = {};

    for (const r of filtered) {
      if (!byCode[r.error_code]) {
        const info = lookup[r.error_code];
        byCode[r.error_code] = {
          code: r.error_code,
          description: info?.description ?? "Unknown",
          cause: info?.cause ?? null,
          solution: info?.solution ?? null,
          totalSecs: 0,
          occurrences: 0,
          machines: new Set(),
          byMachine: {},
          byShift: {},
        };
      }
      const entry = byCode[r.error_code];
      entry.totalSecs += r.total_duration_secs;
      entry.occurrences += r.occurrence_count;
      entry.machines.add(r.machine_code);
      if (!entry.byMachine[r.machine_code]) entry.byMachine[r.machine_code] = { secs: 0, count: 0 };
      entry.byMachine[r.machine_code].secs += r.total_duration_secs;
      entry.byMachine[r.machine_code].count += r.occurrence_count;
      if (!entry.byShift[r.plc_shift]) entry.byShift[r.plc_shift] = { secs: 0, count: 0 };
      entry.byShift[r.plc_shift].secs += r.total_duration_secs;
      entry.byShift[r.plc_shift].count += r.occurrence_count;
    }

    const arr = Object.values(byCode);

    arr.sort((a, b) => {
      let va: number, vb: number;
      switch (sortCol) {
        case "code":         return sortAsc ? a.code.localeCompare(b.code) : b.code.localeCompare(a.code);
        case "totalSecs":    va = a.totalSecs; vb = b.totalSecs; break;
        case "occurrences":  va = a.occurrences; vb = b.occurrences; break;
        case "avgDuration":  va = a.occurrences > 0 ? a.totalSecs / a.occurrences : 0; vb = b.occurrences > 0 ? b.totalSecs / b.occurrences : 0; break;
        case "machines":     va = a.machines.size; vb = b.machines.size; break;
        default:             va = a.totalSecs; vb = b.totalSecs;
      }
      return sortAsc ? va - vb : vb - va;
    });

    return arr;
  }, [filtered, lookup, sortCol, sortAsc]);

  // Expandable rows
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  const handleSort = (col: SortCol) => {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  };

  const sortIcon = (col: SortCol) => sortCol === col ? (sortAsc ? " \u25B2" : " \u25BC") : "";

  // ─── Summary KPIs ───────────────────────────────────────────────────────

  const totalDowntimeHours = useMemo(() => secsToHours(filtered.reduce((s, r) => s + r.total_duration_secs, 0)), [filtered]);
  const totalOccurrences   = useMemo(() => filtered.reduce((s, r) => s + r.occurrence_count, 0), [filtered]);
  const uniqueCodes        = useMemo(() => new Set(filtered.map(r => r.error_code)).size, [filtered]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        <i className="bi bi-arrow-repeat animate-spin mr-2"></i> Loading downtime data...
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="text-center py-20 text-gray-500">
        <i className="bi bi-check-circle text-3xl mb-3 block text-green-500"></i>
        <p className="text-lg font-medium text-gray-300 mb-1">No downtime recorded</p>
        <p className="text-sm">No error data found for the selected period{machineFilter !== "all" ? ` and machine ${machineFilter}` : ""}.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Machine filter ── */}
      <MachineFilterDropdown
        value={machineFilter}
        onChange={setMachineFilter}
        machinesWithErrors={machinesWithErrors}
        machines={machines}
      />

      {/* ── Summary KPIs ── */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Total Downtime</div>
          <div className="text-2xl font-bold text-red-400">{fmtN(totalDowntimeHours, 1)}h</div>
        </div>
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Total Error Events</div>
          <div className="text-2xl font-bold text-white">{fmtN(totalOccurrences, 0)}</div>
        </div>
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
          <div className="text-xs text-gray-500 mb-1">Unique Error Codes</div>
          <div className="text-2xl font-bold text-white">{uniqueCodes}</div>
        </div>
      </div>

      {/* ── 1. Pareto chart ── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Downtime by Error Code</h3>
        <p className="text-xs text-gray-500 mb-4">Total downtime hours per error code, sorted by impact. The line shows cumulative percentage.</p>
        {paretoData.length > 0 && (
          <ResponsiveContainer width="100%" height={Math.max(280, paretoData.length * 32)}>
            <ComposedChart data={paretoData} layout="vertical" margin={{ left: 10, right: 40, top: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} horizontal={false} />
              <XAxis type="number" tick={TICK_STYLE} stroke={AXIS_COLOR} />
              <YAxis
                type="category"
                dataKey="shortLabel"
                tick={{ fill: "#ef4444", fontSize: 11, fontFamily: "monospace" }}
                stroke={AXIS_COLOR}
                width={55}
              />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(value: any, name: any) => {
                  const v = Number(value);
                  if (name === "totalHours") return [`${fmtN(v, 1)}h`, "Downtime"];
                  if (name === "cumulativePct") return [`${fmtN(v, 1)}%`, "Cumulative"];
                  return [v, name];
                }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                labelFormatter={(label: any) => {
                  const item = paretoData.find(d => d.shortLabel === label);
                  return item ? `${item.code}: ${item.description}` : label;
                }}
              />
              <Bar dataKey="totalHours" fill="#ef4444" radius={[0, 4, 4, 0]} barSize={20}>
                {paretoData.map((_, i) => (
                  <Cell key={i} fill={i < 3 ? "#ef4444" : i < 6 ? "#f97316" : "#6b7280"} />
                ))}
              </Bar>
              <Line type="monotone" dataKey="cumulativePct" stroke="#22c55e" strokeWidth={2} dot={{ r: 3, fill: "#22c55e" }} yAxisId={0} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── 2. Trend over time ── */}
      {trendData.length > 1 && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">Downtime Trend</h3>
          <p className="text-xs text-gray-500 mb-4">Daily error minutes stacked by top error codes. Shows whether downtime is improving or getting worse.</p>
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={trendData} margin={{ left: 10, right: 10, top: 5, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
              <XAxis
                dataKey="date"
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                stroke={AXIS_COLOR}
                angle={-40}
                textAnchor="end"
                tickFormatter={(d: string) => {
                  try { return fmtDateShort(parseISO(d)); } catch { return d; }
                }}
              />
              <YAxis tick={TICK_STYLE} stroke={AXIS_COLOR} label={{ value: "minutes", angle: -90, position: "insideLeft", fill: "#6b7280", fontSize: 11 }} />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                labelFormatter={(d: any) => {
                  try { return fmtDateShort(parseISO(String(d))); } catch { return String(d); }
                }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                formatter={(value: any, name: any) => {
                  const v = Number(value);
                  const n = String(name);
                  const info = lookup[n];
                  const label = info ? `${n} ${info.description}` : n;
                  return [`${fmtN(v, 0)} min`, label];
                }}
              />
              {trendCodes.map((code, i) => (
                <Area
                  key={code}
                  type="monotone"
                  dataKey={code}
                  stackId="1"
                  fill={AREA_COLORS[i % AREA_COLORS.length]}
                  stroke={AREA_COLORS[i % AREA_COLORS.length]}
                  fillOpacity={0.6}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-3 mt-3 justify-center">
            {trendCodes.map((code, i) => (
              <div key={code} className="flex items-center gap-1.5 text-xs text-gray-400">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: AREA_COLORS[i % AREA_COLORS.length] }}></span>
                {code}{lookup[code] ? ` ${lookup[code].description}` : ""}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 3. Breakdown table ── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="p-5 pb-3">
          <h3 className="text-sm font-semibold text-gray-300 mb-1">Error Code Breakdown</h3>
          <p className="text-xs text-gray-500">Click a row to see per-machine and per-shift distribution. Sort by any column.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs border-b border-gray-700 bg-gray-800/80">
                <th className="text-left px-5 py-2 cursor-pointer hover:text-white select-none" onClick={() => handleSort("code")}>
                  Code{sortIcon("code")}
                </th>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-right px-3 py-2 cursor-pointer hover:text-white select-none" onClick={() => handleSort("totalSecs")}>
                  Total Downtime{sortIcon("totalSecs")}
                </th>
                <th className="text-right px-3 py-2 cursor-pointer hover:text-white select-none" onClick={() => handleSort("occurrences")}>
                  Events{sortIcon("occurrences")}
                </th>
                <th className="text-right px-3 py-2 cursor-pointer hover:text-white select-none" onClick={() => handleSort("avgDuration")}>
                  Avg Duration{sortIcon("avgDuration")}
                </th>
                <th className="text-right px-5 py-2 cursor-pointer hover:text-white select-none" onClick={() => handleSort("machines")}>
                  Machines{sortIcon("machines")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {tableData.map((row) => {
                const isExpanded = expandedCode === row.code;
                const avgSecs = row.occurrences > 0 ? row.totalSecs / row.occurrences : 0;
                return (
                  <Fragment key={row.code}>
                    <tr
                      className="hover:bg-white/5 cursor-pointer transition-colors"
                      onClick={() => setExpandedCode(isExpanded ? null : row.code)}
                    >
                      <td className="px-5 py-2.5 font-mono text-red-400 whitespace-nowrap">
                        <i className={`bi ${isExpanded ? "bi-chevron-down" : "bi-chevron-right"} text-[10px] mr-1.5 text-gray-500`}></i>
                        {row.code}
                      </td>
                      <td className="px-3 py-2.5 text-gray-300 max-w-[300px] truncate">{row.description}</td>
                      <td className="px-3 py-2.5 text-right font-medium text-white">{fmtDuration(row.totalSecs)}</td>
                      <td className="px-3 py-2.5 text-right text-gray-300">{fmtN(row.occurrences, 0)}</td>
                      <td className="px-3 py-2.5 text-right text-gray-400">{fmtDuration(Math.round(avgSecs))}</td>
                      <td className="px-5 py-2.5 text-right text-gray-400">{row.machines.size}</td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={6} className="px-5 py-3 bg-gray-900/50">
                          <div className="grid grid-cols-2 gap-6">
                            {/* Cause + Solution */}
                            {(row.cause || row.solution) && (
                              <div className="col-span-2 flex gap-6 text-xs mb-2">
                                {row.cause && (
                                  <div className="flex-1">
                                    <span className="text-gray-500 font-medium">Possible cause:</span>
                                    <p className="text-gray-400 mt-0.5 whitespace-pre-line">{row.cause}</p>
                                  </div>
                                )}
                                {row.solution && (
                                  <div className="flex-1">
                                    <span className="text-gray-500 font-medium">Possible solution:</span>
                                    <p className="text-gray-400 mt-0.5 whitespace-pre-line">{row.solution}</p>
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Per-machine breakdown */}
                            <div>
                              <div className="text-xs text-gray-500 font-medium mb-1.5">By Machine</div>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-gray-500 border-b border-gray-700/50">
                                    <th className="text-left py-1">Machine</th>
                                    <th className="text-right py-1">Downtime</th>
                                    <th className="text-right py-1">Events</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.entries(row.byMachine)
                                    .sort(([, a], [, b]) => b.secs - a.secs)
                                    .map(([mc, v]) => {
                                      const reg = machines.find(m => m.machine_code === mc);
                                      return (
                                        <tr key={mc} className="border-b border-gray-800/50">
                                          <td className="py-1 text-gray-300">{reg?.name ?? mc}</td>
                                          <td className="py-1 text-right text-gray-400">{fmtDuration(v.secs)}</td>
                                          <td className="py-1 text-right text-gray-500">{v.count}</td>
                                        </tr>
                                      );
                                    })}
                                </tbody>
                              </table>
                            </div>
                            {/* Per-shift breakdown */}
                            <div>
                              <div className="text-xs text-gray-500 font-medium mb-1.5">By PLC Shift</div>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-gray-500 border-b border-gray-700/50">
                                    <th className="text-left py-1">Shift</th>
                                    <th className="text-right py-1">Downtime</th>
                                    <th className="text-right py-1">Events</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.entries(row.byShift)
                                    .sort(([a], [b]) => Number(a) - Number(b))
                                    .map(([shift, v]) => (
                                      <tr key={shift} className="border-b border-gray-800/50">
                                        <td className="py-1 text-gray-300">Shift {shift}</td>
                                        <td className="py-1 text-right text-gray-400">{fmtDuration(v.secs)}</td>
                                        <td className="py-1 text-right text-gray-500">{v.count}</td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

