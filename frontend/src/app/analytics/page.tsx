"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  LineChart, Line, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, ReferenceLine,
} from "recharts";
import {
  format, parseISO,
  subHours, subDays, subMonths,
  startOfMonth, startOfQuarter, startOfYear,
} from "date-fns";
import {
  fetchFleetTrend, fetchRegisteredMachines, fetchThresholds,
  applyEfficiencyColor, applyScrapColor,
  DEFAULT_THRESHOLDS,
} from "@/lib/supabase";
import type { DateRange, FleetTrendRow, Thresholds } from "@/lib/supabase";

// ─── Chart constants ─────────────────────────────────────────────────────────

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
const TOOLTIP_ITEM_STYLE  = { color: "#e5e7eb", padding: "1px 0" };

// ─── Period presets ───────────────────────────────────────────────────────────

type PresetId = "24h" | "7d" | "4w" | "6m" | "12m" | "mtd" | "qtd" | "ytd" | "all";

interface Preset {
  id:       PresetId;
  label:    string;
  getRange: () => DateRange;
}

const mkNow = () => new Date();

const PRESETS: Preset[] = [
  { id: "24h", label: "Last 24 hours",   getRange: () => ({ start: subHours(mkNow(), 24),    end: mkNow() }) },
  { id: "7d",  label: "Last 7 days",     getRange: () => ({ start: subDays(mkNow(), 7),       end: mkNow() }) },
  { id: "4w",  label: "Last 4 weeks",    getRange: () => ({ start: subDays(mkNow(), 28),      end: mkNow() }) },
  { id: "6m",  label: "Last 6 months",   getRange: () => ({ start: subMonths(mkNow(), 6),     end: mkNow() }) },
  { id: "12m", label: "Last 12 months",  getRange: () => ({ start: subMonths(mkNow(), 12),    end: mkNow() }) },
  { id: "mtd", label: "Month to date",   getRange: () => ({ start: startOfMonth(mkNow()),     end: mkNow() }) },
  { id: "qtd", label: "Quarter to date", getRange: () => ({ start: startOfQuarter(mkNow()),   end: mkNow() }) },
  { id: "ytd", label: "Year to date",    getRange: () => ({ start: startOfYear(mkNow()),      end: mkNow() }) },
  { id: "all", label: "All time",        getRange: () => ({ start: new Date(2020, 0, 1),       end: mkNow() }) },
];

const DEFAULT_PRESET_ID: PresetId = "24h";

// ─── Bucket formatting ────────────────────────────────────────────────────────

function fmtBucket(key: string, granularity: "hour" | "day"): string {
  try {
    return granularity === "hour"
      ? format(parseISO(key + ":00:00"), "HH:mm")
      : format(parseISO(key), "dd.MM");
  } catch { return key; }
}

function fmtBucketFull(key: string, granularity: "hour" | "day"): string {
  try {
    return granularity === "hour"
      ? format(parseISO(key + ":00:00"), "dd.MM.yyyy HH:mm")
      : format(parseISO(key), "dd.MM.yyyy");
  } catch { return key; }
}

function fmtBucketRange(key: string, granularity: "hour" | "day"): [string, string] {
  try {
    if (granularity === "hour") {
      const d = parseISO(key + ":00:00");
      const next = new Date(d.getTime() + 3_600_000);
      return [format(d, "HH:mm"), format(next, "HH:mm")];
    }
    const d = parseISO(key);
    const next = new Date(d.getTime() + 86_400_000);
    return [format(d, "dd.MM"), format(next, "dd.MM")];
  } catch { return [key, ""]; }
}

// Custom X-axis tick for line charts.
// When angled=true the label is rotated -40° so densely-packed ticks don't overlap.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function LineTick({ x, y, payload, granularity, angled }: any) {
  const label = fmtBucket(payload?.value ?? "", granularity);
  if (angled) {
    return (
      <g transform={`translate(${x},${y})`}>
        <text transform="rotate(-40)" textAnchor="end" fill="#9ca3af" fontSize={11} dy={4} dx={-4}>
          {label}
        </text>
      </g>
    );
  }
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#9ca3af" fontSize={11}>
        {label}
      </text>
    </g>
  );
}

