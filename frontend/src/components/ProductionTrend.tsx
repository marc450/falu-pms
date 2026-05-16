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
  subHours, subDays, subMonths,
  startOfDay, startOfMonth, startOfQuarter, startOfYear,
} from "date-fns";
import { fmtPct } from "@/lib/fmt";
import { applyEfficiencyColor, applyScrapColor } from "@/lib/supabase";
import type { DateRange, FleetTrendRow, Thresholds, ErrorEvent, PlcErrorCode } from "@/lib/supabase";

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

export type PresetId = "24h" | "7d" | "4w" | "6m" | "12m" | "mtd" | "qtd" | "ytd" | "all";

export interface Preset {
  id: PresetId;
  label: string;
  getRange: () => DateRange;
}

const mkNow = () => new Date();

export const PRESETS: Preset[] = [
  { id: "24h", label: "Last 24 hours",   getRange: () => ({ start: subHours(mkNow(), 24),              end: mkNow() }) },
  { id: "7d",  label: "Last 7 days",     getRange: () => ({ start: startOfDay(subDays(mkNow(), 7)),    end: mkNow() }) },
  { id: "4w",  label: "Last 4 weeks",    getRange: () => ({ start: startOfDay(subDays(mkNow(), 28)),   end: mkNow() }) },
  { id: "6m",  label: "Last 6 months",   getRange: () => ({ start: startOfDay(subMonths(mkNow(), 6)),  end: mkNow() }) },
  { id: "12m", label: "Last 12 months",  getRange: () => ({ start: startOfDay(subMonths(mkNow(), 12)), end: mkNow() }) },
  { id: "mtd", label: "Month to date",   getRange: () => ({ start: startOfMonth(mkNow()),              end: mkNow() }) },
  { id: "qtd", label: "Quarter to date", getRange: () => ({ start: startOfQuarter(mkNow()),            end: mkNow() }) },
  { id: "ytd", label: "Year to date",    getRange: () => ({ start: startOfYear(mkNow()),               end: mkNow() }) },
  { id: "all", label: "All time",        getRange: () => ({ start: new Date(2020, 0, 1),               end: mkNow() }) },
];

export const DEFAULT_PRESET_ID: PresetId = "7d";

// ─── Formatters ──────────────────────────────────────────────────────────────

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtMillions(n: number): string {
  const m = n / 1_000_000;
  return `${m.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
}

function fmtDateShort(d: Date): string {
  const day = String(d.getDate()).padStart(2, "0");
  const mon = MONTH_ABBR[d.getMonth()];
  const yr  = String(d.getFullYear()).slice(2);
  return `${day}. ${mon} '${yr}`;
}

// Bucket keys come in three lengths: "YYYY-MM-DD" (day, 10), "YYYY-MM-DDTHH"
// (hour, 13 — legacy), "YYYY-MM-DDTHH:MM" (sub-hour, 16). Append whatever
// suffix is needed to round it out to a parseable UTC instant.
export function parseBucketKey(key: string): Date {
  if (key.length >= 16) return parseISO(key + ":00Z");        // sub-hour
  if (key.length >= 13) return parseISO(key + ":00:00Z");     // hour
  return parseISO(key);                                       // day
}

function fmtBucketFull(key: string, granularity: "hour" | "day"): string {
  try {
    if (granularity === "hour") {
      const d = parseBucketKey(key);
      return `${fmtDateShort(d)} ${format(d, "HH:mm")}`;
    }
    return fmtDateShort(parseISO(key));
  } catch { return key; }
}

