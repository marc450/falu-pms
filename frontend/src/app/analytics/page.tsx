"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import { format, parseISO } from "date-fns";
import {
  fetchFleetTrend, fetchThresholds,
  applyEfficiencyColor, applyScrapColor,
  DEFAULT_THRESHOLDS,
} from "@/lib/supabase";
import type { FleetTrendRow, Thresholds } from "@/lib/supabase";

// ─── Constants ─────────────────────────────────────────────────────────────

const PERIOD_OPTIONS = [
  { label: "7 days",  days: 7  },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
] as const;
type Period = (typeof PERIOD_OPTIONS)[number]["days"];

const GRID_COLOR   = "#374151";
const AXIS_COLOR   = "#4b5563";
const TICK_STYLE   = { fill: "#9ca3af", fontSize: 11 };
const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "#1f2937",
  border: "1px solid #374151",
  borderRadius: "6px",
  fontSize: 12,
};
const TOOLTIP_LABEL_STYLE = { color: "#9ca3af", marginBottom: 4 };
const TOOLTIP_ITEM_STYLE  = { padding: "1px 0" };

// ─── Sub-components ─────────────────────────────────────────────────────────

function KpiTile({
  icon, label, value, sub, colorClass, borderClass,
}: {
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

function ChartCard({
  title, legend, children,
}: {
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

function NoData() {
  return (
    <div className="flex flex-col items-center justify-center h-[220px] gap-2">
      <i className="bi bi-inbox text-3xl text-gray-600"></i>
      <p className="text-sm text-gray-500">No saved shift data for this period</p>
      <p className="text-xs text-gray-600 max-w-xs text-center">
        Shift readings appear here once machines save their shift data via the PLC
      </p>
    </div>
  );
}

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

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Analytics() {
  const [period, setPeriod]         = useState<Period>(14);
  const [trend, setTrend]           = useState<FleetTrendRow[]>([]);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, th] = await Promise.all([fetchFleetTrend(period), fetchThresholds()]);
      setTrend(data);
      setThresholds(th);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  // ── Summary KPIs over entire period ──
  const hasData   = trend.length > 0;
  const avgUptime = hasData ? trend.reduce((s, d) => s + d.avgUptime, 0) / trend.length : null;
  const avgScrap  = hasData ? trend.reduce((s, d) => s + d.avgScrap,  0) / trend.length : null;
  const totalBoxes = trend.reduce((s, d) => s + d.totalBoxes, 0);
  const totalSwabs = trend.reduce((s, d) => s + d.totalSwabs, 0);

  const ec = applyEfficiencyColor(avgUptime, thresholds);
  const sc = applyScrapColor(avgScrap, thresholds);

  const fmtDate = (d: string) => {
    try { return format(parseISO(d), "dd.MM"); } catch { return d; }
  };

  // Scrap Y-axis ceiling: show at least up to the mediocre threshold + a bit of headroom
  const scrapCeil = (dataMax: number) =>
    Math.ceil(Math.max(dataMax, thresholds.scrap.mediocre) + 1);

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Fleet Analytics</h2>
        <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.days}
              onClick={() => setPeriod(opt.days)}
              className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                period === opt.days
                  ? "bg-cyan-600/30 text-cyan-400 font-medium"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          ))}
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
              sub={`Park average · last ${period} days`}
              colorClass={ec.text}
              borderClass={ec.border}
            />
            <KpiTile
              icon="bi-exclamation-triangle"
              label="Avg Scrap Rate"
              value={avgScrap !== null ? `${avgScrap.toFixed(1)}%` : "—"}
              sub={`Park average · last ${period} days`}
              colorClass={sc.text}
              borderClass={sc.border}
            />
            <KpiTile
              icon="bi-box-seam"
              label="Total Output"
              value={totalBoxes > 0 ? totalBoxes.toLocaleString() : "—"}
              sub={`Boxes produced · last ${period} days`}
              colorClass="text-white"
              borderClass="border-gray-600"
            />
            <KpiTile
              icon="bi-diamond"
              label="Total Swabs"
              value={totalSwabs > 0 ? `${(totalSwabs / 1_000_000).toFixed(2)}M` : "—"}
              sub={`Swabs produced · last ${period} days`}
              colorClass="text-white"
              borderClass="border-gray-600"
            />
          </div>

          {/* ── Trend charts (2 columns) ── */}
          <div className="grid grid-cols-2 gap-4 mb-4">

            {/* Uptime trend */}
            <ChartCard
              title="Avg Uptime — daily park average"
              legend={
                <>
                  <DashLegendLine color="#22d3ee" label={`Good (${thresholds.efficiency.good}%)`} />
                  <DashLegendLine color="#f59e0b" label={`Mediocre (${thresholds.efficiency.mediocre}%)`} />
                </>
              }
            >
              {!hasData ? <NoData /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={TICK_STYLE}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_COLOR }}
                      tickFormatter={fmtDate}
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
                      labelFormatter={fmtDate}
                      formatter={(v: number) => [`${v.toFixed(1)}%`, "Uptime"]}
                    />
                    <ReferenceLine
                      y={thresholds.efficiency.good}
                      stroke="#22d3ee" strokeDasharray="4 2" strokeOpacity={0.45}
                    />
                    <ReferenceLine
                      y={thresholds.efficiency.mediocre}
                      stroke="#f59e0b" strokeDasharray="4 2" strokeOpacity={0.45}
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
              title="Avg Scrap Rate — daily park average"
              legend={
                <>
                  <DashLegendLine color="#4ade80" label={`Good (≤${thresholds.scrap.good}%)`} />
                  <DashLegendLine color="#f59e0b" label={`Mediocre (≤${thresholds.scrap.mediocre}%)`} />
                </>
              }
            >
              {!hasData ? <NoData /> : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={TICK_STYLE}
                      tickLine={false}
                      axisLine={{ stroke: AXIS_COLOR }}
                      tickFormatter={fmtDate}
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
                      labelFormatter={fmtDate}
                      formatter={(v: number) => [`${v.toFixed(1)}%`, "Scrap"]}
                    />
                    <ReferenceLine
                      y={thresholds.scrap.good}
                      stroke="#4ade80" strokeDasharray="4 2" strokeOpacity={0.45}
                    />
                    <ReferenceLine
                      y={thresholds.scrap.mediocre}
                      stroke="#f59e0b" strokeDasharray="4 2" strokeOpacity={0.45}
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

          {/* ── Daily output bar chart ── */}
          <ChartCard title="Daily Box Output — total across all machines">
            {!hasData ? <NoData /> : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={trend} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={{ stroke: AXIS_COLOR }}
                    tickFormatter={fmtDate}
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
                    labelFormatter={fmtDate}
                    formatter={(v: number) => [v.toLocaleString(), "Boxes"]}
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