// Custom X-axis tick for the BU chart.
// Hourly: two lines showing start→end time (e.g. "12:00 / 13:00"), or a single angled label when cramped.
// Daily:  single date label (e.g. "15.12.") — one bar = one day, no end date needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RangeTick({ x, y, payload, granularity, angled }: any) {
  const [line1, line2] = fmtBucketRange(payload?.value ?? "", granularity);
  if (angled) {
    // Collapse to a single label and rotate -40° so labels don't overlap
    const label = granularity === "day" ? line1 : `${line1}–${line2}`;
    return (
      <g transform={`translate(${x},${y})`}>
        <text transform="rotate(-40)" textAnchor="end" fill="#9ca3af" fontSize={10} dy={4} dx={-4}>
          {label}
        </text>
      </g>
    );
  }
  if (granularity === "day") {
    return (
      <g transform={`translate(${x},${y})`}>
        <text x={0} y={0} dy={12} textAnchor="middle" fill="#9ca3af" fontSize={10}>
          {line1}
        </text>
      </g>
    );
  }
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#9ca3af" fontSize={10}>
        {line1}
      </text>
      <text x={0} y={0} dy={23} textAnchor="middle" fill="#9ca3af" fontSize={10}>
        {line2}
      </text>
    </g>
  );
}

function toDateInputValue(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

// ─── KPI tile ────────────────────────────────────────────────────────────────

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

// ─── Chart card ──────────────────────────────────────────────────────────────

function ChartCard({ title, legend, children }: {
  title: string;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
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

// ─── Empty state ─────────────────────────────────────────────────────────────

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

// ─── Zone legend ─────────────────────────────────────────────────────────────

function ZoneLegend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: color, opacity: 0.25 }} />
      {label}
    </span>
  );
}

// ─── Period selector ──────────────────────────────────────────────────────────

