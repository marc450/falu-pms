"use client";

import { useEffect, useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import {
  fetchMachineShiftSummary,
  fetchProductionCells,
  teamNameForShift,
} from "@/lib/supabase";
import type { DateRange, RegisteredMachine, MachineShiftRow, ProductionCell, TimeSlot, ShiftAssignment } from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const BU_TARGET_DEFAULT   = 185;
const BU_MEDIOCRE_DEFAULT = 150;
const SWABS_PER_BU        = 7200;

type Metric    = "bu" | "hours" | "efficiency" | "scrap";
type ColorMode = "simple" | "gradient";

// ─── Gradient helper ──────────────────────────────────────────────────────────
// Maps a normalised 0–1 position through a multi-stop HSL ramp.

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

// Universal gradient stops: deep red → amber → yellow-green → rich green
const GRADIENT_STOPS = [
  { t: 0.00, h:   4, s: 78, l: 22 },
  { t: 0.20, h:  14, s: 80, l: 27 },
  { t: 0.42, h:  36, s: 75, l: 30 },
  { t: 0.65, h:  72, s: 60, l: 28 },
  { t: 0.85, h: 128, s: 50, l: 28 },
  { t: 1.00, h: 148, s: 55, l: 26 },
];

// Table-range gradient: position val between [min, max] then map to colour.
// invert=true for metrics where lower is better (scrap).
function rangeGradientBg(val: number, min: number, max: number, invert = false): string {
  const range = max > min ? max - min : 1;
  let t = (val - min) / range;
  if (invert) t = 1 - t;
  return lerpHsl(Math.max(0, Math.min(1, t)), GRADIENT_STOPS);
}

// ─── Cell style resolver ──────────────────────────────────────────────────────

interface CellStyle {
  className: string;
  style?:    React.CSSProperties;
}

function buStyle(val: number | null, target: number, mediocre: number, mode: ColorMode, tMin = 0, tMax = 1): CellStyle {
  if (val === null) return { className: "bg-gray-900 text-gray-600" };
  if (mode === "simple") {
    if (val >= target)   return { className: "bg-green-900/40 text-green-300" };
    if (val >= mediocre) return { className: "bg-yellow-900/40 text-yellow-300" };
    return                      { className: "bg-red-900/40 text-red-300" };
  }
  return { className: "text-white font-medium", style: { backgroundColor: rangeGradientBg(val, tMin, tMax) } };
}

function effStyle(val: number | null, mode: ColorMode, tMin = 0, tMax = 100): CellStyle {
  if (val === null) return { className: "bg-gray-900 text-gray-600" };
  if (mode === "simple") {
    if (val >= 85) return { className: "bg-green-900/40 text-green-300" };
    if (val >= 70) return { className: "bg-yellow-900/40 text-yellow-300" };
    return                { className: "bg-red-900/40 text-red-300" };
  }
  return { className: "text-white font-medium", style: { backgroundColor: rangeGradientBg(val, tMin, tMax) } };
}

function scrapStyle(val: number | null, mode: ColorMode, tMin = 0, tMax = 10): CellStyle {
  if (val === null) return { className: "bg-gray-900 text-gray-600" };
  if (mode === "simple") {
    if (val <= 2) return { className: "bg-green-900/40 text-green-300" };
    if (val <= 5) return { className: "bg-yellow-900/40 text-yellow-300" };
    return              { className: "bg-red-900/40 text-red-300" };
  }
  return { className: "text-white font-medium", style: { backgroundColor: rangeGradientBg(val, tMin, tMax, true) } };
}

function hoursStyle(val: number | null, mode: ColorMode, shiftLen = 12, tMin = 0, tMax = 12): CellStyle {
  if (val === null) return { className: "bg-gray-900 text-gray-600" };
  if (mode === "simple") {
    const pct = val / shiftLen;
    if (pct >= 0.83) return { className: "bg-green-900/40 text-green-300" };
    if (pct >= 0.50) return { className: "bg-yellow-900/40 text-yellow-300" };
    return                  { className: "bg-red-900/40 text-red-300" };
  }
  return { className: "text-white font-medium", style: { backgroundColor: rangeGradientBg(val, tMin, tMax) } };
}

// Gradient legend swatch strip (used in gradient mode)
// labelLeft appears to the left of the bar (low/bad end), labelRight to the right (high/good end).
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

interface MachineAnalyticsProps {
  dateRange:        DateRange;
  machines:         RegisteredMachine[];
  shiftSlots:       TimeSlot[];
  shiftAssignments: Record<string, ShiftAssignment>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MachineAnalytics({ dateRange, machines, shiftSlots, shiftAssignments }: MachineAnalyticsProps) {
  // Returns the team name assigned to a specific work-day and slot.
  // Falls back to the configured slot name when no assignment exists.
  const slotName = (workDay: string, label: string) =>
    teamNameForShift(workDay, label, shiftAssignments, shiftSlots);
  const [rows,       setRows]       = useState<MachineShiftRow[]>([]);
  const [cells,      setCells]      = useState<ProductionCell[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [metric,     setMetric]     = useState<Metric>("bu");
  const [cellFilter, setCellFilter] = useState<string | null>(null);  // null = All
  const [normalized, setNormalized] = useState(false);
  const [colorMode,  setColorMode]  = useState<ColorMode>("simple");

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

  // Load production cells once on mount
  useEffect(() => {
    fetchProductionCells().then(setCells).catch(() => {});
  }, []);

  // ── Machine code → cell_id lookup ──
  const machineCell = new Map<string, string | null>();
  for (const m of machines) machineCell.set(m.machine_code, m.cell_id ?? null);

  // ── Machine code → display name (user-set name, fallback to UID) ──
  const machineNameMap = new Map<string, string>();
  for (const m of machines) machineNameMap.set(m.machine_code, m.name || m.machine_code);
  const displayName = (code: string) => machineNameMap.get(code) ?? code;

  // ── Derived lists ──
  const allMachineCodes = Array.from(new Set(rows.map(r => r.machine_code))).sort();

  const filteredCodes = allMachineCodes.filter(code => {
    if (cellFilter === null) return true;
    return machineCell.get(code) === cellFilter;
  });

  // Unique (work_day, shift_label) pairs, newest first, A before B within day
  const slotKeys = Array.from(
    new Map(rows.map(r => [
      `${r.work_day}|${r.shift_label}`,
      { work_day: r.work_day, shift_label: r.shift_label },
    ])).values()
  ).sort((a, b) => {
    if (a.work_day !== b.work_day) return b.work_day.localeCompare(a.work_day);
    return a.shift_label.localeCompare(b.shift_label);
  });

  // Row index
  const rowIndex = new Map<string, MachineShiftRow>();
  for (const r of rows) rowIndex.set(`${r.work_day}|${r.shift_label}|${r.machine_code}`, r);

  // Machine target lookup
  const machineTargets = new Map<string, { bu_target: number; bu_mediocre: number }>();
  for (const m of machines) {
    machineTargets.set(m.machine_code, {
      bu_target:   m.bu_target   ?? BU_TARGET_DEFAULT,
      bu_mediocre: m.bu_mediocre ?? BU_MEDIOCRE_DEFAULT,
    });
  }

  // ── Table-range min/max for gradient mode (excludes the summary row) ──
  const tableDataValues: number[] = slotKeys.flatMap(({ work_day, shift_label }) =>
    filteredCodes.flatMap(code => {
      const r = rowIndex.get(`${work_day}|${shift_label}|${code}`);
      if (!r) return [];
      if (metric === "bu")         return [(normalized ? r.bu_normalized : r.swabs_produced / SWABS_PER_BU) ?? null].filter((v): v is number => v !== null);
      if (metric === "hours")      return r.run_hours      != null ? [r.run_hours]      : [];
      if (metric === "efficiency") return r.avg_efficiency != null ? [r.avg_efficiency] : [];
      return r.avg_scrap != null ? [r.avg_scrap] : [];
    })
  );
  const tableMin = tableDataValues.length > 0 ? Math.min(...tableDataValues) : 0;
  const tableMax = tableDataValues.length > 0 ? Math.max(...tableDataValues) : 1;

  // ── Cell value ──
  function cellValue(code: string, work_day: string, shift_label: string): { display: string } & CellStyle {
    const r   = rowIndex.get(`${work_day}|${shift_label}|${code}`);
    const tgt = machineTargets.get(code) ?? { bu_target: BU_TARGET_DEFAULT, bu_mediocre: BU_MEDIOCRE_DEFAULT };

    if (!r) return { display: "—", className: "bg-gray-900/60 text-gray-700" };

    if (metric === "bu") {
      const val = normalized ? r.bu_normalized : (r.swabs_produced / SWABS_PER_BU);
      const s   = buStyle(val, tgt.bu_target, tgt.bu_mediocre, colorMode, tableMin, tableMax);
      return { display: val !== null ? val.toFixed(1) : "—", ...s };
    }
    if (metric === "hours") {
      const s = hoursStyle(r.run_hours, colorMode, 12, tableMin, tableMax);
      return { display: r.run_hours != null ? `${r.run_hours.toFixed(1)} h` : "—", ...s };
    }
    if (metric === "efficiency") {
      const val = r.avg_efficiency;
      const s   = effStyle(val, colorMode, tableMin, tableMax);
      return { display: val !== null ? `${val.toFixed(1)}%` : "—", ...s };
    }
    // scrap
    const val = r.avg_scrap;
    const s   = scrapStyle(val, colorMode, tableMin, tableMax);
    return { display: val !== null ? `${val.toFixed(2)}%` : "—", ...s };
  }

  // ── Summary row ──
  function summaryValue(code: string): { display: string } & CellStyle {
    const machRows = rows.filter(r => r.machine_code === code);
    if (machRows.length === 0) return { display: "—", className: "text-gray-600" };
    const tgt = machineTargets.get(code) ?? { bu_target: BU_TARGET_DEFAULT, bu_mediocre: BU_MEDIOCRE_DEFAULT };

    if (metric === "bu") {
      if (normalized) {
        const valid = machRows.filter(r => r.bu_normalized !== null && r.run_hours != null && r.run_hours > 0);
        if (valid.length === 0) return { display: "—", className: "text-gray-600" };
        const totalHours = valid.reduce((s, r) => s + r.run_hours!, 0);
        const weighted   = valid.reduce((s, r) => s + (r.bu_normalized! * r.run_hours!), 0);
        const avg = totalHours > 0 ? weighted / totalHours : null;
        return { display: avg !== null ? avg.toFixed(1) : "—", ...buStyle(avg, tgt.bu_target, tgt.bu_mediocre, colorMode, tableMin, tableMax) };
      } else {
        const avg = machRows.reduce((s, r) => s + r.swabs_produced / SWABS_PER_BU, 0) / machRows.length;
        return { display: avg.toFixed(1), ...buStyle(avg, tgt.bu_target, tgt.bu_mediocre, colorMode, tableMin, tableMax) };
      }
    }
    if (metric === "hours") {
      const valid = machRows.filter(r => r.run_hours != null);
      if (valid.length === 0) return { display: "—", className: "bg-gray-900 text-gray-600" };
      const total = valid.reduce((s, r) => s + r.run_hours!, 0);
      const avg   = total / valid.length;
      return { display: `${total.toFixed(1)} h`, ...hoursStyle(avg, colorMode, 12, tableMin, tableMax) };
    }
    if (metric === "efficiency") {
      const valid = machRows.filter(r => r.avg_efficiency !== null);
      if (valid.length === 0) return { display: "—", className: "text-gray-600" };
      const avg = valid.reduce((s, r) => s + r.avg_efficiency!, 0) / valid.length;
      return { display: `${avg.toFixed(1)}%`, ...effStyle(avg, colorMode, tableMin, tableMax) };
    }
    const valid = machRows.filter(r => r.avg_scrap !== null);
    if (valid.length === 0) return { display: "—", className: "text-gray-600" };
    const avg = valid.reduce((s, r) => s + r.avg_scrap!, 0) / valid.length;
    return { display: `${avg.toFixed(2)}%`, ...scrapStyle(avg, colorMode, tableMin, tableMax) };
  }

  // ── Loading / error / empty ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin" />
        Loading machine data...
      </div>
    );
  }
  if (error) {
    return (
      <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-3">
        <i className="bi bi-exclamation-circle mr-2" />{error}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2">
        <i className="bi bi-inbox text-3xl text-gray-600" />
        <p className="text-sm text-gray-500">No machine data for this period</p>
      </div>
    );
  }

  const metricButtons: { id: Metric; label: string }[] = [
    { id: "bu",         label: "BU"         },
    { id: "hours",      label: "Run Hours"  },
    { id: "efficiency", label: "Efficiency" },
    { id: "scrap",      label: "Scrap"      },
  ];

  // Only show cells that actually have machines in the current data set
  const activeCellIds = new Set(
    allMachineCodes.map(c => machineCell.get(c)).filter(Boolean) as string[]
  );
  const visibleCells = cells.filter(c => activeCellIds.has(c.id));

  return (
    <div className="flex flex-col gap-4">

      {/* ── Control bar ── */}
      <div className="flex flex-wrap items-start gap-3">

        {/* Metric selector */}
        <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-lg p-1">
          {metricButtons.map(b => (
            <button
              key={b.id}
              onClick={() => setMetric(b.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                metric === b.id
                  ? "bg-blue-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        {/* Production cell filter */}
        <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-lg p-1 flex-wrap">
          <button
            onClick={() => setCellFilter(null)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              cellFilter === null
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
          >
            All
          </button>
          {visibleCells.map(c => (
            <button
              key={c.id}
              onClick={() => setCellFilter(prev => prev === c.id ? null : c.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                cellFilter === c.id
                  ? "bg-gray-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        {/* BU normalisation switch */}
        {metric === "bu" && (
          <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-lg p-1">
            <button
              onClick={() => setNormalized(false)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                !normalized
                  ? "bg-gray-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
              title="Actual BU produced during the shift"
            >
              Actual
            </button>
            <button
              onClick={() => setNormalized(true)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                normalized
                  ? "bg-gray-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
              title="BU extrapolated to a full 12 h shift"
            >
              Normalized
            </button>
          </div>
        )}

        {/* Color mode switch */}
        <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-lg p-1">
          <button
            onClick={() => setColorMode("simple")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              colorMode === "simple"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
            title="3-color zone coding based on target thresholds"
          >
            Target
          </button>
          <button
            onClick={() => setColorMode("gradient")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              colorMode === "gradient"
                ? "bg-gray-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
            title="Continuous gradient scaled to the lowest and highest value in the table"
          >
            Gradient
          </button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-gray-500 ml-1 pt-1">
          {colorMode === "simple" ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-green-900/40 border border-green-700/40" />
                {metric === "scrap" ? "≤ 2%" : metric === "efficiency" ? "≥ 85%" : metric === "hours" ? "≥ 83% of shift" : "≥ 185 BU"}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-yellow-900/40 border border-yellow-700/40" />
                {metric === "scrap" ? "≤ 5%" : metric === "efficiency" ? "≥ 70%" : metric === "hours" ? "≥ 50% of shift" : "≥ 150 BU"}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-red-900/40 border border-red-700/40" />
                {metric === "scrap" ? "> 5%" : metric === "efficiency" ? "< 70%" : metric === "hours" ? "< 50% of shift" : "< 150 BU"}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-gray-900 border border-gray-700/40" />
                No data
              </span>
            </>
          ) : (
            <>
              <GradientSwatch
                labelLeft={
                  metric === "scrap"
                    ? (tableMax.toFixed(2) + "%")
                    : metric === "hours"
                      ? (tableMin.toFixed(1) + " h")
                      : metric === "efficiency"
                        ? (tableMin.toFixed(1) + "%")
                        : tableMin.toFixed(1)
                }
                labelRight={
                  metric === "scrap"
                    ? (tableMin.toFixed(2) + "%")
                    : metric === "hours"
                      ? (tableMax.toFixed(1) + " h")
                      : metric === "efficiency"
                        ? (tableMax.toFixed(1) + "%")
                        : tableMax.toFixed(1)
                }
                fn={t => rangeGradientBg(
                  tableMin + t * (tableMax - tableMin),
                  tableMin,
                  tableMax,
                  metric === "scrap",
                )}
              />
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-gray-900 border border-gray-700/40" />
                No data
              </span>
            </>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-400 bg-gray-900/50 sticky left-0 z-10 whitespace-nowrap">
                  Date
                </th>
                <th className="text-center px-2 py-2 text-xs font-semibold text-gray-400 bg-gray-900/50 sticky left-[72px] z-10 border-r border-gray-700 whitespace-nowrap">
                  Shift
                </th>
                {filteredCodes.map(code => (
                  <th key={code} className="text-right px-2 py-2 text-xs font-semibold text-gray-400 whitespace-nowrap min-w-[80px]" title={code}>
                    {displayName(code)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slotKeys.map(({ work_day, shift_label }) => {
                let dateLabel = work_day;
                try { dateLabel = format(parseISO(work_day), "dd.MM.yy"); } catch { /* keep raw */ }
                return (
                  <tr key={`${work_day}|${shift_label}`} className="border-b border-gray-700/50 hover:bg-gray-700/10 transition-colors">
                    <td className="px-3 py-1.5 text-xs text-gray-400 bg-gray-900/30 sticky left-0 z-10 whitespace-nowrap">
                      {dateLabel}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-center font-medium text-gray-300 bg-gray-900/30 sticky left-[72px] z-10 border-r border-gray-700 whitespace-nowrap">
                      {slotName(work_day, shift_label)}
                    </td>
                    {filteredCodes.map(code => {
                      const { display, className, style } = cellValue(code, work_day, shift_label);
                      return (
                        <td key={code} className={`px-2 py-1.5 text-xs text-right font-mono ${className}`} style={style}>
                          {display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {/* Period avg summary row */}
              <tr className="border-t-2 border-gray-600 bg-gray-900/50">
                <td colSpan={2} className="px-3 py-2 text-xs font-semibold text-gray-300 sticky left-0 z-10 bg-gray-900/50 border-r border-gray-700">
                  Period avg
                </td>
                {filteredCodes.map(code => {
                  const { display, className, style } = summaryValue(code);
                  return (
                    <td key={code} className={`px-2 py-2 text-xs text-right font-mono font-semibold ${className}`} style={style}>
                      {display}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
