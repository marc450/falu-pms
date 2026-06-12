"use client";

import { useEffect, useState, useRef } from "react";
// @ts-expect-error react-dom types aren't installed; createPortal ships in react-dom at runtime
import { createPortal } from "react-dom";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, usePlotArea,
} from "recharts";
import {
  format, parseISO,
  subHours,
} from "date-fns";
import { fmtPct } from "@/lib/fmt";
import { applyEfficiencyColor, applyScrapColor, pickGranularity } from "@/lib/supabase";
import type { DateRange, FleetTrendRow, Thresholds, ErrorEvent, PlcErrorCode } from "@/lib/supabase";
import {
  useFactoryTimezone,
  formatHourMinute,
  getZonedParts,
  constructFactoryInstant,
  factoryStartOfDay,
  factoryStartOfMonth,
  factoryStartOfQuarter,
  factoryStartOfYear,
  factoryDateBefore,
} from "@/lib/useFactoryTimezone";

// ─── Chart constants ─────────────────────────────────────────────────────────

const GRID_COLOR = "#374151";
const AXIS_COLOR = "#4b5563";
const TICK_STYLE = { fill: "#9ca3af", fontSize: 11 };
const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "6px",
  fontSize: 12,
  color: "#e5e7eb",
};
const TOOLTIP_LABEL_STYLE = { color: "#9ca3af", marginBottom: 4 };
const TOOLTIP_ITEM_STYLE = { color: "#e5e7eb", padding: "1px 0" };

// ─── Period presets ───────────────────────────────────────────────────────────

export type PresetId =
  | "1h" | "curshift" | "lastshift"
  | "24h" | "7d" | "4w" | "6m" | "12m" | "mtd" | "qtd" | "ytd" | "all";

export interface Preset {
  id: PresetId;
  label: string;
  // tz is the factory's IANA timezone — all day/month/year boundaries are
  // computed at the factory's wall clock, not the browser's, so the data
  // window matches what an operator would expect ("Last 7 days" = midnight
  // 7 calendar days ago at the factory).
  getRange: (tz: string) => DateRange;
}

const mkNow = () => new Date();

// Start of the current 12h shift (07:00 / 19:00 factory-local). Before 07:00
// the active shift began at the previous day's 19:00.
function currentShiftStart(tz: string): Date {
  const p = getZonedParts(mkNow(), tz);
  if (p.hour >= 19) return constructFactoryInstant(tz, p.year, p.month, p.day, 19, 0);
  if (p.hour >= 7)  return constructFactoryInstant(tz, p.year, p.month, p.day, 7, 0);
  // before 07:00 → previous day's 19:00 shift (step 3h before factory midnight)
  const prev = getZonedParts(new Date(factoryStartOfDay(tz).getTime() - 3 * 3_600_000), tz);
  return constructFactoryInstant(tz, prev.year, prev.month, prev.day, 19, 0);
}

export const PRESETS: Preset[] = [
  // Shift + hour windows are fixed-duration; resolved at the factory wall clock.
  { id: "curshift",  label: "Current shift", getRange: (tz) => ({ start: currentShiftStart(tz),              end: mkNow() }) },
  { id: "lastshift", label: "Last shift",    getRange: (tz) => ({ start: subHours(currentShiftStart(tz), 12), end: currentShiftStart(tz) }) },
  { id: "1h",        label: "Last hour",     getRange: ()   => ({ start: subHours(mkNow(), 1),               end: mkNow() }) },
  // 24h is a fixed-duration window — timezone-independent.
  { id: "24h", label: "Last 24 hours",   getRange: ()   => ({ start: subHours(mkNow(), 24),                        end: mkNow() }) },
  { id: "7d",  label: "Last 7 days",     getRange: (tz) => ({ start: factoryDateBefore(tz, { days:   7 }),         end: mkNow() }) },
  { id: "4w",  label: "Last 4 weeks",    getRange: (tz) => ({ start: factoryDateBefore(tz, { days:  28 }),         end: mkNow() }) },
  { id: "6m",  label: "Last 6 months",   getRange: (tz) => ({ start: factoryDateBefore(tz, { months: 6 }),         end: mkNow() }) },
  { id: "12m", label: "Last 12 months",  getRange: (tz) => ({ start: factoryDateBefore(tz, { months: 12 }),        end: mkNow() }) },
  { id: "mtd", label: "Month to date",   getRange: (tz) => ({ start: factoryStartOfMonth(tz),                      end: mkNow() }) },
  { id: "qtd", label: "Quarter to date", getRange: (tz) => ({ start: factoryStartOfQuarter(tz),                    end: mkNow() }) },
  { id: "ytd", label: "Year to date",    getRange: (tz) => ({ start: factoryStartOfYear(tz),                       end: mkNow() }) },
  { id: "all", label: "All time",        getRange: (tz) => ({ start: constructFactoryInstant(tz, 2020, 1, 1, 0, 0), end: mkNow() }) },
];

export const DEFAULT_PRESET_ID: PresetId = "7d";

// ─── Formatters ──────────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtMillions(n: number): string {
  const m = n / 1_000_000;
  return `${m.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
}

// All three formatters take an optional `tz` (IANA timezone, e.g.
// "Europe/Zurich"). When given, the Date is rendered as it would appear
// at the factory's wall clock — required for chart axes/tooltips read by
// any viewer not physically at the factory. When omitted, falls back to
// browser-local (legacy behavior) so callers that don't yet thread tz
// through aren't broken.
function fmtDateShort(d: Date, tz?: string): string {
  if (tz) {
    const p = getZonedParts(d, tz);
    return `${String(p.day).padStart(2, "0")}. ${MONTH_ABBR[p.month - 1]} '${String(p.year).slice(2)}`;
  }
  const day = String(d.getDate()).padStart(2, "0");
  const mon = MONTH_ABBR[d.getMonth()];
  const yr  = String(d.getFullYear()).slice(2);
  return `${day}. ${mon} '${yr}`;
}

// Bucket keys come in four lengths: "YYYY-MM-DD" (day, 10), "YYYY-MM-DDTHH"
// (hour, 13 — legacy), "YYYY-MM-DDTHH:MM" (sub-hour, 16), and
// "YYYY-MM-DDTHH:MM:SS" (5-sec, 19). Append whatever suffix rounds it out to a
// parseable UTC instant. ORDER MATTERS: check 19 before 16.
export function parseBucketKey(key: string): Date {
  if (key.length >= 19) return parseISO(key + "Z");           // 5-sec
  if (key.length >= 16) return parseISO(key + ":00Z");        // sub-hour
  if (key.length >= 13) return parseISO(key + ":00:00Z");     // hour
  return parseISO(key);                                       // day
}

function fmtBucketFull(key: string, granularity: "hour" | "day", tz?: string): string {
  try {
    if (granularity === "hour") {
      const d = parseBucketKey(key);
      const base = tz ? formatHourMinute(d, tz) : format(d, "HH:mm");
      // 5-sec buckets: append seconds (tz-invariant) so the tooltip is precise.
      const time = key.length >= 19 ? `${base}:${String(d.getUTCSeconds()).padStart(2, "0")}` : base;
      return `${fmtDateShort(d, tz)} ${time}`;
    }
    return fmtDateShort(parseISO(key), tz);
  } catch { return key; }
}