// Instant label for the x-axis. For sub-hour buckets we only label the
// integer-hour positions ("10:00", "11:00", "12:00", …) and leave the
// in-between buckets unlabelled, giving a continuous timeline feel.
function fmtBucketLabel(key: string, granularity: "hour" | "day"): string {
  try {
    if (granularity === "hour") {
      const d = parseBucketKey(key);
      if (d.getUTCMinutes() !== 0) return "";
      return format(d, "HH:mm");
    }
    return fmtDateShort(parseISO(key));
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

function toDateInputValue(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RangeTick({ x, y, payload, granularity, angled }: any) {
  const label = fmtBucketLabel(payload?.value ?? "", granularity);
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
}: {
  activePresetId: PresetId | "custom";
  dateRange:      DateRange;
  onPresetSelect: (preset: Preset) => void;
  onCustomRange:  (range: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customStart, setCustomStart] = useState(() => toDateInputValue(dateRange.start));
  const [customEnd, setCustomEnd] = useState(() => toDateInputValue(dateRange.end));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCustomStart(toDateInputValue(dateRange.start));
    setCustomEnd(toDateInputValue(dateRange.end));
  }, [dateRange]);

  useEffect(() => {
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const buttonLabel =
    activePresetId === "custom"
      ? `${format(dateRange.start, "dd.MM.yyyy")} – ${format(dateRange.end, "dd.MM.yyyy")}`
      : PRESETS.find(p => p.id === activePresetId)?.label ?? "Select period";

  function applyCustom() {
    try {
      const start = parseISO(customStart);
      const end   = parseISO(customEnd);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start <= end) {
        end.setHours(23, 59, 59, 999);
        onCustomRange({ start, end });
        setOpen(false);
      }
    } catch { /* ignore parse errors */ }
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
          <div className="p-4 flex flex-col gap-3 min-w-[190px]">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Custom range</p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">From</span>
              <input
                type="date"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-cyan-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">To</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                style={{ colorScheme: "dark" }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-cyan-600"
              />
            </label>
            <button
              onClick={applyCustom}
              className="mt-1 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-sm rounded-lg transition-colors font-medium"
            >
              Apply
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
  errorEvents = [],
  errorLookup = {},
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
  kpiSubLabel?: string;
  chartTitleSuffix?: string;
  peerRows?: FleetTrendRow[];
  peerLabel?: string;
  errorEvents?: ErrorEvent[];
  errorLookup?: Record<string, PlcErrorCode>;
}) {
  const hasData    = rows.length > 0;
  const avgUptime  = hasData ? rows.reduce((s, d) => s + d.avgUptime, 0) / rows.length : null;
  const avgScrap   = hasData ? rows.reduce((s, d) => s + d.avgScrap,  0) / rows.length : null;
  const totalSwabs = rows.reduce((s, d) => s + d.totalSwabs, 0);
  const totalBUs   = Math.round(totalSwabs / 7200);

  const shiftHours   = thresholds.bu.shiftLengthMinutes / 60 || 8;
  const shiftsPerDay = Math.max(1, Math.round(24 / shiftHours));

  // Detect the sub-daily bucket size from the first two rows so the BU chart
  // can rate-normalise its y-axis to "BUs/hour" regardless of bucket length
  // (15-min buckets are 1/4 of the legacy 60-min buckets).
  const bucketMinutes = granularity === "hour" && rows.length >= 2
    ? Math.max(1, Math.round(
        (parseBucketKey(rows[1].date).getTime() - parseBucketKey(rows[0].date).getTime()) / 60_000
      ))
    : 60;
  const buRateMultiplier = granularity === "hour" ? 60 / bucketMinutes : 1;

  // Peer benchmark series. Aligned to the same date keys as `rows`; missing
  // buckets render as line breaks (recharts skips null y-values with monotone).
  const hasPeers = peerRows.length > 0;
  const peerByDate = new Map(peerRows.map(r => [r.date, r]));
  const peerAvgUptime = hasPeers ? peerRows.reduce((s, d) => s + d.avgUptime, 0) / peerRows.length : null;
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

  const periodHours = Math.max(1, (dateRange.end.getTime() - dateRange.start.getTime()) / 3_600_000);
  const expectedShiftsInPeriod = granularity === "day"
    ? buRows.reduce((s, r) => s + Math.max(1, r.shiftCount), 0)
    : Math.max(1, periodHours / shiftHours);
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
        const aligned = rows.filter(r => {
          const d = parseBucketKey(r.date);
          return d.getUTCMinutes() === 0;
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
  const fmtLabel = (key: string) => fmtBucketFull(key, granularity);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
        <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
        Loading analytics…
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

      {/* Trend charts — one per row so each gets full width */}
      <div className="flex flex-col gap-4 mb-4">
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
            </>
          }
        >
          {!hasData ? <NoData /> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={rowsWithPeer} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                <ReferenceArea y1={thresholds.efficiency.good} y2={100} fill="#4ade80" fillOpacity={0.15} />
                <ReferenceArea y1={thresholds.efficiency.mediocre} y2={thresholds.efficiency.good} fill="#eab308" fillOpacity={0.12} />
                <ReferenceArea y1={0} y2={thresholds.efficiency.mediocre} fill="#ef4444" fillOpacity={0.12} />
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={<RangeTick granularity={granularity} angled={shouldAngle} />}
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
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  itemStyle={TOOLTIP_ITEM_STYLE}
                  labelFormatter={(l) => fmtLabel(l as string)}
                  formatter={(v, name) => [fmtPct(Number(v ?? 0), 1), String(name)]}
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
                  tick={<RangeTick granularity={granularity} angled={shouldAngle} />}
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
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  itemStyle={TOOLTIP_ITEM_STYLE}
                  labelFormatter={(l) => fmtLabel(l as string)}
                  formatter={(v, name) => [fmtPct(Number(v ?? 0), 1), String(name)]}
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
      </div>

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
            <LineChart data={buRows} margin={{ top: 4, right: 8, left: -18, bottom: errorStripHeight }}>
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
                tick={<RangeTick granularity={granularity} angled={shouldAngle} />}
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
                contentStyle={TOOLTIP_CONTENT_STYLE}
                labelStyle={TOOLTIP_LABEL_STYLE}
                itemStyle={TOOLTIP_ITEM_STYLE}
                labelFormatter={(l) => fmtLabel(l as string)}
                formatter={(v, name) => [`${Number(v ?? 0).toLocaleString()} BUs`, String(name)]}
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
    </>
  );
}
