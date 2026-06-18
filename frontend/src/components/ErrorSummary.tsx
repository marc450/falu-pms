"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import type { ErrorEvent, PlcErrorCode } from "@/lib/supabase";

interface Props {
  errorEvents: ErrorEvent[];
  errorLookup: Record<string, PlcErrorCode>;
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

function fmtDateTime(iso: string): string {
  try { return format(parseISO(iso), "dd.MM HH:mm"); } catch { return iso; }
}

function severityDot(severity: string | undefined) {
  const s = (severity ?? "").toLowerCase();
  const cls =
    s === "critical" ? "bg-red-500" :
    s === "warning"  ? "bg-amber-400" :
    "bg-gray-500";
  return <span className={`inline-block w-2 h-2 rounded-full ${cls} flex-shrink-0`} />;
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

export default function ErrorSummary({ errorEvents, errorLookup }: Props) {
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  if (errorEvents.length === 0) return null;

  const groups = buildGroups(errorEvents, errorLookup);
  const totalSecs  = groups.reduce((s, g) => s + g.totalSecs, 0);
  const totalCodes = groups.length;
  const totalCount = errorEvents.length;

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <i className="bi bi-exclamation-octagon text-red-400" />
          Error Summary
        </h3>
        <span className="text-xs text-gray-500">
          {totalCount} {totalCount === 1 ? "event" : "events"} · {totalCodes} {totalCodes === 1 ? "code" : "codes"} · {fmtDur(totalSecs)} total downtime
        </span>
      </div>

      {/* Table */}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-700/60">
            <th className="text-left font-medium px-4 py-2 w-6"></th>
            <th className="text-left font-medium px-2 py-2">Code</th>
            <th className="text-left font-medium px-2 py-2">Description</th>
            <th className="text-right font-medium px-2 py-2">Count</th>
            <th className="text-right font-medium px-2 py-2">Total time</th>
            <th className="text-right font-medium px-4 py-2">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = expandedCode === g.code;
            return [
              <tr
                key={g.code}
                className="border-b border-gray-700/40 hover:bg-gray-700/30 cursor-pointer transition-colors"
                onClick={() => setExpandedCode(isOpen ? null : g.code)}
              >
                <td className="px-4 py-2.5">
                  <i className={`bi bi-chevron-${isOpen ? "down" : "right"} text-gray-500 text-[10px]`} />
                </td>
                <td className="px-2 py-2.5">
                  <span className="flex items-center gap-1.5">
                    {severityDot(g.severity)}
                    <span className="font-mono text-red-300 font-semibold">{g.code}</span>
                  </span>
                </td>
                <td className="px-2 py-2.5 text-gray-300 max-w-[280px] truncate">{g.description}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-gray-300">{g.count}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-amber-300 font-medium">{fmtDur(g.totalSecs)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">{fmtTime(g.lastAt)}</td>
              </tr>,

              isOpen && (
                <tr key={`${g.code}-detail`} className="border-b border-gray-700/40 bg-gray-900/40">
                  <td colSpan={6} className="px-6 py-3">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-gray-600">
                          <th className="text-left font-medium pb-1 pr-4">Started</th>
                          <th className="text-left font-medium pb-1 pr-4">Ended</th>
                          <th className="text-right font-medium pb-1">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...g.events]
                          .sort((a, b) => a.started_at.localeCompare(b.started_at))
                          .map((ev) => {
                            const dur = ev.duration_secs
                              ?? (ev.ended_at
                                ? Math.round((parseISO(ev.ended_at).getTime() - parseISO(ev.started_at).getTime()) / 1000)
                                : Math.round((Date.now() - parseISO(ev.started_at).getTime()) / 1000));
                            return (
                              <tr key={ev.id} className="text-gray-400">
                                <td className="pr-4 py-0.5 tabular-nums font-mono">{fmtDateTime(ev.started_at)}</td>
                                <td className="pr-4 py-0.5 tabular-nums font-mono">
                                  {ev.ended_at
                                    ? fmtDateTime(ev.ended_at)
                                    : <span className="text-red-400">ongoing</span>}
                                </td>
                                <td className="text-right py-0.5 tabular-nums text-amber-300">{fmtDur(dur)}</td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