// Instant label for the x-axis. For sub-hour buckets we only label the
// integer-hour positions ("10:00", "11:00", "12:00", …) and leave the
// in-between buckets unlabelled, giving a continuous timeline feel. The
// "top of hour" check has to happen in the factory's clock too — UTC
// top-of-hour aligns with whole-hour-offset timezones (CET/CEST) but not
// with half-hour offsets like India (UTC+5:30).
function fmtBucketLabel(key: string, granularity: "hour" | "day", tz?: string): string {
  try {
    if (granularity === "hour") {
      const d = parseBucketKey(key);
      // 5-sec buckets: label the top of each minute (seconds are tz-invariant).
      if (key.length >= 19) {
        if (d.getUTCSeconds() !== 0) return "";
        return tz ? formatHourMinute(d, tz) : format(d, "HH:mm");
      }
      const minute = tz ? getZonedParts(d, tz).minute : d.getUTCMinutes();
      if (minute !== 0) return "";
      return tz ? formatHourMinute(d, tz) : format(d, "HH:mm");
    }
    return fmtDateShort(parseISO(key), tz);
  } catch { return key; }
}

function filterDailyTicks(rows: { date: string }[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      const d = parseISO(rows[i].date);
      const day = d.getDate();
      if (day === 1 || day === 15) indices.push(i);
    } catch { /* skip */ }
  }
  if (indices.length < 2 && rows.length <= 31) {
    return rows.map((_, i) => i);
  }
  return indices;
}

// <input type="datetime-local"> value ("yyyy-MM-ddTHH:mm") rendered at the
// FACTORY wall clock, so the custom picker is consistent with the presets.
function toDateTimeInputValue(d: Date, tz: string): string {
  const p = getZonedParts(d, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Parse a datetime-local string as a FACTORY-local wall clock -> UTC instant.
function parseFactoryInput(s: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return constructFactoryInstant(tz, +m[1], +m[2], +m[3], +m[4], +m[5]);
}

const GRAN_LABEL: Record<string, string> = {
  "5s": "5-second", "5m": "5-minute", "1h": "hourly", "1d": "daily",
};
function fmtReadingCount(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M`
    : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K`
    : `${n}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RangeTick({ x, y, payload, granularity, angled, tz }: any) {
  const label = fmtBucketLabel(payload?.value ?? "", granularity, tz);
  if (!label) return null;
  if (angled) {
    return (
      <g transform={`translate(${x},${y})`}>
        <text transform="rotate(-40)" textAnchor="end" fill="#9ca3af" fontSize={10} dy={4} dx={-4}>
          {label}
        </text>
      </g>
    );
  }
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#9ca3af" fontSize={10}>
        {label}
      </text>
    </g>
  );
}

// Custom Tooltip for the Total BU Output chart. Adds the target line, the
// delta (actual − target), and a hit/miss indicator next to the
// per-bucket value so a hover answers "did this day hit?" without
// requiring the operator to mentally compare against the green/amber/red
// zone bands. recharts passes `active`, `payload`, `label` automatically.
function BuTooltipContent({
  active, payload, label, target, granularity, fmtLabelFn, peerLabel,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  active?: boolean; payload?: any[]; label?: string;
  target: number | null;
  granularity: "hour" | "day";
  fmtLabelFn: (key: string) => string;
  peerLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const selfEntry = payload.find(p => p.dataKey === "totalBU");
  const peerEntry = payload.find(p => p.dataKey === "peerBU");
  const buNum    = selfEntry ? Number(selfEntry.value ?? 0) : 0;
  const peerNum  = peerEntry?.value != null ? Number(peerEntry.value) : null;
  const unit     = granularity === "hour" ? "BUs/h" : "BUs";

  const delta    = target != null ? buNum - target : null;
  const pct      = target != null && target > 0 ? (buNum / target) * 100 : null;
  const hit      = delta != null && delta >= 0;

  const fmtBu = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md text-xs text-gray-200 px-3 py-2 shadow-lg">
      {label && <div className="text-gray-400 mb-1.5">{fmtLabelFn(label)}</div>}

      {/* Self */}
      <div className="flex items-baseline gap-2">
        <span className="text-cyan-300 font-semibold tabular-nums">{fmtBu(buNum)}</span>
        <span className="text-gray-500">{unit}</span>
      </div>

      {/* Peer comparison if present */}
      {peerNum != null && (
        <div className="flex items-baseline gap-2 mt-0.5">
          <span className="text-amber-300 tabular-nums">{fmtBu(peerNum)}</span>
          <span className="text-gray-500">{peerLabel ?? "peers"}</span>
        </div>
      )}

      {/* Target + delta */}
      {target != null && (
        <div className="mt-2 pt-2 border-t border-gray-700/60">
          <div className="flex items-baseline gap-2 text-gray-400">
            <span>Target:</span>
            <span className="tabular-nums">{fmtBu(target)}</span>
            <span>{unit}</span>
          </div>
          {delta != null && (
            <div className={`flex items-baseline gap-1.5 mt-0.5 font-semibold ${hit ? "text-green-400" : "text-red-400"}`}>
              <i className={hit ? "bi bi-check-circle-fill" : "bi bi-arrow-down-circle-fill"} />
              <span className="tabular-nums">
                {hit ? "+" : ""}{fmtBu(delta)}
              </span>
              {pct != null && (
                <span className="text-gray-400 font-normal">
                  ({Math.round(pct)}% of target)
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Custom Tooltip for the percentage charts (Uptime, Scrap). Same hit/miss
// pattern as the BU tooltip — show the per-bucket value, the configured
// target threshold (the boundary between "Good" and "Mediocre" zones),
// and the signed delta in percentage points.
//
// `invert=false` (Uptime): higher is better → hit when actual >= target.
// `invert=true`  (Scrap):  lower  is better → hit when actual <= target.
// In both cases the delta sign matches actual − target; only the
// hit-state icon and color flip.
function PctTargetTooltipContent({
  active, payload, label,
  selfKey, peerKey,
  target, invert,
  fmtLabelFn, peerLabel,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  active?: boolean; payload?: any[]; label?: string;
  selfKey: string;
  peerKey: string;
  target: number | null;
  invert: boolean;
  fmtLabelFn: (key: string) => string;
  peerLabel?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;

  const selfEntry = payload.find(p => p.dataKey === selfKey);
  const peerEntry = payload.find(p => p.dataKey === peerKey);
  const val      = selfEntry ? Number(selfEntry.value ?? 0) : 0;
  const peerVal  = peerEntry?.value != null ? Number(peerEntry.value) : null;

  const delta    = target != null ? val - target : null;
  const hit      = delta != null && (invert ? delta <= 0 : delta >= 0);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-md text-xs text-gray-200 px-3 py-2 shadow-lg">
      {label && <div className="text-gray-400 mb-1.5">{fmtLabelFn(label)}</div>}

      <div className="flex items-baseline gap-2">
        <span className="text-cyan-300 font-semibold tabular-nums">{fmtPct(val, 1)}</span>
      </div>

      {peerVal != null && (
        <div className="flex items-baseline gap-2 mt-0.5">
          <span className="text-amber-300 tabular-nums">{fmtPct(peerVal, 1)}</span>
          <span className="text-gray-500">{peerLabel ?? "peers"}</span>
        </div>
      )}

      {target != null && (
        <div className="mt-2 pt-2 border-t border-gray-700/60">
          <div className="flex items-baseline gap-2 text-gray-400">
            <span>Target:</span>
            <span className="tabular-nums">
              {invert ? "≤ " : "≥ "}{fmtPct(target, 1)}
            </span>
          </div>
          {delta != null && (
            <div className={`flex items-baseline gap-1.5 mt-0.5 font-semibold ${hit ? "text-green-400" : "text-red-400"}`}>
              <i className={hit ? "bi bi-check-circle-fill" : "bi bi-x-circle-fill"} />
              <span className="tabular-nums">
                {delta >= 0 ? "+" : ""}{delta.toFixed(1)} pp
              </span>
              <span className="text-gray-400 font-normal">
                {hit
                  ? (invert ? "below target" : "above target")
                  : (invert ? "above target" : "below target")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function KpiTile({ icon, label, value, sub, colorClass, borderClass }: {
  icon: string; label: string; value: string;
  sub?: string; colorClass: string; borderClass: string;
}) {
  return (
    <div className={`bg-gray-800/50 border-l-4 ${borderClass} rounded-lg px-5 py-4 flex flex-col gap-1`}>
      <div className="flex items-center gap-2 text-gray-400 text-xs">
        <i className={`bi ${icon}`}></i>
        {label}
      </div>
      <div className={`text-2xl font-bold ${colorClass}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, legend, children }: {
  title: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="bg-gray-800/50 border border-gray-700 rounded-lg p-4"
      style={{ outline: "none" }}
      tabIndex={-1}
      onMouseDown={e => e.preventDefault()}
    >
      <style>{`
        .recharts-wrapper:focus,
        .recharts-surface:focus { outline: none !important; }
      `}</style>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {legend && <div className="flex items-center gap-3 text-xs text-gray-500">{legend}</div>}
      </div>
      {children}
    </div>
  );
}

function NoData() {
  return (
    <div className="flex flex-col items-center justify-center h-[220px] gap-2">
      <i className="bi bi-inbox text-3xl text-gray-600"></i>
      <p className="text-sm text-gray-500">No data for this period</p>
      <p className="text-xs text-gray-600 max-w-xs text-center">
        Shift readings appear here once machines send data via the PLC
      </p>
    </div>
  );
}

function ZoneLegend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: color, opacity: 0.25 }} />
      {label}
    </span>
  );
}

