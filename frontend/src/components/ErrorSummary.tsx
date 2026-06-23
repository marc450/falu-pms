"use client";

import { useState } from "react";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import type { ErrorEvent, PlcErrorCode } from "@/lib/supabase";

// Where the "Error Analytics" link points — the Downtime tab of the analytics
// page, which carries the full error breakdown and trends. When a machine code
// is given, the Downtime tab opens pre-filtered to that machine.
function errorAnalyticsHref(machineCode?: string): string {
  const base = "/analytics?tab=downtime";
  return machineCode ? `${base}&machine=${encodeURIComponent(machineCode)}` : base;
}

interface Props {
  errorEvents: ErrorEvent[];
  errorLookup: Record<string, PlcErrorCode>;
  // When embedded inside another card (e.g. the Machine State Timeline), drop
  // the outer card chrome and separate from the content above with a top
  // divider instead of a self-contained bordered box.
  embedded?: boolean;
  // When collapsible, the header acts as a toggle: only its title + summary
  // line show until clicked, then the table expands below.
  collapsible?: boolean;
  // Whether a collapsible summary starts expanded. Ignored when not collapsible.
  defaultOpen?: boolean;
  // Total seconds of the shown period (e.g. the selected date range). Drives
  // the "% of total time" column — how much of the whole window each error
  // consumed. Omitted → that column shows "—".
  windowSecs?: number;
  // Average total downtime per peer machine (same machine_type) per error code,
  // over the same window. Drives the "vs peers" column: this machine's total
  // duration vs the peer average, as a signed %. null → no peers, column "—".
  peerAvgSecs?: Record<string, number> | null;
  // Short description of the peer group, shown in the "vs peers" header tooltip.
  peerLabel?: string;
  // Machine code to pre-filter the Error Analytics page to. Omitted → the link
  // opens the Downtime tab across all machines.
  machineCode?: string;
  // Called with an error code while a row is hovered (null on leave) so a sibling
  // timeline can highlight that code's occurrences.
  onHoverCode?: (code: string | null) => void;
}

function fmtDur(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

function fmtTime(iso: string): string {
  try { return format(parseISO(iso), "HH:mm"); } catch { return iso; }
}

// One labelled aggregate shown in the Error Summary header.
function HeaderStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <span>
      <span className="text-gray-500">{label} </span>
      <span className={`tabular-nums font-medium ${valueClass ?? "text-gray-200"}`}>{value}</span>
    </span>
  );
}

interface CodeGroup {
  code: string;
  description: string;
  severity: string;
  count: number;
  totalSecs: number;
  lastAt: string;  // ISO
  events: ErrorEvent[];
}

function buildGroups(events: ErrorEvent[], lookup: Record<string, PlcErrorCode>): CodeGroup[] {
  const map = new Map<string, CodeGroup>();
  for (const ev of events) {
    const info = lookup[ev.error_code];
    const durSecs = ev.duration_secs
      ?? (ev.ended_at
        ? Math.round((parseISO(ev.ended_at).getTime() - parseISO(ev.started_at).getTime()) / 1000)
        : Math.round((Date.now() - parseISO(ev.started_at).getTime()) / 1000));

    const existing = map.get(ev.error_code);
    if (existing) {
      existing.count      += 1;
      existing.totalSecs  += durSecs;
      if (ev.started_at > existing.lastAt) existing.lastAt = ev.started_at;
      existing.events.push(ev);
    } else {
      map.set(ev.error_code, {
        code:        ev.error_code,
        description: info?.description ?? "Unknown error",
        severity:    info?.severity    ?? "",
        count:       1,
        totalSecs:   durSecs,
        lastAt:      ev.started_at,
        events:      [ev],
      });
    }
  }
  return [...map.values()].sort((a, b) => b.totalSecs - a.totalSecs);
}

