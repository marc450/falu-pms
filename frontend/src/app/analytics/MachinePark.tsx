"use client";

import { useEffect, useState, useCallback } from "react";
import { format, parseISO } from "date-fns";
import {
  fetchMachineShiftSummary,
  teamNameForShift,
} from "@/lib/supabase";
import type { DateRange, RegisteredMachine, MachineShiftRow, TimeSlot, ShiftAssignment } from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const BU_TARGET_DEFAULT   = 185;
const BU_MEDIOCRE_DEFAULT = 150;

// ─── Props ────────────────────────────────────────────────────────────────────

interface MachineParkProps {
  dateRange:        DateRange;
  machines:         RegisteredMachine[];
  shiftSlots:       TimeSlot[];
  shiftAssignments: Record<string, ShiftAssignment>;
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function buCellBg(val: number | null, target: number, mediocre: number): string {
  if (val === null) return "#111827"; // gray-900
  if (val >= target)   return "#14532d"; // green-900
  if (val >= mediocre) return "#713f12"; // yellow-900
  return "#7f1d1d"; // red-900
}

function buTableColor(val: number | null): string {
  if (val === null) return "text-gray-500";
  if (val >= BU_TARGET_DEFAULT)   return "text-green-400";
  if (val >= BU_MEDIOCRE_DEFAULT) return "text-yellow-400";
  return "text-red-400";
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MachinePark({ dateRange, machines, shiftSlots, shiftAssignments }: MachineParkProps) {
  const [rows, setRows]           = useState<MachineShiftRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [tooltip, setTooltip]     = useState<TooltipState>({ visible: false, x: 0, y: 0, content: "" });

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

  // Per-day team name lookup: uses the actual team assigned to that slot on that date.
  // Falls back to generic slot name when no assignment exists for that day.
  const slotName = (label: string, workDay?: string) =>
    teamNameForShift(workDay ?? "", label, shiftAssignments, shiftSlots);

  // ── Machine code → display name (user-set name, fallback to UID) ──
  const machineNameMap = new Map<string, string>();
  for (const m of machines) machineNameMap.set(m.machine_code, m.name || m.machine_code);
  const displayName = (code: string) => machineNameMap.get(code) ?? code;

  // Machine target lookup
  const machineTargets = new Map<string, { bu_target: number; bu_mediocre: number }>();
  for (const m of machines) {
    machineTargets.set(m.machine_code, {
      bu_target:   m.bu_target   ?? BU_TARGET_DEFAULT,
      bu_mediocre: m.bu_mediocre ?? BU_MEDIOCRE_DEFAULT,
    });
  }

  // ── Derived data ──
  const allMachineCodes = Array.from(new Set(rows.map(r => r.machine_code))).sort();

  // Work days: sorted chronological, capped at last 60 unique days, recent on right
  const allWorkDays = Array.from(new Set(rows.map(r => r.work_day))).sort();
  const last60Days  = allWorkDays.slice(-60);

  // Index: work_day -> machine_code -> { A: row | null, B: row | null }
  type DayMachineSlots = { A: MachineShiftRow | null; B: MachineShiftRow | null };
  const index = new Map<string, Map<string, DayMachineSlots>>();
  for (const r of rows) {
    if (!last60Days.includes(r.work_day)) continue;
    if (!index.has(r.work_day)) index.set(r.work_day, new Map());
    const dayMap = index.get(r.work_day)!;
    if (!dayMap.has(r.machine_code)) dayMap.set(r.machine_code, { A: null, B: null });
    const slots = dayMap.get(r.machine_code)!;
    if (r.shift_label === "A") slots.A = r;
    else if (r.shift_label === "B") slots.B = r;
  }

  // Avg BU for a (machine, day): mean of shift A and B
  function dayAvgBu(code: string, day: string): number | null {
    const slots = index.get(day)?.get(code);
    if (!slots) return null;
    const vals = [slots.A?.bu_normalized, slots.B?.bu_normalized].filter((v): v is number => v !== null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  }

  // Ranked table per machine
  const ranked = allMachineCodes.map(code => {
    const machRows = rows.filter(r => r.machine_code === code);
    if (machRows.length === 0) return { code, avgBu: null, bestShift: "—", worstShift: "—", avgRunHours: null, avgEfficiency: null };

    // Avg BU: weighted by run_hours
    const validBu = machRows.filter(r => r.bu_normalized !== null && r.run_hours > 0);
    const totalHours = validBu.reduce((s, r) => s + r.run_hours, 0);
    const avgBu = totalHours > 0
      ? validBu.reduce((s, r) => s + r.bu_normalized! * r.run_hours, 0) / totalHours
      : null;

    // Best and worst shift (by bu_normalized)
    const withBu = machRows.filter(r => r.bu_normalized !== null);
    const best  = withBu.length > 0 ? withBu.reduce((a, b) => (a.bu_normalized! > b.bu_normalized! ? a : b)) : null;
    const worst = withBu.length > 0 ? withBu.reduce((a, b) => (a.bu_normalized! < b.bu_normalized! ? a : b)) : null;

    let bestLabel  = "—";
    let worstLabel = "—";
    if (best) {
      let dl = best.work_day;
      try { dl = format(parseISO(best.work_day), "dd.MM.yy"); } catch { /* noop */ }
      bestLabel = `${dl} ${slotName(best.shift_label, best.work_day)}`;
    }
    if (worst) {
      let dl = worst.work_day;
      try { dl = format(parseISO(worst.work_day), "dd.MM.yy"); } catch { /* noop */ }
      worstLabel = `${dl} ${slotName(worst.shift_label, worst.work_day)}`;
    }

    const avgRunHours = machRows.length > 0
      ? machRows.reduce((s, r) => s + r.run_hours, 0) / machRows.length
      : null;

    const effRows = machRows.filter(r => r.avg_efficiency !== null);
    const avgEfficiency = effRows.length > 0
      ? effRows.reduce((s, r) => s + r.avg_efficiency!, 0) / effRows.length
      : null;

    return { code, avgBu, bestShift: bestLabel, worstShift: worstLabel, avgRunHours, avgEfficiency };
  }).sort((a, b) => {
    if (a.avgBu === null && b.avgBu === null) return a.code.localeCompare(b.code);
    if (a.avgBu === null) return 1;
    if (b.avgBu === null) return -1;
    return b.avgBu - a.avgBu;
  });

  // ── Render ──
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
        Loading machine park data...
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
        <p className="text-sm text-gray-500">No machine park data for this period</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 relative">
      {/* Heatmap */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">BU Heatmap (last 60 days)</h3>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block bg-green-900"></span>
              {">"}= 185
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block bg-yellow-900"></span>
              {">"}= 150
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block bg-red-900"></span>
              {"<"} 150
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: "#111827" }}></span>
              No data
            </span>
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-3">Each column = one work day. Two cells per machine per day: day shift (top), night shift (bottom). Hover a cell to see the assigned team.</p>
        <div className="overflow-x-auto">
          <div style={{ minWidth: last60Days.length * 22 + 80 }}>
            {/* Date labels row */}
            <div className="flex mb-1">
              <div style={{ width: 76, minWidth: 76 }}></div>
              {last60Days.map((day, i) => {
                let label = "";
                try {
                  const d = parseISO(day);
                  // Show label every 7th column
                  if (i % 7 === 0) label = format(d, "dd.MM");
                } catch { /* noop */ }
                return (
                  <div
                    key={day}
                    style={{ width: 20, minWidth: 20 }}
                    className="text-center overflow-hidden"
                  >
                    {label ? (
                      <span className="text-gray-600" style={{ fontSize: 9, writingMode: "vertical-rl", transform: "rotate(180deg)", display: "inline-block", height: 28 }}>
                        {label}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {/* Heatmap rows — one row per machine */}
            {allMachineCodes.map(code => {
              const tgt = machineTargets.get(code) ?? { bu_target: BU_TARGET_DEFAULT, bu_mediocre: BU_MEDIOCRE_DEFAULT };
              return (
                <div key={code} className="flex items-start mb-0.5">
                  <div style={{ width: 76, minWidth: 76 }} className="text-xs text-gray-400 pr-2 flex items-center h-9 shrink-0" title={code}>
                    {displayName(code)}
                  </div>
                  {last60Days.map(day => {
                    const slots = index.get(day)?.get(code);
                    const buA = slots?.A?.bu_normalized ?? null;
                    const buB = slots?.B?.bu_normalized ?? null;
                    return (
                      <div key={day} style={{ width: 20, minWidth: 20 }} className="flex flex-col gap-px">
                        {/* Shift A cell */}
                        <div
                          style={{ background: buCellBg(buA, tgt.bu_target, tgt.bu_mediocre), width: 18, height: 16, borderRadius: 2, cursor: "default" }}
                          onMouseEnter={e => {
                            let dateLabel = day;
                            try { dateLabel = format(parseISO(day), "dd.MM.yy"); } catch { /* noop */ }
                            setTooltip({
                              visible: true,
                              x: e.clientX,
                              y: e.clientY,
                              content: `${displayName(code)} ${dateLabel} ${slotName("A", day)}: ${buA !== null ? buA.toFixed(1) + " BU" : "No data"}`,
                            });
                          }}
                          onMouseLeave={() => setTooltip(t => ({ ...t, visible: false }))}
                          onMouseMove={e => setTooltip(t => ({ ...t, x: e.clientX, y: e.clientY }))}
                        />
                        {/* Shift B cell */}
                        <div
                          style={{ background: buCellBg(buB, tgt.bu_target, tgt.bu_mediocre), width: 18, height: 16, borderRadius: 2, cursor: "default" }}
                          onMouseEnter={e => {
                            let dateLabel = day;
                            try { dateLabel = format(parseISO(day), "dd.MM.yy"); } catch { /* noop */ }
                            setTooltip({
                              visible: true,
                              x: e.clientX,
                              y: e.clientY,
                              content: `${displayName(code)} ${dateLabel} ${slotName("B", day)}: ${buB !== null ? buB.toFixed(1) + " BU" : "No data"}`,
                            });
                          }}
                          onMouseLeave={() => setTooltip(t => ({ ...t, visible: false }))}
                          onMouseMove={e => setTooltip(t => ({ ...t, x: e.clientX, y: e.clientY }))}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Ranked table */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700">
          <h3 className="text-sm font-semibold text-white">Machine Ranking</h3>
          <p className="text-xs text-gray-500 mt-0.5">Sorted by period average BU (highest first)</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700 bg-gray-900/40">
                <th className="text-center  px-3 py-2 text-xs font-semibold text-gray-400">Rank</th>
                <th className="text-center  px-3 py-2 text-xs font-semibold text-gray-400">Machine</th>
                <th className="text-right   px-3 py-2 text-xs font-semibold text-gray-400">Avg BU</th>
                <th className="text-center  px-3 py-2 text-xs font-semibold text-gray-400">Best Shift</th>
                <th className="text-center  px-3 py-2 text-xs font-semibold text-gray-400">Worst Shift</th>
                <th className="text-right   px-3 py-2 text-xs font-semibold text-gray-400">Avg Run Hours</th>
                <th className="text-right   px-3 py-2 text-xs font-semibold text-gray-400">Avg Efficiency</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(({ code, avgBu, bestShift, worstShift, avgRunHours, avgEfficiency }, idx) => (
                <tr key={code} className="border-b border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                  <td className="px-3 py-2 text-xs text-center text-gray-500">{idx + 1}</td>
                  <td className="px-3 py-2 text-xs text-center font-medium text-gray-300" title={code}>{displayName(code)}</td>
                  <td className={`px-3 py-2 text-xs text-right font-mono ${buTableColor(avgBu)}`}>
                    {avgBu !== null ? avgBu.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-center text-gray-400">{bestShift}</td>
                  <td className="px-3 py-2 text-xs text-center text-gray-400">{worstShift}</td>
                  <td className="px-3 py-2 text-xs text-right font-mono text-gray-300">
                    {avgRunHours !== null ? `${avgRunHours.toFixed(1)} h` : "—"}
                  </td>
                  <td className={`px-3 py-2 text-xs text-right font-mono ${
                    avgEfficiency === null ? "text-gray-500"
                    : avgEfficiency >= 85  ? "text-green-400"
                    : avgEfficiency >= 70  ? "text-yellow-400"
                    : "text-red-400"
                  }`}>
                    {avgEfficiency !== null ? `${avgEfficiency.toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Floating tooltip */}
      {tooltip.visible && (
        <div
          className="fixed z-50 px-3 py-1.5 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-200 pointer-events-none shadow-lg"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          {tooltip.content}
        </div>
      )}

    </div>
  );
}
