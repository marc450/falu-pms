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

/** Map a PLC shift number (1/2/3, always 8h) to the user-defined slot label (A/B/C/D). */
function plcShiftToSlotLabel(plcShift: number, slots: TimeSlot[]): string {
  if (!slots.length) return String(plcShift);
  // PLC shifts are 8h blocks: shift 1 = 00:00-08:00, shift 2 = 08:00-16:00, shift 3 = 16:00-24:00
  const midpointHour = (plcShift - 1) * 8 + 4; // 4, 12, 20
  const firstStart = slots[0].startHour;
  const dur = slots.length <= 2 ? 12 : slots.length <= 3 ? 8 : 6;
  const slotIdx = Math.floor(((midpointHour - firstStart + 24) % 24) / dur);
  const labels = ["A", "B", "C", "D"];
  return labels[Math.min(slotIdx, labels.length - 1)] ?? "A";
}

/** Get display name for a slot label, using slot names from config. */
function slotDisplayName(label: string, slots: TimeSlot[]): string {
  const idx = label.charCodeAt(0) - 65; // A=0, B=1, etc.
  if (idx >= 0 && idx < slots.length && slots[idx].name) {
    const name = slots[idx].name;
    // Avoid redundancy like "A (A)" when slot name equals the label
    if (name === label) return `Shift ${label}`;
    return `${name} (${label})`;
  }
  return `Shift ${label}`;
}

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
    <div className="relative w-fit" ref={ref}>
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
  const [trendHover, setTrendHover] = useState<Record<string, string | number> | null>(null);
  const [trendRelative, setTrendRelative] = useState(false);
  const [trendHiddenCodes, setTrendHiddenCodes] = useState<Set<string>>(new Set());

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
        pct: grandTotal > 0 ? (r.totalSecs / grandTotal) * 100 : 0,
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
          row[c] = secsToHours(vals[c] || 0);
        }
        return row;
      });

    return { trendData: data, trendCodes: codes };
  }, [filtered, paretoData]);

  const trendVisibleCodes = useMemo(() => trendCodes.filter(c => !trendHiddenCodes.has(c)), [trendCodes, trendHiddenCodes]);

  const trendDisplayData = useMemo(() => {
    return trendData.map(row => {
      const out: Record<string, string | number> = { date: row.date };
      // Zero out hidden codes so they don't occupy stack space
      for (const c of trendCodes) {
        out[c] = trendHiddenCodes.has(c) ? 0 : Number(row[c] || 0);
      }
      if (trendRelative) {
        // Denominator is ALL codes (including hidden), so relative values
        // show each code's share of total downtime, not just visible codes
        const total = trendCodes.reduce((s, c) => s + Number(row[c] || 0), 0);
        for (const c of trendVisibleCodes) {
          out[c] = total > 0 ? (Number(row[c] || 0) / total) * 100 : 0;
        }
      }
      return out;
    });
  }, [trendData, trendRelative, trendCodes, trendVisibleCodes, trendHiddenCodes]);

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
      byShift: Record<string, { secs: number; count: number }>;
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
      if (r.plc_shift > 0) {
        const slotLabel = plcShiftToSlotLabel(r.plc_shift, shiftSlots);
        if (!entry.byShift[slotLabel]) entry.byShift[slotLabel] = { secs: 0, count: 0 };
        entry.byShift[slotLabel].secs += r.total_duration_secs;
        entry.byShift[slotLabel].count += r.occurrence_count;
      }
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
  }, [filtered, lookup, sortCol, sortAsc, shiftSlots]);

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

      {/* ── 1. Pareto chart ── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-1">Downtime by Error Code</h3>
        <p className="text-xs text-gray-500 mb-4">Share of total downtime per error code, sorted by impact. The line shows cumulative percentage.</p>
        {paretoData.length > 0 && (
          <div className="overflow-x-auto">
            <div style={{ width: Math.max(600, paretoData.length * 56), minWidth: "100%" }}>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={paretoData} margin={{ left: 10, right: 10, top: 5, bottom: 50 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                  <XAxis
                    dataKey="shortLabel"
                    tick={{ fill: "#ef4444", fontSize: 11, fontFamily: "monospace" }}
                    stroke={AXIS_COLOR}
                    angle={-45}
                    textAnchor="end"
                    interval={0}
                    height={50}
                  />
                  <YAxis tick={TICK_STYLE} stroke={AXIS_COLOR} tickFormatter={(v: number) => `${fmtN(v, 1)}%`} />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0]?.payload;
                      if (!d) return null;
                      return (
                        <div style={TOOLTIP_CONTENT_STYLE} className="px-3 py-2.5">
                          <div className="text-white font-medium mb-2">{d.code}: {d.description}</div>
                          <div className="text-red-400 text-sm">Share of Downtime: {fmtN(d.pct, 1)}%</div>
                          <div className="text-gray-300 text-sm">Total Downtime: {fmtN(d.totalHours, 1)}h</div>
                          <div className="text-green-400 text-sm">Cumulative: {fmtN(d.cumulativePct, 1)}%</div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="pct" fill="#ef4444" radius={[4, 4, 0, 0]} barSize={28}>
                    {paretoData.map((_, i) => (
                      <Cell key={i} fill={i < 3 ? "#ef4444" : i < 6 ? "#f97316" : "#6b7280"} />
                    ))}
                  </Bar>
                  <Line type="monotone" dataKey="cumulativePct" stroke="#22c55e" strokeWidth={2} dot={{ r: 3, fill: "#22c55e" }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* ── 2. Trend over time ── */}
      {trendData.length > 1 && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-5">
          {/* Header with title */}
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-1">Downtime Trend</h3>
            <div className="flex items-center gap-3">
              <p className="text-xs text-gray-500">Daily error {trendRelative ? "share" : "hours"} stacked by top error codes.</p>
              <div className="flex items-center bg-gray-900/60 rounded-lg overflow-hidden text-[11px]">
                <button
                  className={`px-2.5 py-1 transition-colors ${!trendRelative ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-300"}`}
                  onClick={() => setTrendRelative(false)}
                >hours</button>
                <button
                  className={`px-2.5 py-1 transition-colors ${trendRelative ? "bg-gray-700 text-white" : "text-gray-400 hover:text-gray-300"}`}
                  onClick={() => setTrendRelative(true)}
                >%</button>
              </div>
            </div>
          </div>
          {/* Chart */}
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart
              data={trendDisplayData}
              stackOffset="none"
              margin={{ left: 10, right: 10, top: 5, bottom: 30 }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onMouseMove={(state: any) => {
                // activeTooltipIndex is more reliable than activePayload
                // when some Area elements are hidden (transparent)
                const idx = state?.activeTooltipIndex;
                if (idx != null && idx >= 0 && idx < trendData.length) {
                  setTrendHover(trendData[idx]);
                }
              }}
              onMouseLeave={() => setTrendHover(null)}
            >
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
              <YAxis
                tick={TICK_STYLE}
                stroke={AXIS_COLOR}
                domain={trendRelative ? [0, 100] : ["auto", "auto"]}
                tickFormatter={trendRelative ? (v: number) => `${fmtN(v, 0)}%` : (v: number) => `${fmtN(v, 1)}h`}
                label={trendRelative ? undefined : { value: "hours", angle: -90, position: "insideLeft", fill: "#6b7280", fontSize: 11 }}
              />
              <Tooltip content={() => null} cursor={{ stroke: "#9ca3af", strokeWidth: 1 }} />
              {trendCodes.map((code, i) => {
                const hidden = trendHiddenCodes.has(code);
                return (
                  <Area
                    key={code}
                    type="monotone"
                    dataKey={code}
                    stackId="1"
                    fill={hidden ? "transparent" : AREA_COLORS[i % AREA_COLORS.length]}
                    stroke={hidden ? "transparent" : AREA_COLORS[i % AREA_COLORS.length]}
                    fillOpacity={0.6}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
          {/* Interactive legend below chart */}
          <div className="mt-3 pt-3 border-t border-gray-700/30">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs text-gray-500 font-medium">
                {trendHover
                  ? (() => { try { return fmtDateShort(parseISO(String(trendHover.date))); } catch { return String(trendHover.date); } })()
                  : "Hover chart for details"}
              </span>
              <div className="flex gap-1.5 text-[10px]">
                <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => setTrendHiddenCodes(new Set())}>All</button>
                <span className="text-gray-600">/</span>
                <button className="text-gray-500 hover:text-gray-300 transition-colors" onClick={() => setTrendHiddenCodes(new Set(trendCodes))}>None</button>
              </div>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 text-xs">
              {trendCodes.map((code, i) => {
                const hidden = trendHiddenCodes.has(code);
                const hrs = trendHover ? Number(trendHover[code] || 0) : 0;
                const totalH = trendHover ? trendCodes.reduce((s, c) => s + Number(trendHover[c] || 0), 0) : 0;
                return (
                  <div
                    key={code}
                    className={`flex items-center gap-2 cursor-pointer transition-opacity ${hidden ? "opacity-30" : "opacity-100"}`}
                    onClick={() => {
                      setTrendHiddenCodes(prev => {
                        const next = new Set(prev);
                        if (next.has(code)) next.delete(code); else next.add(code);
                        return next;
                      });
                    }}
                  >
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: AREA_COLORS[i % AREA_COLORS.length] }}></span>
                    <span className={`truncate flex-1 ${hidden ? "text-gray-600 line-through" : "text-gray-400"}`} title={lookup[code]?.description ?? code}>
                      {code} {lookup[code]?.description ?? ""}
                    </span>
                    <span className={`font-mono flex-shrink-0 ${trendHover ? (hidden ? "text-gray-600" : "text-gray-200") : "text-gray-700"}`}>
                      {trendHover ? (
                        trendRelative
                          ? `${fmtN(hrs, 1)}h (${totalH > 0 ? fmtN((hrs / totalH) * 100, 1) : "0.0"}%)`
                          : `${fmtN(hrs, 1)}h`
                      ) : ""}
                    </span>
                  </div>
                );
              })}
            </div>
            {trendHover && (
              <div className="flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-700/50 text-xs">
                <span className="w-2.5 h-2.5 flex-shrink-0"></span>
                <span className="text-gray-300 font-medium flex-1">Total (visible)</span>
                <span className="font-mono text-white font-medium flex-shrink-0">
                  {fmtN(trendVisibleCodes.reduce((s, c) => s + Number(trendHover[c] || 0), 0), 1)}h
                </span>
              </div>
            )}
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
                        <td colSpan={6} className="p-0">
                          <div className="bg-gray-900/60 border-t border-b border-gray-700/30">
                            {/* Cause + Solution cards */}
                            {(row.cause || row.solution) && (
                              <div className="grid grid-cols-2 gap-4 px-6 pt-4 pb-2">
                                {row.cause && (
                                  <div className="bg-gray-800/50 rounded-lg p-3">
                                    <div className="flex items-center gap-1.5 mb-1.5">
                                      <i className="bi bi-exclamation-triangle text-amber-500 text-[11px]"></i>
                                      <span className="text-[11px] font-semibold text-amber-500 uppercase tracking-wider">Possible Cause</span>
                                    </div>
                                    <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-line">{row.cause}</p>
                                  </div>
                                )}
                                {row.solution && (
                                  <div className="bg-gray-800/50 rounded-lg p-3">
                                    <div className="flex items-center gap-1.5 mb-1.5">
                                      <i className="bi bi-wrench text-blue-400 text-[11px]"></i>
                                      <span className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider">Possible Solution</span>
                                    </div>
                                    <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-line">{row.solution}</p>
                                  </div>
                                )}
                              </div>
                            )}
                            {/* Distribution tables */}
                            <div className="grid grid-cols-2 gap-4 px-6 py-4">
                              {/* Per-machine breakdown */}
                              <div className="bg-gray-800/50 rounded-lg p-3">
                                <div className="flex items-center gap-1.5 mb-2.5">
                                  <i className="bi bi-hdd-stack text-gray-400 text-[11px]"></i>
                                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">By Machine</span>
                                </div>
                                <div className="space-y-1">
                                  {Object.entries(row.byMachine)
                                    .sort(([, a], [, b]) => b.secs - a.secs)
                                    .map(([mc, v]) => {
                                      const reg = machines.find(m => m.machine_code === mc);
                                      const pct = row.totalSecs > 0 ? (v.secs / row.totalSecs) * 100 : 0;
                                      return (
                                        <div key={mc}>
                                          <div className="flex items-center justify-between text-xs mb-0.5">
                                            <span className="text-gray-300 font-medium">{reg?.name ?? mc}</span>
                                            <div className="flex items-center gap-3">
                                              <span className="text-gray-400">{fmtDuration(v.secs)}</span>
                                              <span className="text-gray-500 w-12 text-right">{v.count} ev.</span>
                                            </div>
                                          </div>
                                          <div className="h-1 bg-gray-700/50 rounded-full overflow-hidden">
                                            <div className="h-full bg-cyan-500/60 rounded-full" style={{ width: `${pct}%` }}></div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                </div>
                              </div>
                              {/* Per-shift breakdown */}
                              <div className="bg-gray-800/50 rounded-lg p-3">
                                <div className="flex items-center gap-1.5 mb-2.5">
                                  <i className="bi bi-clock text-gray-400 text-[11px]"></i>
                                  <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">By Shift</span>
                                </div>
                                <div className="space-y-1">
                                  {Object.entries(row.byShift)
                                    .sort(([a], [b]) => a.localeCompare(b))
                                    .map(([shift, v]) => {
                                      const pct = row.totalSecs > 0 ? (v.secs / row.totalSecs) * 100 : 0;
                                      return (
                                        <div key={shift}>
                                          <div className="flex items-center justify-between text-xs mb-0.5">
                                            <span className="text-gray-300 font-medium">{slotDisplayName(shift, shiftSlots)}</span>
                                            <div className="flex items-center gap-3">
                                              <span className="text-gray-400">{fmtDuration(v.secs)}</span>
                                              <span className="text-gray-500 w-12 text-right">{v.count} ev.</span>
                                            </div>
                                          </div>
                                          <div className="h-1 bg-gray-700/50 rounded-full overflow-hidden">
                                            <div className="h-full bg-blue-500/60 rounded-full" style={{ width: `${pct}%` }}></div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                </div>
                              </div>
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