export default function ErrorSummary({
  errorEvents,
  errorLookup,
  embedded = false,
  collapsible = false,
  defaultOpen = false,
  windowSecs,
  peerAvgSecs,
  peerLabel,
  machineCode,
  onHoverCode,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  if (errorEvents.length === 0) return null;

  const groups = buildGroups(errorEvents, errorLookup);
  const totalSecs  = groups.reduce((s, g) => s + g.totalSecs, 0);
  const totalCodes = groups.length;
  const totalCount = errorEvents.length;

  // ── Aggregates for the header totals ──
  // Average duration across every error event, regardless of code.
  const avgSecsAll = totalCount > 0 ? totalSecs / totalCount : 0;
  // This machine's total error time vs the average total error time per peer
  // machine (summed across every code the peer group logged).
  const peerTotalAvg = peerAvgSecs ? Object.values(peerAvgSecs).reduce((s, v) => s + v, 0) : null;
  const totalPeerDeltaPct = peerTotalAvg && peerTotalAvg > 0
    ? ((totalSecs - peerTotalAvg) / peerTotalAvg) * 100
    : null;
  const pctTotalAll = windowSecs && windowSecs > 0 ? (totalSecs / windowSecs) * 100 : null;

  // When collapsed, only the header shows; the table is hidden until expanded.
  const showTable = !collapsible || open;

  const outerClass = embedded
    ? "border-t border-gray-700"
    : "bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden";

  return (
    <div className={outerClass}>
      {/* Header — a toggle when collapsible. */}
      <div
        className={`flex items-center justify-between px-4 py-3 ${showTable ? "border-b border-gray-700" : ""} ${collapsible ? "cursor-pointer select-none hover:bg-gray-700/20 transition-colors" : ""}`}
        onClick={collapsible ? () => setOpen(o => !o) : undefined}
      >
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            {collapsible && (
              <i className={`bi bi-chevron-${open ? "down" : "right"} text-gray-500 text-[10px]`} />
            )}
            <i className="bi bi-exclamation-octagon text-red-400" />
            Error Summary
          </h3>
          {/* stopPropagation so following the link doesn't also toggle the
              collapsible card header it sits inside. */}
          <Link
            href={errorAnalyticsHref(machineCode)}
            onClick={(e) => e.stopPropagation()}
            className="text-xs text-cyan-400 hover:text-cyan-300 whitespace-nowrap flex items-center gap-1"
          >
            Error Analytics
            <i className="bi bi-arrow-right-short text-sm" />
          </Link>
        </div>

        {/* Aggregate totals — always visible, even when the table is collapsed. */}
        <div className="flex items-center gap-4 text-xs whitespace-nowrap">
          <HeaderStat label="Occurrences" value={String(totalCount)} />
          <HeaderStat label="Codes" value={String(totalCodes)} />
          <HeaderStat label="Total" value={fmtDur(totalSecs)} />
          <HeaderStat
            label="vs peers"
            value={totalPeerDeltaPct === null ? "—" : `${totalPeerDeltaPct > 0 ? "+" : ""}${totalPeerDeltaPct.toFixed(0)}%`}
            valueClass={
              totalPeerDeltaPct === null ? "text-gray-600"
                : totalPeerDeltaPct > 0 ? "text-red-400"
                : totalPeerDeltaPct < 0 ? "text-green-400"
                : "text-gray-300"
            }
          />
          <HeaderStat label="Avg" value={fmtDur(avgSecsAll)} />
          <HeaderStat label="% of time" value={pctTotalAll === null ? "—" : `${pctTotalAll.toFixed(1)}%`} />
        </div>
      </div>

      {/* Table */}
      {showTable && (
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-700/60">
            <th className="text-left font-medium px-4 py-2">Code</th>
            <th className="text-left font-medium px-2 py-2">Description</th>
            <th className="text-right font-medium px-2 py-2">Occurrences</th>
            <th className="text-right font-medium px-2 py-2">Total duration</th>
            <th
              className="text-right font-medium px-2 py-2 whitespace-nowrap"
              title={peerLabel ? `This machine's total duration vs the average per peer machine (${peerLabel}) over the shown period` : "Compared to peer machines of the same type"}
            >
              vs peers
            </th>
            <th className="text-right font-medium px-2 py-2">Avg duration</th>
            <th className="text-right font-medium px-2 py-2">% of error time</th>
            <th className="text-right font-medium px-2 py-2">% of total time</th>
            <th className="text-right font-medium px-4 py-2">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            // Average duration of a single occurrence: total time in this error
            // divided by how many times it occurred over the shown period.
            const avgSecs = g.count > 0 ? g.totalSecs / g.count : 0;
            // vs peers: this machine's total duration for the code relative to
            // the average per peer machine. null when there are no peers or the
            // peer group never logged this code (nothing to compare against).
            const peerAvg = peerAvgSecs?.[g.code];
            const peerDeltaPct = peerAvgSecs && peerAvg && peerAvg > 0
              ? ((g.totalSecs - peerAvg) / peerAvg) * 100
              : null;
            // Share of all error time over the shown period.
            const pctError = totalSecs > 0 ? (g.totalSecs / totalSecs) * 100 : 0;
            // Share of the whole shown window this error consumed.
            const pctTotal = windowSecs && windowSecs > 0 ? (g.totalSecs / windowSecs) * 100 : null;
            return (
              <tr
                key={g.code}
                className="border-b border-gray-700/40 hover:bg-gray-700/30 transition-colors"
                onMouseEnter={() => onHoverCode?.(g.code)}
                onMouseLeave={() => onHoverCode?.(null)}
              >
                <td className="px-4 py-2.5">
                  <span className="font-mono text-red-300 font-semibold">{g.code}</span>
                </td>
                <td className="px-2 py-2.5 text-gray-300 max-w-[280px] truncate">{g.description}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-300">{g.count}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-200 font-medium">{fmtDur(g.totalSecs)}</td>
                <td
                  className={`px-2 py-2.5 text-right tabular-nums font-medium ${
                    peerDeltaPct === null ? "text-gray-600"
                      // Higher than peers = more downtime = worse (red); lower = better (green).
                      : peerDeltaPct > 0 ? "text-red-400"
                      : peerDeltaPct < 0 ? "text-green-400"
                      : "text-gray-400"
                  }`}
                  title={peerAvg && peerAvg > 0 ? `Peer average: ${fmtDur(peerAvg)} per machine` : "No peer data for this code"}
                >
                  {peerDeltaPct === null
                    ? "—"
                    : `${peerDeltaPct > 0 ? "+" : ""}${peerDeltaPct.toFixed(0)}%`}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-300">{fmtDur(avgSecs)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-400">{pctError.toFixed(1)}%</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-400">{pctTotal === null ? "—" : `${pctTotal.toFixed(1)}%`}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">{fmtTime(g.lastAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      )}
    </div>
  );
}
