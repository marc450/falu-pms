"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  format, parseISO,
  subHours, subDays, subMonths,
  startOfMonth, startOfQuarter, startOfYear,
} from "date-fns";
import {
  fetchFleetTrend, fetchThresholds,
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
};
const TOOLTIP_LABEL_STYLE = { color: "#9ca3af", marginBottom: 4 };
const TOOLTIP_ITEM_STYLE  = { padding: "1px 0" };

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
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
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

// ─── Legend dashed line ───────────────────────────────────────────────────────

function DashLegendLine({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="18" height="8">
        <line x1="0" y1="4" x2="18" y2="4" stroke={color} strokeWidth="1.5" strokeDasharray="4 2" />
      </svg>
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
        <div className="absolute right-0 top-full mt-1 z-50 flex bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden">

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
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-cyan-600"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-500">To</span>
              <input
                type="date"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
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
      const [result, th] = await Promise.all([fetchFleetTrend(effectiveRange), fetchThresholds()]);
      setRows(result.rows);
      setGranularity(result.granularity);
      setTotalReadings(result.totalReadings);
      setThresholds(th);
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
  const totalBoxes = rows.reduce((s, d) => s + d.totalBoxes, 0);
  const totalSwabs = rows.reduce((s, d) => s + d.totalSwabs, 0);

  const ec = applyEfficiencyColor(avgUptime, thresholds);
  const sc = applyScrapColor(avgScrap, thresholds);

  const fmtTick  = (key: string) => fmtBucket(key, granularity);
  const fmtLabel = (key: string) => fmtBucketFull(key, granularity);

  const scrapCeil = (dataMax: number) =>
    Math.ceil(Math.max(dataMax, thresholds.scrap.mediocre) + 1);

  const chartTitle = granularity === "hour"
    ? "— hourly park average"
    : "— daily park average";

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Analytics</h2>
          {lastRefreshed && !loading && (
            <p className="text-xs text-gray-600 mt-0.5">
              Updated {format(lastRefreshed, "HH:mm:ss")}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            title="Refresh now"
            className="p-1.5 text-gray-500 hover:text-gray-300 disabled:opacity-40 transition-colors"
          >
            <i className={`bi bi-arrow-clockwise text-sm ${loading ? "animate-spin" : ""}`}></i>
          </button>
          <PeriodSelector
            activePresetId={activePresetId}
            dateRange={dateRange}
            onPresetSelect={handlePresetSelect}
            onCustomRange={handleCustomRange}
          />
        </div>
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
              icon="bi-box-seam"
              label="Total Output"
              value={totalBoxes > 0 ? totalBoxes.toLocaleString() : "—"}
              sub="Boxes produced · selected period"
              colorClass="text-white"
              borderClass="border-gray-600"
            />
            <KpiTile
              icon="bi-diamond"
              label="Total Swabs"
              value={totalSwabs > 0 ? `${(totalSwabs / 1_000_000).toFixed(2)}M` : "—"}
              sub="Swabs produced · selected period"
              colorClass="text-white"
              borderClass="border-gray-600"
            />
          </div>

          {/* ── Data coverage note ── */}
          <div className="flex items-center gap-1.5 text-xs text-gray-600 mb-5 -mt-2">
            <i className="bi bi-database"></i>
            {totalReadings === 0
              ? "No shift readings found for this period"
              : `${totalReadings.toLocaleString()} shift reading${totalReadings !== 1 ? "s" : ""} · ${rows.length} ${granularity === "hour" ? "hourly" : "daily"} bucket${rows.length !== 1 ? "s" : ""}`
            }
          </div>

          {/* ── Trend charts (2 columns) ── */}
          <div className="grid grid-cols-2 gap-4 mb-4">

            {/* Uptime trend */}
            <ChartCard
              title={`Avg Uptime ${chartTitle}`}
              legend={
                <>
                  <DashLegendLine color="#4ade80" label={`Good (${thresholds.efficiency.good}%)`} />
                  <DashLegendLine color="#f59e0b" label={`Mediocre (${thresholds.efficiency.mediocre}%)`} />
                </>
              }
            >
              {!hasData ? <NoData /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={TICK_STYLE}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_COLOR }}
                      tickFormatter={fmtTick}
                      interval="preserveStartEnd"
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
                    <ReferenceLine
                      y={thresholds.efficiency.good}
                      stroke="#4ade80" strokeDasharray="5 3" strokeOpacity={0.72}
                    />
                    <ReferenceLine
                      y={thresholds.efficiency.mediocre}
                      stroke="#f59e0b" strokeDasharray="5 3" strokeOpacity={0.72}
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
                  <DashLegendLine color="#4ade80" label={`Good (≤${thresholds.scrap.good}%)`} />
                  <DashLegendLine color="#f59e0b" label={`Mediocre (≤${thresholds.scrap.mediocre}%)`} />
                </>
              }
            >
              {!hasData ? <NoData /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={TICK_STYLE}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_COLOR }}
                      tickFormatter={fmtTick}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      domain={[0, scrapCeil]}
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
                    <ReferenceLine
                      y={thresholds.scrap.good}
                      stroke="#4ade80" strokeDasharray="5 3" strokeOpacity={0.72}
                    />
                    <ReferenceLine
                      y={thresholds.scrap.mediocre}
                      stroke="#f59e0b" strokeDasharray="5 3" strokeOpacity={0.72}
                    />
                    <Line
                      type="monotone"
                      dataKey="avgScrap"
                      name="Scrap"
                      stroke="#f87171"
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: "#f87171", strokeWidth: 0 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>

          {/* ── Box output bar chart ── */}
          <ChartCard title="Box Output — total across all machines">
            {!hasData ? <NoData /> : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_COLOR }}
                    tickFormatter={fmtTick}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    itemStyle={TOOLTIP_ITEM_STYLE}
                    labelFormatter={(l) => fmtLabel(l as string)}
                    formatter={(v) => [Number(v ?? 0).toLocaleString(), "Boxes"]}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar
                    dataKey="totalBoxes"
                    name="Boxes"
                    fill="#0e7490"
                    radius={[2, 2, 0, 0]}
                    maxBarSize={36}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </>
      )}
    </div>
  );
}