// ─── Period selector ─────────────────────────────────────────────────────────

export function PeriodSelector({
  activePresetId,
  dateRange,
  onPresetSelect,
  onCustomRange,
  factoryTz,
  fleetSize = 0,
}: {
  activePresetId: PresetId | "custom";
  dateRange:      DateRange;
  onPresetSelect: (preset: Preset) => void;
  onCustomRange:  (range: DateRange) => void;
  factoryTz:      string;
  fleetSize?:     number;
}) {
  const [open, setOpen] = useState(false);
  const [customStart, setCustomStart] = useState(() => toDateTimeInputValue(dateRange.start, factoryTz));
  const [customEnd, setCustomEnd] = useState(() => toDateTimeInputValue(dateRange.end, factoryTz));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCustomStart(toDateTimeInputValue(dateRange.start, factoryTz));
    setCustomEnd(toDateTimeInputValue(dateRange.end, factoryTz));
  }, [dateRange, factoryTz]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const buttonLabel =
    activePresetId === "custom"
      ? `${format(dateRange.start, "dd.MM HH:mm")} – ${format(dateRange.end, "dd.MM HH:mm")}`
      : PRESETS.find(p => p.id === activePresetId)?.label ?? "Select period";

  // Validate the inputs and preview the resulting query. The granularity ladder
  // guarantees a sane resolution (5s only for <=1h windows, coarser otherwise),
  // so a runaway is impossible by construction — we just surface what it'll be
  // and block invalid ranges.
  const preview: { error: string } | { start: Date; end: Date; gran: "5s" | "5m" | "1h" | "1d"; readings: number } = (() => {
    const start = parseFactoryInput(customStart, factoryTz);
    const end   = parseFactoryInput(customEnd, factoryTz);
    const now   = new Date();
    if (!start || !end) return { error: "Pick a valid start and end" };
    if (start >= end)   return { error: "Start must be before end" };
    if (start > now)    return { error: "Start is in the future" };
    const clampedEnd = end > now ? now : end;          // never query past 'now'
    const gran = pickGranularity({ start, end: clampedEnd });
    const readings = Math.round((clampedEnd.getTime() - start.getTime()) / 5000) * (fleetSize > 0 ? fleetSize : 18);
    return { start, end: clampedEnd, gran, readings };
  })();
  const invalid = "error" in preview;

  function applyCustom() {
    if ("error" in preview) return;
    onCustomRange({ start: preview.start, end: preview.end });
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
      >
        <i className="bi bi-calendar3 text-xs text-gray-500"></i>
        {buttonLabel}
        <i className={`bi bi-chevron-${open ? "up" : "down"} text-xs text-gray-500`}></i>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 flex bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="py-2 border-r border-gray-800 min-w-[160px]">
            {PRESETS.map(preset => (
              <button
                key={preset.id}
                onClick={() => { onPresetSelect(preset); setOpen(false); }}
                className={`w-full text-left px-4 py-1.5 text-sm transition-colors ${
                  activePresetId === preset.id
                    ? "text-cyan-400 bg-cyan-950/50"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="p-4 flex flex-col gap-3 min-w-[240px]">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Custom range · factory time</p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">From</span>
              <input
                type="datetime-local"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-cyan-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">To</span>
              <input
                type="datetime-local"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-cyan-600"
              />
            </label>
            {invalid
              ? <p className="text-xs text-red-400"><i className="bi bi-exclamation-circle mr-1"></i>{(preview as { error: string }).error}</p>
              : <p className="text-xs text-gray-500">
                  <i className="bi bi-bar-chart-line mr-1"></i>
                  {GRAN_LABEL[(preview as { gran: string }).gran]} resolution · ~{fmtReadingCount((preview as { readings: number }).readings)} readings
                </p>}
            <button
              onClick={applyCustom}
              disabled={invalid}
              className="mt-1 w-full px-3 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white text-sm rounded-lg transition-colors font-semibold flex items-center justify-center gap-1.5"
            >
              <i className="bi bi-check-lg"></i>
              Confirm range
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Error annotation strip (24h chart only) ─────────────────────────────────

const ERROR_BRACKET_COLOR = "#fb923c";  // orange-400
const ERROR_LABEL_COLOR   = "#fdba74";  // orange-300
const ERROR_LANE_HEIGHT   = 18;
const ERROR_STRIP_PADDING = 8;
const ERROR_LABEL_FONT    = 9;
const ERROR_LABEL_CHAR_PX = 5.8;        // approx width per char at 9px monospace
const ERROR_CAP_HEIGHT    = 3;          // half-height of vertical end caps

interface PackedError {
  ev: ErrorEvent;
  startPx: number;
  endPx: number;
  lane: number;
  openLeft: boolean;
  openRight: boolean;
}

// Greedy lane packing for error spans below the timeline.
// Lane occupancy reserves the bracket *plus* the centered label width, so two
// short bursts with overlapping labels still get separated into different lanes.
function packErrorLanes(
  events: ErrorEvent[],
  firstBucketTime: number,
  lastBucketTime: number,
  pxLeft: number,
  pxRight: number,
): { items: PackedError[]; laneCount: number } {
  if (events.length === 0 || pxRight <= pxLeft || lastBucketTime <= firstBucketTime) {
    return { items: [], laneCount: 0 };
  }

  // The chart plots first-bucket-start at pxLeft and last-bucket-start at
  // pxRight. Linear interpolation between those two anchors keeps the strip
  // aligned with the line chart's x-axis. Events that extend past the last
  // bucket (active errors or errors in the current partial hour) clamp to
  // pxRight and get the open-right arrow cap.
  const timeToPx = (t: number) => {
    if (t <= firstBucketTime) return pxLeft;
    if (t >= lastBucketTime)  return pxRight;
    return pxLeft + ((t - firstBucketTime) / (lastBucketTime - firstBucketTime)) * (pxRight - pxLeft);
  };

  // Effective right edge of the strip's time window — includes the current
  // partial hour and any active error that's still running.
  const windowEnd = Math.max(lastBucketTime + 3_600_000, Date.now());

  const sorted = [...events].sort((a, b) =>
    new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
  );

  const lanes: number[] = [];  // lanes[i] = right-edge px of last placed item
  const items: PackedError[] = [];

  for (const ev of sorted) {
    const startMs = new Date(ev.started_at).getTime();
    const endMs   = ev.ended_at ? new Date(ev.ended_at).getTime() : Date.now();
    if (endMs <= firstBucketTime || startMs >= windowEnd) continue;

    const clampedStart = Math.max(firstBucketTime, startMs);
    const clampedEnd   = Math.min(windowEnd,       endMs);
    if (clampedEnd <= clampedStart) continue;

    let startPx = timeToPx(clampedStart);
    let endPx   = timeToPx(clampedEnd);
    startPx = Math.max(pxLeft,  Math.min(pxRight, startPx));
    endPx   = Math.max(pxLeft,  Math.min(pxRight, endPx));
    if (endPx - startPx < 2) endPx = startPx + 2;  // ensure visible minimum

    const labelW    = ev.error_code.length * ERROR_LABEL_CHAR_PX + 4;
    const centerX   = (startPx + endPx) / 2;
    const occStart  = Math.min(startPx, centerX - labelW / 2);
    const occEnd    = Math.max(endPx,   centerX + labelW / 2);

    let lane = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] + 2 <= occStart) {
        lane = i;
        lanes[i] = occEnd;
        break;
      }
    }
    if (lane === -1) {
      lanes.push(occEnd);
      lane = lanes.length - 1;
    }

    items.push({
      ev,
      startPx,
      endPx,
      lane,
      openLeft:  startMs < firstBucketTime,
      openRight: !ev.ended_at || endMs > lastBucketTime,  // chart visually ends at last bucket
    });
  }
  return { items, laneCount: lanes.length };
}

interface ErrorBracketLayerProps {
  events: ErrorEvent[];
  errorLookup: Record<string, PlcErrorCode>;
  firstBucketTime: number;
  lastBucketTime: number;
  stripTopY: number;
}

function fmtTimeHM(ms: number): string {
  return format(new Date(ms), "HH:mm:ss");
}
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

// Rendered as a direct child of the recharts LineChart. usePlotArea() returns
// the plot area in chart-SVG coordinates, which gives us a stable horizontal
// frame to align the bracket strip with the chart's x-axis without depending
// on the deprecated <Customized> prop-injection pattern.
function ErrorBracketLayer(props: ErrorBracketLayerProps) {
  const { events, errorLookup, firstBucketTime, lastBucketTime, stripTopY } = props;
  const plotArea = usePlotArea();
  const [hover, setHover] = useState<{ ev: ErrorEvent; x: number; y: number } | null>(null);

  if (!plotArea) return null;

  const { items } = packErrorLanes(
    events, firstBucketTime, lastBucketTime,
    plotArea.x, plotArea.x + plotArea.width,
  );
  if (items.length === 0) return null;

  const onEnter = (ev: ErrorEvent) => (e: React.MouseEvent<SVGGElement>) => {
    const rect = (e.currentTarget as SVGGraphicsElement).getBoundingClientRect();
    // Viewport-aware placement so the tooltip is never clipped at the bottom
    // or right edge of the screen. Dimensions are estimated worst-case from
    // the tooltip's min/max-width and content; an overshoot of a few pixels
    // is fine because the tooltip itself flexes around its content.
    const TT_WIDTH  = 300;
    const TT_HEIGHT = 130;
    const MARGIN    = 8;

    let y = rect.bottom + 4;
    if (y + TT_HEIGHT + MARGIN > window.innerHeight) {
      y = rect.top - TT_HEIGHT - 4;
    }
    y = Math.max(MARGIN, y);

    let x = rect.left;
    if (x + TT_WIDTH + MARGIN > window.innerWidth) {
      x = window.innerWidth - TT_WIDTH - MARGIN;
    }
    x = Math.max(MARGIN, x);

    setHover({ ev, x, y });
  };
  const onLeave = () => setHover(null);

  const hoverInfo = hover
    ? (() => {
        const codeStr = hover.ev.error_code;
        const info = errorLookup[codeStr];
        const startMs = new Date(hover.ev.started_at).getTime();
        const endMs   = hover.ev.ended_at ? new Date(hover.ev.ended_at).getTime() : null;
        const durSecs = hover.ev.duration_secs
          ?? (endMs ? Math.round((endMs - startMs) / 1000) : Math.round((Date.now() - startMs) / 1000));
        return {
          codeStr,
          description: info?.description ?? "Unknown",
          startLabel: fmtTimeHM(startMs),
          endLabel:   endMs ? fmtTimeHM(endMs) : "ongoing",
          durLabel:   fmtDuration(durSecs),
        };
      })()
    : null;

  return (
    <>
      <g>
        {items.map((it) => {
          const y = stripTopY + it.lane * ERROR_LANE_HEIGHT + ERROR_LANE_HEIGHT / 2;
          const labelY = y + ERROR_LABEL_FONT + 1;
          const centerX = (it.startPx + it.endPx) / 2;
          // Hit area: spans bracket + label width so thin brackets are still
          // hoverable. Vertical extent covers cap height + label.
          const hitX = Math.min(it.startPx, centerX - 14);
          const hitW = Math.max(it.endPx - it.startPx, 28);
          return (
            <g
              key={it.ev.id}
              onMouseEnter={onEnter(it.ev)}
              onMouseLeave={onLeave}
              style={{ cursor: "default" }}
            >
              <rect
                x={hitX} y={y - ERROR_CAP_HEIGHT - 2}
                width={hitW} height={ERROR_LANE_HEIGHT}
                fill="transparent"
              />
              <line
                x1={it.startPx} x2={it.endPx} y1={y} y2={y}
                stroke={ERROR_BRACKET_COLOR} strokeWidth={1.5}
                pointerEvents="none"
              />
              {!it.openLeft && (
                <line
                  x1={it.startPx} x2={it.startPx}
                  y1={y - ERROR_CAP_HEIGHT} y2={y + ERROR_CAP_HEIGHT}
                  stroke={ERROR_BRACKET_COLOR} strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
              {!it.openRight && (
                <line
                  x1={it.endPx} x2={it.endPx}
                  y1={y - ERROR_CAP_HEIGHT} y2={y + ERROR_CAP_HEIGHT}
                  stroke={ERROR_BRACKET_COLOR} strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
              {it.openLeft && (
                <polyline
                  points={`${it.startPx + 4},${y - ERROR_CAP_HEIGHT} ${it.startPx},${y} ${it.startPx + 4},${y + ERROR_CAP_HEIGHT}`}
                  fill="none" stroke={ERROR_BRACKET_COLOR} strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
              {it.openRight && (
                <polyline
                  points={`${it.endPx - 4},${y - ERROR_CAP_HEIGHT} ${it.endPx},${y} ${it.endPx - 4},${y + ERROR_CAP_HEIGHT}`}
                  fill="none" stroke={ERROR_BRACKET_COLOR} strokeWidth={1.5}
                  pointerEvents="none"
                />
              )}
              <text
                x={centerX} y={labelY}
                fill={ERROR_LABEL_COLOR}
                fontSize={ERROR_LABEL_FONT}
                fontFamily="ui-monospace, monospace"
                textAnchor="middle"
                pointerEvents="none"
              >
                {it.ev.error_code}
              </text>
            </g>
          );
        })}
      </g>
      {hover && hoverInfo && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-[9999] bg-slate-800 border border-slate-600 rounded-lg p-3 shadow-xl min-w-[260px] max-w-[420px] pointer-events-none"
          style={{ left: hover.x, top: hover.y }}
        >
          <div className="flex items-baseline gap-2 mb-2 pb-2 border-b border-gray-700">
            <span className="font-mono text-sm text-red-300">{hoverInfo.codeStr}</span>
            <span className="text-xs text-gray-300 flex-1">{hoverInfo.description}</span>
          </div>
          <table className="w-full text-xs">
            <tbody>
              <tr>
                <td className="py-0.5 pr-3 text-gray-500">Start</td>
                <td className="py-0.5 font-mono text-gray-200">{hoverInfo.startLabel}</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-3 text-gray-500">End</td>
                <td className="py-0.5 font-mono text-gray-200">{hoverInfo.endLabel}</td>
              </tr>
              <tr>
                <td className="py-0.5 pr-3 text-gray-500">Duration</td>
                <td className="py-0.5 font-mono text-gray-200">{hoverInfo.durLabel}</td>
              </tr>
            </tbody>
          </table>
        </div>,
        document.body,
      )}
    </>
  );
}

// ─── Production Trend section ────────────────────────────────────────────────

// Recompute uptime from summed raw seconds the same way calcCorrectedEfficiency
// does in app/page.tsx. The PLC's IdleTime counter already includes ErrorTime,
// so (idle − error) un-duplicates them before the planned-downtime budget gets
// to forgive any pure-idle leftover. Returns null when there's no production
// AND no idle (machine never reported in the window).
function correctedUptimeFromSeconds(
  productionSecs: number,
  idleSecs: number,
  errorSecs: number,
  plannedDowntimeSecs: number,
): number | null {
  if (productionSecs === 0 && idleSecs === 0) return null;
  const idleOnlySecs      = Math.max(0, idleSecs - errorSecs);
  const unplannedIdleSecs = Math.max(0, idleOnlySecs - plannedDowntimeSecs);
  const effectiveSecs     = productionSecs + unplannedIdleSecs + errorSecs;
  return effectiveSecs > 0 ? (productionSecs / effectiveSecs) * 100 : null;
}

const PEER_LINE_COLOR = "#fbbf24"; // amber-400

export function ProductionTrendSection({
  rows,
  granularity,
  loading,
  error,
  thresholds,
  buTargetPerShift,
  buMediocrePerShift,
  dateRange,
  showTotalSwabs = true,
  kpiSubLabel = "Selected period",
  chartTitleSuffix,
  peerRows = [],
  peerLabel,
  peerCount = 0,
  errorEvents = [],
  errorLookup = {},
  showUptimeChart = true,
  afterKpis,
  fleetSize = 0,
}: {
  rows: FleetTrendRow[];
  granularity: "hour" | "day";
  loading: boolean;
  error: string | null;
  thresholds: Thresholds;
  buTargetPerShift: number | null;
  buMediocrePerShift: number | null;
  dateRange: DateRange;
  showTotalSwabs?: boolean;
  fleetSize?: number;   // machine count, for the loading "~N readings" estimate
  kpiSubLabel?: string;
  chartTitleSuffix?: string;
  peerRows?: FleetTrendRow[];
  peerLabel?: string;
  // Distinct peer machines aggregated into peerRows. Used by the corrected
  // Avg Uptime formula to size the planned-downtime budget (per-shift budget
  // × shifts in window × peer count). 0 when no peer comparison is shown.
  peerCount?: number;
  errorEvents?: ErrorEvent[];
  errorLookup?: Record<string, PlcErrorCode>;
  // When false, the Avg Uptime line chart is suppressed. The Machine Monitor
  // page hides it in the intraday view because the new state timeline below
  // replaces the same information in a more actionable form.
  showUptimeChart?: boolean;
  // Optional slot rendered between the KPI tile row and the trend charts.
  // The Machine Monitor uses this to position its state timeline directly
  // under the KPIs without leaking layout details into this component.
  afterKpis?: React.ReactNode;
}) {
  // Factory timezone — used by every label/tooltip formatter on this chart
  // so the X-axis reads in the operator's wall-clock time, not the browser's.
  const factoryTz = useFactoryTimezone();

  const hasData    = rows.length > 0;
  const avgScrap   = hasData ? rows.reduce((s, d) => s + d.avgScrap,  0) / rows.length : null;
  const totalSwabs = rows.reduce((s, d) => s + d.totalSwabs, 0);
  const totalBUs   = Math.round(totalSwabs / 7200);

  const shiftHours   = thresholds.bu.shiftLengthMinutes / 60 || 8;
  const shiftsPerDay = Math.max(1, Math.round(24 / shiftHours));

  // Corrected uptime over the whole window — mirrors calcCorrectedEfficiency
  // in app/page.tsx (the formula behind the park-overview Uptime column). The
  // PLC's IdleTime already includes ErrorTime, so the (idle − error) step
  // strips the double-count; the planned-downtime budget then forgives
  // scheduled breaks from the pure-idle remainder only — never from error
  // time. Used by the KPI tile so a single machine reads the same way here
  // as it does on the park overview, just summed over whatever window the
  // user picked instead of the current shift.
  const windowHours      = Math.max(0, (dateRange.end.getTime() - dateRange.start.getTime()) / 3_600_000);
  const shiftsInWindow   = shiftHours > 0 ? windowHours / shiftHours : 0;
  const plannedSecsBudget = (thresholds.bu.plannedDowntimeMinutes || 0) * 60 * shiftsInWindow;

  const hasCounters = rows.some(r => r.productionSeconds !== undefined);
  const avgUptime: number | null = hasCounters
    ? correctedUptimeFromSeconds(
        rows.reduce((s, r) => s + (r.productionSeconds ?? 0), 0),
        rows.reduce((s, r) => s + (r.idleSeconds       ?? 0), 0),
        rows.reduce((s, r) => s + (r.errorSeconds      ?? 0), 0),
        plannedSecsBudget,
      )
    : (hasData ? rows.reduce((s, d) => s + d.avgUptime, 0) / rows.length : null);

  // Detect the sub-daily bucket size from the first two rows so the BU chart
  // can rate-normalise its y-axis to "BUs/hour" regardless of bucket length
  // (15-min buckets are 1/4 of the legacy 60-min buckets).
  // Smallest gap between consecutive buckets = the true bucket width. Using the
  // min (not rows[1]-rows[0]) is robust to leading gaps, and we do NOT round to
  // whole minutes so sub-minute grains (5s = 1/12 min) rate-normalise correctly.
  const bucketMinutes = (() => {
    if (granularity !== "hour" || rows.length < 2) return 60;
    let minMs = Infinity;
    for (let i = 1; i < rows.length; i++) {
      const g = parseBucketKey(rows[i].date).getTime() - parseBucketKey(rows[i - 1].date).getTime();
      if (g > 0 && g < minMs) minMs = g;
    }
    return minMs === Infinity ? 60 : Math.max(1 / 60, minMs / 60_000);
  })();
  const buRateMultiplier = granularity === "hour" ? 60 / bucketMinutes : 1;

  // Peer benchmark series. Aligned to the same date keys as `rows`; missing
  // buckets render as line breaks (recharts skips null y-values with monotone).
  const hasPeers = peerRows.length > 0;
  const peerByDate = new Map(peerRows.map(r => [r.date, r]));
  // Peer planned-downtime budget scales with peer count: each peer machine
  // gets its own per-shift break allowance, so summing peer seconds and
  // applying the corrected formula needs N × the per-machine budget for the
  // ratio to come out as the per-peer average.
  const peerHasCounters    = peerRows.some(r => r.productionSeconds !== undefined);
  const peerPlannedSecs    = plannedSecsBudget * Math.max(1, peerCount);
  const peerAvgUptime = peerHasCounters
    ? correctedUptimeFromSeconds(
        peerRows.reduce((s, r) => s + (r.productionSeconds ?? 0), 0),
        peerRows.reduce((s, r) => s + (r.idleSeconds       ?? 0), 0),
        peerRows.reduce((s, r) => s + (r.errorSeconds      ?? 0), 0),
        peerPlannedSecs,
      )
    : (hasPeers ? peerRows.reduce((s, d) => s + d.avgUptime, 0) / peerRows.length : null);
  const peerAvgScrap  = hasPeers ? peerRows.reduce((s, d) => s + d.avgScrap,  0) / peerRows.length : null;
  // Peer fetchers already return per-peer averages, so summing into BUs gives
  // "BUs per peer in this period" — directly comparable to the machine's own.
  const peerTotalSwabs = peerRows.reduce((s, d) => s + d.totalSwabs, 0);
  const peerTotalBUs   = Math.round(peerTotalSwabs / 7200);

  const rowsWithPeer = rows.map(r => {
    const p = peerByDate.get(r.date);
    return {
      ...r,
      peerUptime: p ? p.avgUptime : null,
      peerScrap:  p ? p.avgScrap  : null,
    };
  });

  // For sub-hour intraday buckets we rate-normalise to BUs/hour so the y-axis
  // and target lines (which are per-hour) stay consistent across granularities.
  const buRows = rows.map(r => {
    const totalBU = Math.round((r.totalSwabs / 7200) * buRateMultiplier * 10) / 10;
    const p = peerByDate.get(r.date);
    const peerBU = p ? Math.round((p.totalSwabs / 7200) * buRateMultiplier * 10) / 10 : null;
    return { ...r, totalBU, peerBU };
  });

  const buTargetLine = buTargetPerShift !== null
    ? (granularity === "hour" ? buTargetPerShift / shiftHours : buTargetPerShift * shiftsPerDay)
    : null;
  const buMediocreLine = buMediocrePerShift !== null
    ? (granularity === "hour" ? buMediocrePerShift / shiftHours : buMediocrePerShift * shiftsPerDay)
    : null;

  const expectedShiftsInPeriod = granularity === "day"
    ? buRows.reduce((s, r) => s + Math.max(1, r.shiftCount), 0)
    : Math.max(1, windowHours / shiftHours);
  const buKpiGood     = buTargetPerShift !== null ? buTargetPerShift * expectedShiftsInPeriod : null;
  const buKpiMediocre = buMediocrePerShift !== null ? buMediocrePerShift * expectedShiftsInPeriod : null;

  const ec = applyEfficiencyColor(avgUptime, thresholds);
  const sc = applyScrapColor(avgScrap, thresholds);
  const buKpiColor = (() => {
    if (totalBUs <= 0 || buKpiGood === null || buKpiMediocre === null)
      return { text: "text-gray-500", border: "border-gray-700" };
    if (totalBUs >= buKpiGood)     return { text: "text-green-400",  border: "border-green-700" };
    if (totalBUs >= buKpiMediocre) return { text: "text-yellow-400", border: "border-yellow-700" };
    return { text: "text-red-400", border: "border-red-700" };
  })();
  const swabsKpiColor = (() => {
    if (totalSwabs <= 0 || buKpiGood === null || buKpiMediocre === null)
      return { text: "text-gray-500", border: "border-gray-700" };
    if (totalSwabs >= buKpiGood * 7200)     return { text: "text-green-400",  border: "border-green-700" };
    if (totalSwabs >= buKpiMediocre * 7200) return { text: "text-yellow-400", border: "border-yellow-700" };
    return { text: "text-red-400", border: "border-red-700" };
  })();

  const dailyTickIndices = granularity === "day" ? filterDailyTicks(rows) : [];

  // For intraday (sub-hour buckets) pass an explicit `ticks` array containing
  // only the bucket keys aligned to the integer hour, downsampled to keep at
  // most ~24 labels visible. Recharts will only render ticks at those
  // positions, which is what gives the x-axis the "10:00 11:00 12:00" feel.
  const hourTicks = granularity === "hour"
    ? (() => {
        // Sub-minute grains (5s) mark the top of each MINUTE; coarser grains the
        // top of each HOUR. Then downsample to keep ~24 labels visible.
        const subMinute = bucketMinutes < 1;
        const aligned = rows.filter(r => {
          const d = parseBucketKey(r.date);
          return subMinute ? d.getUTCSeconds() === 0 : d.getUTCMinutes() === 0;
        }).map(r => r.date);
        const MAX_LABELS = 24;
        const step = Math.max(1, Math.ceil(aligned.length / MAX_LABELS));
        return aligned.filter((_, i) => i % step === 0);
      })()
    : undefined;

  const dailyTicks = granularity === "day"
    ? dailyTickIndices.map(i => rows[i].date)
    : undefined;
  const explicitTicks = dailyTicks ?? hourTicks;

  const visibleTicks = granularity === "day"
    ? dailyTickIndices.length
    : (hourTicks?.length ?? rows.length);
  const shouldAngle = visibleTicks > 14;

  // ── Error annotation strip (intraday view only) ──
  // Lane-pack errors against a dummy 1-unit-wide range first so we know the
  // lane count without depending on rendered chart width. The actual pixel
  // positions are computed inside the Customized layer where offset is known.
  const showErrorStrip = granularity === "hour" && hasData && errorEvents.length > 0;
  const firstBucketTime = showErrorStrip ? parseBucketKey(rows[0].date).getTime() : 0;
  const lastBucketTime  = showErrorStrip ? parseBucketKey(rows[rows.length - 1].date).getTime() : 0;
  const errorLaneCount = showErrorStrip
    ? packErrorLanes(errorEvents, firstBucketTime, lastBucketTime, 0, 1000).laneCount
    : 0;
  const errorStripHeight = errorLaneCount > 0
    ? errorLaneCount * ERROR_LANE_HEIGHT + ERROR_STRIP_PADDING * 2
    : 0;

  const scrapDataMax = hasData ? Math.max(...rows.map(r => r.avgScrap)) : 0;
  const peerScrapMax = hasPeers ? Math.max(...peerRows.map(r => r.avgScrap)) : 0;
  const scrapMax     = Math.ceil(Math.max(scrapDataMax, peerScrapMax, thresholds.scrap.mediocre) + 1);

  const buDataMax     = hasData ? Math.max(...buRows.map(r => r.totalBU)) : 0;
  const peerBuDataMax = hasPeers ? Math.max(...peerRows.map(r => Math.round((r.totalSwabs / 7200) * 10) / 10)) : 0;
  const buMax         = Math.ceil(Math.max(buDataMax, peerBuDataMax, buTargetLine ?? 0, buMediocreLine ?? 0) * 1.15);

  // Delta subtext helpers — appear below KPI tile value when peers are present.
  // For uptime and BU, higher is better → "+" means above peers.
  // For scrap, lower is better → "+" means worse than peers.
  const fmtDeltaPP = (selfV: number | null, peerV: number | null) => {
    if (selfV === null || peerV === null) return null;
    const d = selfV - peerV;
    const sign = d > 0 ? "+" : "";
    return `${sign}${d.toFixed(1)} pp vs peers`;
  };
  const fmtDeltaBU = (selfV: number, peerV: number) => {
    if (peerV <= 0) return null;
    const d = selfV - peerV;
    const sign = d > 0 ? "+" : "";
    return `${sign}${d.toLocaleString()} BUs vs peers`;
  };
  const uptimeSub = hasPeers ? fmtDeltaPP(avgUptime, peerAvgUptime) ?? kpiSubLabel : kpiSubLabel;
  const scrapSub  = hasPeers ? fmtDeltaPP(avgScrap,  peerAvgScrap)  ?? kpiSubLabel : kpiSubLabel;
  const buSub     = hasPeers
    ? (fmtDeltaBU(totalBUs, peerTotalBUs) ?? (buKpiGood !== null ? `Target: ${Math.round(buKpiGood).toLocaleString()} BUs` : `Business units · ${kpiSubLabel.toLowerCase()}`))
    : (buKpiGood !== null ? `Target: ${Math.round(buKpiGood).toLocaleString()} BUs` : `Business units · ${kpiSubLabel.toLowerCase()}`);

  const chartTitle = chartTitleSuffix ?? (granularity === "hour" ? "— intraday" : "— daily");
  const fmtLabel = (key: string) => fmtBucketFull(key, granularity, factoryTz);

  if (loading) {
    // Skeleton that mirrors the real layout (KPI tiles + 3 chart cards) so the
    // page structure appears instantly and shimmers while data loads, instead
    // of blanking out for the ~2s a long-range query can take.
    const tileCount = showTotalSwabs ? 4 : 3;
    // Rough size of the window being analysed (readings ≈ window / 5s × fleet),
    // shown so the wait has context — "a year of 5-second data" explains ~2s.
    const windowMs = Math.max(0, dateRange.end.getTime() - dateRange.start.getTime());
    const readings = Math.round(windowMs / 5000) * (fleetSize > 0 ? fleetSize : 18);
    const fmtCount = (n: number) =>
      n >= 1e9 ? `${(n / 1e9).toFixed(1)}B`
      : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M`
      : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K`
      : `${n}`;
    return (
      <div>
        <div className="flex items-center gap-2 text-sm text-gray-400 mb-4">
          <span className="inline-block w-3.5 h-3.5 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin"></span>
          Fetching data{readings > 0 ? ` · analysing ~${fmtCount(readings)} readings` : ""}…
        </div>
        <div className="animate-pulse">
          <div className={`grid ${showTotalSwabs ? "grid-cols-4" : "grid-cols-3"} gap-3 mb-5`}>
            {Array.from({ length: tileCount }).map((_, i) => (
              <div key={i} className="bg-gray-800/50 border-l-4 border-gray-700 rounded-lg px-5 py-4 flex flex-col gap-2.5">
                <div className="h-3 w-24 bg-gray-700/60 rounded" />
                <div className="h-7 w-20 bg-gray-700/70 rounded" />
                <div className="h-2.5 w-28 bg-gray-700/40 rounded" />
              </div>
            ))}
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-4">
              <div className="h-4 w-56 bg-gray-700/60 rounded mb-4" />
              <div className="h-[220px] bg-gray-700/20 rounded" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-3">
          <i className="bi bi-exclamation-circle mr-2"></i>{error}
        </div>
      )}

      {/* KPI tiles */}
      <div className={`grid ${showTotalSwabs ? "grid-cols-4" : "grid-cols-3"} gap-3 mb-5`}>
        <KpiTile
          icon="bi-speedometer2"
          label="Avg Uptime"
          value={fmtPct(avgUptime, 1)}
          sub={uptimeSub}
          colorClass={ec.text}
          borderClass={ec.border}
        />
        <KpiTile
          icon="bi-exclamation-triangle"
          label="Avg Scrap Rate"
          value={fmtPct(avgScrap, 1)}
          sub={scrapSub}
          colorClass={sc.text}
          borderClass={sc.border}
        />
        <KpiTile
          icon="bi-bullseye"
          label="Total BU Output"
          value={totalBUs > 0 ? totalBUs.toLocaleString() : "—"}
          sub={buSub}
          colorClass={buKpiColor.text}
          borderClass={buKpiColor.border}
        />
        {showTotalSwabs && (
          <KpiTile
            icon="bi-diamond"
            label="Total Swabs"
            value={totalSwabs > 0 ? fmtMillions(totalSwabs) : "—"}
            sub={buKpiGood !== null ? `Target: ${fmtMillions(buKpiGood * 7200)}` : `Swabs produced · ${kpiSubLabel.toLowerCase()}`}
            colorClass={swabsKpiColor.text}
            borderClass={swabsKpiColor.border}
          />
        )}
      </div>

      {afterKpis && <div className="mb-5">{afterKpis}</div>}

      {/* Trend charts — one per row so each gets full width */}
      <div className="flex flex-col gap-4 mb-4">
        <ChartCard
          title={`Total BU Output ${chartTitle}`}
          legend={
            <>
              {hasPeers && peerLabel && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5 rounded-sm" style={{ backgroundColor: PEER_LINE_COLOR }} />
                  {peerLabel}
                </span>
              )}
              {buTargetLine !== null && (
                <>
                  <ZoneLegend color="#4ade80" label={`Good (≥${Math.round(buTargetLine).toLocaleString()} BUs${granularity === "hour" ? "/h" : "/day"})`} />
                  <ZoneLegend color="#eab308" label={`Mediocre (≥${Math.round(buMediocreLine ?? 0).toLocaleString()})`} />
                  <ZoneLegend color="#ef4444" label={`Poor (<${Math.round(buMediocreLine ?? 0).toLocaleString()})`} />
                </>
              )}
            </>
          }
        >
          {!hasData ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={buRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                {buTargetLine !== null && (
                  <ReferenceArea y1={buTargetLine} y2={buMax} fill="#4ade80" fillOpacity={0.15} />
                )}
                {buTargetLine !== null && buMediocreLine !== null && (
                  <ReferenceArea y1={buMediocreLine} y2={buTargetLine} fill="#eab308" fillOpacity={0.12} />
                )}
                {buMediocreLine !== null && (
                  <ReferenceArea y1={0} y2={buMediocreLine} fill="#ef4444" fillOpacity={0.12} />
                )}
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={<RangeTick granularity={granularity} angled={shouldAngle} tz={factoryTz} />}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_COLOR }}
                  interval={0}
                  height={shouldAngle ? 56 : 36}
                  {...(explicitTicks ? { ticks: explicitTicks } : {})}
                />
                <YAxis
                  domain={[0, buMax]}
                  tick={TICK_STYLE}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)}
                />
                <Tooltip
                  // Custom content so we can render target + delta + hit/miss
                  // alongside the per-bucket value. The standard formatter
                  // only sees one (value, name) tuple at a time and can't
                  // express "actual vs target" in a single hover panel.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={(props: any) => (
                    <BuTooltipContent
                      {...props}
                      target={buTargetLine}
                      granularity={granularity}
                      fmtLabelFn={fmtLabel}
                      peerLabel={peerLabel}
                    />
                  )}
                />
                <Line
                  type="monotone"
                  dataKey="totalBU"
                  name="BU Output"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#22d3ee", strokeWidth: 0 }}
                />
                {hasPeers && (
                  <Line
                    type="monotone"
                    dataKey="peerBU"
                    name={peerLabel ?? "Peers"}
                    stroke={PEER_LINE_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={{ r: 3, fill: PEER_LINE_COLOR, strokeWidth: 0 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        <ChartCard
          title={`Avg Scrap Rate ${chartTitle}`}
          legend={
            <>
              {hasPeers && peerLabel && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5 rounded-sm" style={{ backgroundColor: PEER_LINE_COLOR }} />
                  {peerLabel}
                </span>
              )}
              <ZoneLegend color="#4ade80" label={`Good (≤${fmtPct(thresholds.scrap.good, 1)})`} />
              <ZoneLegend color="#eab308" label={`Mediocre (≤${fmtPct(thresholds.scrap.mediocre, 1)})`} />
              <ZoneLegend color="#ef4444" label={`Poor (>${fmtPct(thresholds.scrap.mediocre, 1)})`} />
            </>
          }
        >
          {!hasData ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={rowsWithPeer} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <ReferenceArea y1={0} y2={thresholds.scrap.good} fill="#4ade80" fillOpacity={0.15} />
                <ReferenceArea y1={thresholds.scrap.good} y2={thresholds.scrap.mediocre} fill="#eab308" fillOpacity={0.12} />
                <ReferenceArea y1={thresholds.scrap.mediocre} y2={scrapMax} fill="#ef4444" fillOpacity={0.12} />
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={<RangeTick granularity={granularity} angled={shouldAngle} tz={factoryTz} />}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_COLOR }}
                  interval={0}
                  height={shouldAngle ? 56 : 36}
                  {...(explicitTicks ? { ticks: explicitTicks } : {})}
                />
                <YAxis
                  domain={[0, scrapMax]}
                  tick={TICK_STYLE}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  // Custom content with target + delta + hit/miss. Scrap is
                  // inverted: lower is better, so hit = actual <= target.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={(props: any) => (
                    <PctTargetTooltipContent
                      {...props}
                      selfKey="avgScrap"
                      peerKey="peerScrap"
                      target={thresholds.scrap.good}
                      invert={true}
                      fmtLabelFn={fmtLabel}
                      peerLabel={peerLabel}
                    />
                  )}
                />
                <Line
                  type="monotone"
                  dataKey="avgScrap"
                  name="Scrap"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#22d3ee", strokeWidth: 0 }}
                />
                {hasPeers && (
                  <Line
                    type="monotone"
                    dataKey="peerScrap"
                    name={peerLabel ?? "Peers"}
                    stroke={PEER_LINE_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={{ r: 3, fill: PEER_LINE_COLOR, strokeWidth: 0 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        {showUptimeChart && (
        <ChartCard
          title={`Avg Uptime ${chartTitle}`}
          legend={
            <>
              {hasPeers && peerLabel && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5 rounded-sm" style={{ backgroundColor: PEER_LINE_COLOR }} />
                  {peerLabel}
                </span>
              )}
              <ZoneLegend color="#4ade80" label={`Good (≥${fmtPct(thresholds.efficiency.good, 1)})`} />
              <ZoneLegend color="#eab308" label={`Mediocre (≥${fmtPct(thresholds.efficiency.mediocre, 1)})`} />
              <ZoneLegend color="#ef4444" label={`Poor (<${fmtPct(thresholds.efficiency.mediocre, 1)})`} />
              {showErrorStrip && (
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-3 h-0.5 rounded-sm" style={{ backgroundColor: ERROR_BRACKET_COLOR }} />
                  Errors
                </span>
              )}
            </>
          }
        >
          {!hasData ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220 + errorStripHeight}>
              <LineChart data={rowsWithPeer} margin={{ top: 4, right: 8, left: -18, bottom: errorStripHeight }}>
                <ReferenceArea y1={thresholds.efficiency.good} y2={100} fill="#4ade80" fillOpacity={0.15} />
                <ReferenceArea y1={thresholds.efficiency.mediocre} y2={thresholds.efficiency.good} fill="#eab308" fillOpacity={0.12} />
                <ReferenceArea y1={0} y2={thresholds.efficiency.mediocre} fill="#ef4444" fillOpacity={0.12} />
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={<RangeTick granularity={granularity} angled={shouldAngle} tz={factoryTz} />}
                  tickLine={false}
                  axisLine={{ stroke: AXIS_COLOR }}
                  interval={0}
                  height={shouldAngle ? 56 : 36}
                  {...(explicitTicks ? { ticks: explicitTicks } : {})}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={TICK_STYLE}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  // Custom content with target + delta + hit/miss. Uptime
                  // is non-inverted: higher is better, hit = actual >= target.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={(props: any) => (
                    <PctTargetTooltipContent
                      {...props}
                      selfKey="avgUptime"
                      peerKey="peerUptime"
                      target={thresholds.efficiency.good}
                      invert={false}
                      fmtLabelFn={fmtLabel}
                      peerLabel={peerLabel}
                    />
                  )}
                />
                <Line
                  type="monotone"
                  dataKey="avgUptime"
                  name="Uptime"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "#22d3ee", strokeWidth: 0 }}
                />
                {hasPeers && (
                  <Line
                    type="monotone"
                    dataKey="peerUptime"
                    name={peerLabel ?? "Peers"}
                    stroke={PEER_LINE_COLOR}
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    dot={false}
                    activeDot={{ r: 3, fill: PEER_LINE_COLOR, strokeWidth: 0 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                )}
                {showErrorStrip && (
                  <ErrorBracketLayer
                    events={errorEvents}
                    errorLookup={errorLookup}
                    firstBucketTime={firstBucketTime}
                    lastBucketTime={lastBucketTime}
                    stripTopY={220 + ERROR_STRIP_PADDING}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
        )}
      </div>
    </>
  );
}