function PeriodSelector({
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
  const [open, setOpen]             = useState(false);
  const [customStart, setCustomStart] = useState(() => toDateInputValue(dateRange.start));
  const [customEnd,   setCustomEnd]   = useState(() => toDateInputValue(dateRange.end));
  const ref = useRef<HTMLDivElement>(null);

  // Keep inputs in sync when external range changes (e.g. preset click)
  useEffect(() => {
    setCustomStart(toDateInputValue(dateRange.start));
    setCustomEnd(toDateInputValue(dateRange.end));
  }, [dateRange]);

  // Close on outside click
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
      {/* Trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 hover:text-white hover:border-gray-600 transition-colors"
      >
        <i className="bi bi-calendar3 text-xs text-gray-500"></i>
        {buttonLabel}
        <i className={`bi bi-chevron-${open ? "up" : "down"} text-xs text-gray-500`}></i>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 flex bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">

          {/* Preset list */}
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

          {/* Custom range */}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Analytics() {
  const [activePresetId, setActivePresetId] = useState<PresetId | "custom">(DEFAULT_PRESET_ID);
  const [dateRange, setDateRange]           = useState<DateRange>(() =>
    PRESETS.find(p => p.id === DEFAULT_PRESET_ID)!.getRange()
  );
  const [rows, setRows]                   = useState<FleetTrendRow[]>([]);
  const [granularity, setGranularity]     = useState<"hour" | "day">("day");
  const [totalReadings, setTotalReadings] = useState<number>(0);
  const [thresholds, setThresholds]       = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [buTargetPerShift, setBuTargetPerShift]       = useState<number | null>(null); // sum of all machines' BU targets (per shift)
  const [buMediocrePerShift, setBuMediocrePerShift]   = useState<number | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // For presets, always recompute the range so `end` = now() at call time.
    // Storing the range at mount would freeze the window and miss readings
    // that arrive after the page first loaded.
    const effectiveRange: DateRange =
      activePresetId !== "custom"
        ? PRESETS.find(p => p.id === activePresetId)!.getRange()
        : dateRange;
    try {
      const [result, machines, savedThresholds] = await Promise.all([
        fetchFleetTrend(effectiveRange),
        fetchRegisteredMachines(),
        fetchThresholds(),
      ]);
      setRows(result.rows);
      setGranularity(result.granularity);
      setTotalReadings(result.totalReadings);

      // Derive zone thresholds from per-machine targets (same values as the
      // live dashboard), falling back to defaults if none are configured.
      // Filter out null and 0 — a threshold of 0 is never meaningful.
      const avg = (arr: (number | null)[]) => {
        const vals = arr.filter((v): v is number => v !== null && v > 0 && !isNaN(v));
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };
      const computedThresholds: Thresholds = {
        efficiency: {
          good:     avg(machines.map(m => m.efficiency_good))     ?? DEFAULT_THRESHOLDS.efficiency.good,
          mediocre: avg(machines.map(m => m.efficiency_mediocre)) ?? DEFAULT_THRESHOLDS.efficiency.mediocre,
        },
        scrap: {
          good:     avg(machines.map(m => m.scrap_good))     ?? DEFAULT_THRESHOLDS.scrap.good,
          mediocre: avg(machines.map(m => m.scrap_mediocre)) ?? DEFAULT_THRESHOLDS.scrap.mediocre,
        },
        bu: savedThresholds.bu, // shift length + planned downtime from app_settings
      };
      setThresholds(computedThresholds);

      // BU targets are per-machine per-shift. Store the raw per-shift park
      // total; the chart scales these to the bucket granularity at render time.
      const sum = (arr: (number | null)[]) => {
        const vals = arr.filter((v): v is number => v !== null && v > 0 && !isNaN(v));
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) : null;
      };
      setBuTargetPerShift(sum(machines.map(m => m.bu_target)));
      setBuMediocrePerShift(sum(machines.map(m => m.bu_mediocre)));

      setLastRefreshed(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  }, [activePresetId, dateRange]);

  // Initial load + reload whenever period changes
  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 5 minutes so live production data stays current
  useEffect(() => {
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  function handlePresetSelect(preset: Preset) {
    setActivePresetId(preset.id);
    setDateRange(preset.getRange()); // also update custom inputs in the selector
  }

  function handleCustomRange(range: DateRange) {
    setActivePresetId("custom");
    setDateRange(range);
  }

  // ── Summary KPIs ──
  const hasData    = rows.length > 0;
  const avgUptime  = hasData ? rows.reduce((s, d) => s + d.avgUptime, 0) / rows.length : null;
  const avgScrap   = hasData ? rows.reduce((s, d) => s + d.avgScrap,  0) / rows.length : null;
  const totalSwabs = rows.reduce((s, d) => s + d.totalSwabs, 0);
  const totalBUs   = Math.round(totalSwabs / 7200);

  // Total park BU output per bucket.
  // For daily granularity, each bar's threshold is scaled by the actual number
  // of shifts that contributed data to that bucket (shiftCount from the SQL).
  // This prevents days with only 1 shift from being penalised against a
  // 2-shift target — a shift that hits target should always look "good".
  const shiftHours = thresholds.bu.shiftLengthMinutes / 60 || 8;

  const buRows = rows.map(r => {
    const totalBU = Math.round((r.totalSwabs / 7200) * 10) / 10;
    // Per-bucket threshold: compare the per-shift average output against
    // the per-shift target. For hourly buckets, use the production rate.
    // For daily buckets, divide total by the number of shifts that contributed
    // data so a partial day isn't penalised against a multi-shift target.
    const shifts = Math.max(1, r.shiftCount);
    const perShiftBU = granularity === "hour" ? totalBU : totalBU / shifts;
    const barTarget = buTargetPerShift !== null
      ? (granularity === "hour" ? buTargetPerShift / shiftHours : buTargetPerShift)
      : null;
    const barMediocre = buMediocrePerShift !== null
      ? (granularity === "hour" ? buMediocrePerShift / shiftHours : buMediocrePerShift)
      : null;
    const barColor =
      barTarget === null || barMediocre === null ? "#22d3ee"      // no targets → default cyan
      : perShiftBU >= barTarget                 ? "#4ade80"      // good → green
      : perShiftBU >= barMediocre               ? "#eab308"      // mediocre → yellow
      :                                           "#ef4444";     // poor → red
    return { ...r, totalBU, barTarget, barMediocre, barColor };
  });

  // For the legend and reference line, show the per-shift target as baseline
  const buTargetLine = buTargetPerShift !== null
    ? (granularity === "hour" ? buTargetPerShift / shiftHours : buTargetPerShift)
    : null;
  const buMediocreLine = buMediocrePerShift !== null
    ? (granularity === "hour" ? buMediocrePerShift / shiftHours : buMediocrePerShift)
    : null;

  // KPI color for Total BU Output — compare actual total against what the park
  // should have produced across all buckets that had data.
  // Each bucket contributes target × shiftCount for that bucket.
  const totalShiftsInPeriod = buRows.reduce((s, r) => s + Math.max(1, r.shiftCount), 0);
  const buKpiGood     = buTargetPerShift !== null ? buTargetPerShift * totalShiftsInPeriod : null;
  const buKpiMediocre = buMediocrePerShift !== null ? buMediocrePerShift * totalShiftsInPeriod : null;
  const buKpiColor    = (() => {
    if (totalBUs <= 0 || buKpiGood === null || buKpiMediocre === null)
      return { text: "text-gray-500", border: "border-gray-700" };
    if (totalBUs >= buKpiGood)     return { text: "text-green-400",  border: "border-green-700" };
    if (totalBUs >= buKpiMediocre) return { text: "text-yellow-400", border: "border-yellow-700" };
    return                                { text: "text-red-400",    border: "border-red-700" };
  })();
  // Swabs threshold is just BU threshold × 7200
  const swabsKpiColor = (() => {
    if (totalSwabs <= 0 || buKpiGood === null || buKpiMediocre === null)
      return { text: "text-gray-500", border: "border-gray-700" };
    if (totalSwabs >= buKpiGood * 7200)     return { text: "text-green-400",  border: "border-green-700" };
    if (totalSwabs >= buKpiMediocre * 7200) return { text: "text-yellow-400", border: "border-yellow-700" };
    return                                         { text: "text-red-400",    border: "border-red-700" };
  })();

  const ec = applyEfficiencyColor(avgUptime, thresholds);
  const sc = applyScrapColor(avgScrap, thresholds);

  const fmtTick  = (key: string) => fmtBucket(key, granularity);
  const fmtLabel = (key: string) => fmtBucketFull(key, granularity);

  // Show every tick for ≤ 24 buckets; thin out for longer periods
  const tickInterval = rows.length <= 24 ? 0 : Math.ceil(rows.length / 20) - 1;

  // Angle labels when the number of visible ticks would cause overlap (> 12)
  const visibleTicks = tickInterval === 0 ? rows.length : Math.ceil(rows.length / (tickInterval + 1));
  const shouldAngle  = visibleTicks > 12;
  const xAxisHeight  = shouldAngle ? 48 : undefined;

  // Pre-compute Y-axis ceilings so both domain and ReferenceArea share the same max
  const scrapDataMax = hasData ? Math.max(...rows.map(r => r.avgScrap)) : 0;
  const scrapMax     = Math.ceil(Math.max(scrapDataMax, thresholds.scrap.mediocre) + 1);

  const buDataMax = hasData ? Math.max(...buRows.map(r => r.totalBU)) : 0;
  const buMax     = Math.ceil(Math.max(buDataMax, buTargetLine ?? 0, buMediocreLine ?? 0) * 1.15);

  const chartTitle = granularity === "hour"
    ? "— hourly park total"
    : "— daily park total";

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex justify-between items-start mb-6 gap-6">
        <div className="flex flex-col gap-3">
          <h2 className="text-xl font-bold text-white">Analytics</h2>
          <PeriodSelector
            activePresetId={activePresetId}
            dateRange={dateRange}
            onPresetSelect={handlePresetSelect}
            onCustomRange={handleCustomRange}
          />
        </div>
        {lastRefreshed && !loading && (
          <div className="flex items-center gap-1.5">
            <p className="text-xs text-gray-600">
              Updated {format(lastRefreshed, "HH:mm:ss")}
            </p>
            <button
              onClick={load}
              disabled={loading}
              title="Refresh now"
              className="text-gray-600 hover:text-gray-300 disabled:opacity-40 transition-colors"
            >
              <i className={`bi bi-arrow-clockwise text-xs ${loading ? "animate-spin" : ""}`}></i>
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="mb-4 bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-4 py-3">
          <i className="bi bi-exclamation-circle mr-2"></i>{error}
        </div>
      )}

      {/* ── Loading ── */}
      {loading ? (
        <div className="flex items-center justify-center h-64 gap-2 text-gray-500 text-sm">
          <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
          Loading analytics…
        </div>
      ) : (
        <>
          {/* ── KPI tiles ── */}
          <div className="grid grid-cols-4 gap-3 mb-5">
            <KpiTile
              icon="bi-speedometer2"
              label="Avg Uptime"
              value={avgUptime !== null ? `${avgUptime.toFixed(1)}%` : "—"}
              sub="Park average · selected period"
              colorClass={ec.text}
              borderClass={ec.border}
            />
            <KpiTile
              icon="bi-exclamation-triangle"
              label="Avg Scrap Rate"
              value={avgScrap !== null ? `${avgScrap.toFixed(1)}%` : "—"}
              sub="Park average · selected period"
              colorClass={sc.text}
              borderClass={sc.border}
            />
            <KpiTile
              icon="bi-bullseye"
              label="Total BU Output"
              value={totalBUs > 0 ? totalBUs.toLocaleString() : "—"}
              sub={buKpiGood !== null ? `Target: ${Math.round(buKpiGood).toLocaleString()} BUs` : "Business units · selected period"}
              colorClass={buKpiColor.text}
              borderClass={buKpiColor.border}
            />
            <KpiTile
              icon="bi-diamond"
              label="Total Swabs"
              value={totalSwabs > 0 ? `${(totalSwabs / 1_000_000).toFixed(2)}M` : "—"}
              sub={buKpiGood !== null ? `Target: ${(buKpiGood * 7200 / 1_000_000).toFixed(2)}M` : "Swabs produced · selected period"}
              colorClass={swabsKpiColor.text}
              borderClass={swabsKpiColor.border}
            />
          </div>


          {/* ── Trend charts (2 columns) ── */}
          <div className="grid grid-cols-2 gap-4 mb-4">

            {/* Uptime trend */}
            <ChartCard
              title={`Avg Uptime ${chartTitle}`}
              legend={
                <>
                  <ZoneLegend color="#4ade80" label={`Good (≥${thresholds.efficiency.good}%)`} />
                  <ZoneLegend color="#eab308" label={`Mediocre (≥${thresholds.efficiency.mediocre}%)`} />
                  <ZoneLegend color="#ef4444" label={`Poor (<${thresholds.efficiency.mediocre}%)`} />
                </>
              }
            >
              {!hasData ? <NoData /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    {/* Background zones — higher is better for uptime */}
                    <ReferenceArea y1={thresholds.efficiency.good} y2={100} fill="#4ade80" fillOpacity={0.08} />
                    <ReferenceArea y1={thresholds.efficiency.mediocre} y2={thresholds.efficiency.good} fill="#eab308" fillOpacity={0.07} />
                    <ReferenceArea y1={0} y2={thresholds.efficiency.mediocre} fill="#ef4444" fillOpacity={0.07} />
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={shouldAngle
                        ? (props: any) => <LineTick {...props} granularity={granularity} angled />
                        : TICK_STYLE}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_COLOR }}
                      tickFormatter={shouldAngle ? undefined : fmtTick}
                      interval={tickInterval}
                      height={xAxisHeight}
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
                      formatter={(v) => [`${Number(v ?? 0).toFixed(1)}%`, "Uptime"]}
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
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Scrap trend */}
            <ChartCard
              title={`Avg Scrap Rate ${chartTitle}`}
              legend={
                <>
                  <ZoneLegend color="#4ade80" label={`Good (≤${thresholds.scrap.good}%)`} />
                  <ZoneLegend color="#eab308" label={`Mediocre (≤${thresholds.scrap.mediocre}%)`} />
                  <ZoneLegend color="#ef4444" label={`Poor (>${thresholds.scrap.mediocre}%)`} />
                </>
              }
            >
              {!hasData ? <NoData /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    {/* Background zones — lower is better for scrap */}
                    <ReferenceArea y1={0} y2={thresholds.scrap.good} fill="#4ade80" fillOpacity={0.08} />
                    <ReferenceArea y1={thresholds.scrap.good} y2={thresholds.scrap.mediocre} fill="#eab308" fillOpacity={0.07} />
                    <ReferenceArea y1={thresholds.scrap.mediocre} y2={scrapMax} fill="#ef4444" fillOpacity={0.07} />
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={shouldAngle
                        ? (props: any) => <LineTick {...props} granularity={granularity} angled />
                        : TICK_STYLE}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_COLOR }}
                      tickFormatter={shouldAngle ? undefined : fmtTick}
                      interval={tickInterval}
                      height={xAxisHeight}
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
                      formatter={(v) => [`${Number(v ?? 0).toFixed(1)}%`, "Scrap"]}
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
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>

          {/* ── Total park BU output bar chart ── */}
          <ChartCard
            title={`Total BU Output ${chartTitle}`}
            legend={buTargetLine !== null ? (
              <>
                <ZoneLegend color="#4ade80" label={`Good (≥${Math.round(buTargetLine).toLocaleString()} BUs/shift)`} />
                <ZoneLegend color="#eab308" label={`Mediocre (≥${Math.round(buMediocreLine ?? 0).toLocaleString()})`} />
                <ZoneLegend color="#ef4444" label={`Poor (<${Math.round(buMediocreLine ?? 0).toLocaleString()})`} />
              </>
            ) : undefined}
          >
            {!hasData ? <NoData /> : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={buRows} margin={{ top: 4, right: 8, left: -18, bottom: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                  {/* Reference line at per-shift target (baseline) */}
                  {buTargetLine !== null && (
                    <ReferenceLine
                      y={buTargetLine}
                      stroke="#4ade80"
                      strokeDasharray="6 3"
                      strokeOpacity={0.5}
                    />
                  )}
                  {buMediocreLine !== null && (
                    <ReferenceLine
                      y={buMediocreLine}
                      stroke="#eab308"
                      strokeDasharray="6 3"
                      strokeOpacity={0.35}
                    />
                  )}
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={{ stroke: AXIS_COLOR }}
                    tick={<RangeTick granularity={granularity} angled={shouldAngle} />}
                    interval={tickInterval}
                    height={shouldAngle ? 52 : 36}
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
                    labelFormatter={(l) => {
                      const [from, to] = fmtBucketRange(l as string, granularity);
                      return `${from} – ${to}`;
                    }}
                    formatter={(v) => [`${Number(v ?? 0).toLocaleString()} BUs`, "BU Output"]}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar
                    dataKey="totalBU"
                    name="BU Output"
                    radius={[2, 2, 0, 0]}
                    barSize={Math.min(64, Math.max(8, Math.round(480 / Math.max(1, buRows.length))))}
                  >
                    {buRows.map((entry, index) => (
                      <Cell key={`bu-${index}`} fill={entry.barColor} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}
