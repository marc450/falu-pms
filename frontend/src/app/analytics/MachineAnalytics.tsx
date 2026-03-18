"use client";

import { useEffect, useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import {
  fetchMachineShiftSummary,
} from "@/lib/supabase";
import type { DateRange, RegisteredMachine, MachineShiftRow } from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const BU_TARGET_DEFAULT   = 185;
const BU_MEDIOCRE_DEFAULT = 150;
const SWABS_PER_BU        = 7200;

type Metric = "bu" | "hours" | "efficiency" | "scrap";
type Group  = "all" | "CB" | "CT";

// ─── Color helpers ────────────────────────────────────────────────────────────

function buCellColor(val: number | null, target: number, mediocre: number): string {
  if (val === null) return "bg-gray-900 text-gray-600";
  if (val >= target)   return "bg-green-900/40 text-green-300";
  if (val >= mediocre) return "bg-yellow-900/40 text-yellow-300";
  return "bg-red-900/40 text-red-300";
}

function efficiencyCellColor(val: number | null): string {
  if (val === null) return "bg-gray-900 text-gray-600";
  if (val >= 85) return "bg-green-900/40 text-green-300";
  if (val >= 70) return "bg-yellow-900/40 text-yellow-300";
  return "bg-red-900/40 text-red-300";
}

function scrapCellColor(val: number | null): string {
  if (val === null) return "bg-gray-900 text-gray-600";
  if (val <= 2) return "bg-green-900/40 text-green-300";
  if (val <= 5) return "bg-yellow-900/40 text-yellow-300";
  return "bg-red-900/40 text-red-300";
}

function hoursCellColor(): string {
  return "text-gray-300";
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface MachineAnalyticsProps {
  dateRange: DateRange;
  machines:  RegisteredMachine[];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MachineAnalytics({ dateRange, machines }: MachineAnalyticsProps) {
  const [rows, setRows]       = useState<MachineShiftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [metric,     setMetric]     = useState<Metric>("bu");
  const [group,      setGroup]      = useState<Group>("all");
  const [normalized, setNormalized] = useState(true);

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

  // ── Derived lists ──
  const allMachineCodes = Array.from(new Set(rows.map(r => r.machine_code))).sort();
  const filteredCodes = allMachineCodes.filter(code =>
    group === "all" ? true : code.startsWith(group)
  );

  // Unique (work_day, shift_label) pairs, sorted newest first then A before B
  const slotKeys = Array.from(
    new Map(rows.map(r => [`${r.work_day}|${r.shift_label}`, { work_day: r.work_day, shift_label: r.shift_label }])).values()
  ).sort((a, b) => {
    if (a.work_day !== b.work_day) return b.work_day.localeCompare(a.work_day);
    return a.shift_label.localeCompare(b.shift_label);
  });

  // Index rows by (work_day, shift_label, machine_code)
  const rowIndex = new Map<string, MachineShiftRow>();
  for (const r of rows) {
    rowIndex.set(`${r.work_day}|${r.shift_label}|${r.machine_code}`, r);
  }

  // Machine target lookup
  const machineTargets = new Map<string, { bu_target: number; bu_mediocre: number }>();
  for (const m of machines) {
    machineTargets.set(m.machine_code, {
      bu_target:   m.bu_target   ?? BU_TARGET_DEFAULT,
      bu_mediocre: m.bu_mediocre ?? BU_MEDIOCRE_DEFAULT,
    });
  }

  // Summary row: per machine aggregations
  function summaryValue(code: string): { display: string; colorClass: string } {
    const machRows = rows.filter(r => r.machine_code === code && filteredCodes.includes(r.machine_code));
    if (machRows.length === 0) return { display: "—", colorClass: "text-gray-600" };

    const tgt = machineTargets.get(code) ?? { bu_target: BU_TARGET_DEFAULT, bu_mediocre: BU_MEDIOCRE_DEFAULT };

    if (metric === "bu") {
      if (normalized) {
        const valid = machRows.filter(r => r.bu_normalized !== null && r.run_hours > 0);
        if (valid.length === 0) return { display: "—", colorClass: "text-gray-600" };
        const totalHours = valid.reduce((s, r) => s + r.run_hours, 0);
        const weighted   = valid.reduce((s, r) => s + (r.bu_normalized! * r.run_hours), 0);
        const avg = totalHours > 0 ? weighted / totalHours : null;
        return { display: avg !== null ? avg.toFixed(1) : "—", colorClass: buCellColor(avg, tgt.bu_target, tgt.bu_mediocre) };
      } else {
        // Raw: average actual BU per shift session
        if (machRows.length === 0) return { display: "—", colorClass: "text-gray-600" };
        const avg = machRows.reduce((s, r) => s + r.swabs_produced / SWABS_PER_BU, 0) / machRows.length;
        return { display: avg.toFixed(1), colorClass: buCellColor(avg, tgt.bu_target, tgt.bu_mediocre) };
      }
    }
    if (metric === "hours") {
      const total = machRows.reduce((s, r) => s + r.run_hours, 0);
      return { display: `${total.toFixed(1)} h`, colorClass: hoursCellColor() };
    }
    if (metric === "efficiency") {
      const valid = machRows.filter(r => r.avg_efficiency !== null);
      if (valid.length === 0) return { display: "—", colorClass: "text-gray-600" };
      const avg = valid.reduce((s, r) => s + r.avg_efficiency!, 0) / valid.length;
      return { display: `${avg.toFixed(1)}%`, colorClass: efficiencyCellColor(avg) };
    }
    // scrap
    const valid = machRows.filter(r => r.avg_scrap !== null);
    if (valid.length === 0) return { display: "—", colorClass: "text-gray-600" };
    const avg = valid.reduce((s, r) => s + r.avg_scrap!, 0) / valid.length;
    return { display: `${avg.toFixed(1)}%`, colorClass: scrapCellColor(avg) };
  }

  function cellValue(code: string, work_day: string, shift_label: string): { display: string; colorClass: string } {
    const r = rowIndex.get(`${work_day}|${shift_label}|${code}`);
    const tgt = machineTargets.get(code) ?? { bu_target: BU_TARGET_DEFAULT, bu_mediocre: BU_MEDIOCRE_DEFAULT };

    if (!r) return { display: "—", colorClass: "bg-gray-900 text-gray-600" };

    if (metric === "bu") {
      const val = normalized
        ? r.bu_normalized
        : r.swabs_produced / SWABS_PER_BU;
      return { display: val !== null ? val.toFixed(1) : "—", colorClass: buCellColor(val, tgt.bu_target, tgt.bu_mediocre) };
    }
    if (metric === "hours") {
      return { display: `${r.run_hours.toFixed(1)} h`, colorClass: hoursCellColor() };
    }
    if (metric === "efficiency") {
      const val = r.avg_efficiency;
      return { display: val !== null ? `${val.toFixed(1)}%` : "—", colorClass: efficiencyCellColor(val) };
    }
    // scrap
    const val = r.avg_scrap;
    return { display: val !== null ? `${val.toFixed(1)}%` : "—", colorClass: scrapCellColor(val) };
  }

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
        Loading machine data...
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

  const groupButtons: { id: Group; label: string }[] = [
    { id: "all", label: "All"  },
    { id: "CB",  label: "CB"   },
    { id: "CT",  label: "CT"   },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-3">
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
        <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-lg p-1">
          {groupButtons.map(b => (
            <button
              key={b.id}
              onClick={() => setGroup(b.id)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                group === b.id
                  ? "bg-gray-600 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-700"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        {metric === "bu" && (
          <div className="flex items-center gap-3 flex-wrap">
            {/* Normalization toggle */}
            <button
              onClick={() => setNormalized(v => !v)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium border transition-colors ${
                normalized
                  ? "bg-blue-900/40 border-blue-600/60 text-blue-300"
                  : "bg-gray-800 border-gray-600 text-gray-400 hover:text-white hover:border-gray-500"
              }`}
              title={normalized ? "Showing BU extrapolated to a full 12h shift — click to show actual BU produced" : "Showing actual BU produced — click to normalize to 12h shift"}
            >
              <i className={`bi ${normalized ? "bi-toggles" : "bi-toggles"} text-xs`}></i>
              {normalized ? "Normalized @ 12 h" : "Actual BU"}
            </button>
            {/* Legend */}
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-green-900/40 border border-green-700/40"></span>
                {">"}= 185 BU
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-yellow-900/40 border border-yellow-700/40"></span>
                {">"}= 150 BU
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-red-900/40 border border-red-700/40"></span>
                {"<"} 150 BU
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-gray-900 border border-gray-700/40"></span>
                No data
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-center px-3 py-2 text-xs font-semibold text-gray-400 bg-gray-900/50 sticky left-0 z-10 whitespace-nowrap">
                  Date
                </th>
                <th className="text-center px-2 py-2 text-xs font-semibold text-gray-400 bg-gray-900/50 sticky left-[72px] z-10 border-r border-gray-700">
                  Shift
                </th>
                {filteredCodes.map(code => (
                  <th key={code} className="text-center px-2 py-2 text-xs font-semibold text-gray-400 whitespace-nowrap min-w-[80px]">
                    {code}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slotKeys.map(({ work_day, shift_label }) => {
                let dateLabel = "";
                try { dateLabel = format(parseISO(work_day), "dd.MM.yy"); } catch { dateLabel = work_day; }
                return (
                  <tr key={`${work_day}|${shift_label}`} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                    <td className="px-3 py-1.5 text-xs text-gray-400 bg-gray-900/30 sticky left-0 z-10 whitespace-nowrap">
                      {dateLabel}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-center font-medium text-gray-300 bg-gray-900/30 sticky left-[72px] z-10 border-r border-gray-700">
                      {shift_label}
                    </td>
                    {filteredCodes.map(code => {
                      const { display, colorClass } = cellValue(code, work_day, shift_label);
                      return (
                        <td key={code} className={`px-2 py-1.5 text-xs text-right font-mono ${colorClass}`}>
                          {display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {/* Summary row */}
              <tr className="border-t-2 border-gray-600 bg-gray-900/50">
                <td colSpan={2} className="px-3 py-2 text-xs font-semibold text-gray-300 sticky left-0 z-10 bg-gray-900/50 border-r border-gray-700">
                  Period avg
                </td>
                {filteredCodes.map(code => {
                  const { display, colorClass } = summaryValue(code);
                  return (
                    <td key={code} className={`px-2 py-2 text-xs text-right font-mono font-semibold ${colorClass}`}>
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
