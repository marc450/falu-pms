"use client";

import { useEffect, useState, useCallback } from "react";
import {
  fetchMachines,
  fetchRegisteredMachines,
  fetchProductionCells,
} from "@/lib/supabase";
import type { MachineData, RegisteredMachine, ProductionCell } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface CellStats {
  cell: ProductionCell;
  total: number;
  running: number;
  avgEfficiency: number | null;
  avgScrap: number | null;
  totalSwabs: number;
  totalBlisters: number;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function isRunning(status: string | undefined): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s !== "offline" && s !== "error" && s !== "idle";
}

function computeCellStats(
  cell: ProductionCell,
  machines: RegisteredMachine[],
  live: Record<string, MachineData>
): CellStats {
  const cellMachines = machines
    .filter((m) => m.cell_id === cell.id)
    .sort((a, b) => (a.cell_position ?? 0) - (b.cell_position ?? 0));

  let running = 0;
  let effSum = 0, effCount = 0;
  let scrapSum = 0, scrapCount = 0;
  let totalSwabs = 0;
  let totalBlisters = 0;

  for (const m of cellMachines) {
    const ld = live[m.machine_code];
    const ms = ld?.machineStatus;
    if (isRunning(ms?.Status)) running++;
    if (ms?.Efficiency) { effSum += ms.Efficiency; effCount++; }
    if (ms?.Reject)     { scrapSum += ms.Reject;   scrapCount++; }
    if (ms?.Swaps)      totalSwabs   += ms.Swaps;
    if (ms?.Boxes)      totalBlisters += ms.Boxes;
  }

  return {
    cell,
    total: cellMachines.length,
    running,
    avgEfficiency: effCount > 0 ? effSum / effCount : null,
    avgScrap:      scrapCount > 0 ? scrapSum / scrapCount : null,
    totalSwabs,
    totalBlisters,
  };
}

function effColor(eff: number | null): { text: string; bg: string; bar: string } {
  if (eff === null) return { text: "text-gray-500", bg: "bg-gray-800", bar: "bg-gray-700" };
  if (eff >= 85)    return { text: "text-green-400",  bg: "bg-green-900/20",  bar: "bg-green-500"  };
  if (eff >= 70)    return { text: "text-yellow-400", bg: "bg-yellow-900/20", bar: "bg-yellow-500" };
  return               { text: "text-red-400",    bg: "bg-red-900/20",    bar: "bg-red-500"    };
}

function scrapColor(scrap: number | null): string {
  if (scrap === null) return "text-gray-500";
  if (scrap <= 2)     return "text-green-400";
  if (scrap <= 5)     return "text-yellow-400";
  return "text-red-400";
}

// ─────────────────────────────────────────────────────────────
// Cell performance card
// ─────────────────────────────────────────────────────────────
function CellCard({ stats, rank }: { stats: CellStats; rank?: number }) {
  const ec = effColor(stats.avgEfficiency);
  const maxEff = 100;
  const barWidth = stats.avgEfficiency != null
    ? Math.min(100, (stats.avgEfficiency / maxEff) * 100)
    : 0;

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
      {/* Card header */}
      <div className="px-5 py-4 bg-gray-800 border-b border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {rank !== undefined && (
            <span className="text-xs font-bold text-gray-500 w-4">#{rank}</span>
          )}
          <i className="bi bi-collection text-cyan-400"></i>
          <span className="text-white font-semibold">{stats.cell.name}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className={`font-bold ${stats.running > 0 ? "text-green-400" : "text-gray-500"}`}>
            {stats.running}
          </span>
          <span className="text-gray-600">/</span>
          <span className="text-gray-400">{stats.total}</span>
          <span className="text-gray-500 ml-1">running</span>
        </div>
      </div>

      {/* Metrics */}
      <div className="px-5 py-4 space-y-4">

        {/* Efficiency with bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-gray-400">Avg Efficiency</span>
            <span className={`text-sm font-bold ${ec.text}`}>
              {stats.avgEfficiency != null ? `${stats.avgEfficiency.toFixed(1)}%` : "—"}
            </span>
          </div>
          <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${ec.bar}`}
              style={{ width: `${barWidth}%` }}
            />
          </div>
        </div>

        {/* Scrap rate */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Avg Scrap Rate</span>
          <span className={`text-sm font-bold ${scrapColor(stats.avgScrap)}`}>
            {stats.avgScrap != null ? `${stats.avgScrap.toFixed(1)}%` : "—"}
          </span>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-700/60" />

        {/* Output */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Total Swabs</p>
            <p className="text-sm font-semibold text-white">
              {stats.totalSwabs > 0 ? stats.totalSwabs.toLocaleString() : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-0.5">Total Blisters</p>
            <p className="text-sm font-semibold text-white">
              {stats.totalBlisters > 0 ? stats.totalBlisters.toLocaleString() : "—"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Efficiency ranking bar chart
// ─────────────────────────────────────────────────────────────
function EfficiencyRanking({ stats }: { stats: CellStats[] }) {
  const ranked = [...stats]
    .filter((s) => s.avgEfficiency !== null)
    .sort((a, b) => (b.avgEfficiency ?? 0) - (a.avgEfficiency ?? 0));

  if (ranked.length === 0) return null;

  const max = ranked[0].avgEfficiency ?? 100;

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-xl overflow-hidden">
      <div className="px-5 py-4 bg-gray-800 border-b border-gray-700">
        <h3 className="text-white font-semibold text-sm flex items-center gap-2">
          <i className="bi bi-trophy text-yellow-400"></i>
          Efficiency Ranking
        </h3>
        <p className="text-gray-500 text-xs mt-0.5">Cells ranked by average machine efficiency</p>
      </div>
      <div className="px-5 py-4 space-y-3">
        {ranked.map((s, i) => {
          const ec = effColor(s.avgEfficiency);
          const pct = max > 0 ? ((s.avgEfficiency ?? 0) / max) * 100 : 0;
          return (
            <div key={s.cell.id} className="flex items-center gap-3">
              <span className="text-xs text-gray-500 w-4 shrink-0">#{i + 1}</span>
              <span className="text-sm text-gray-300 w-28 shrink-0 truncate">{s.cell.name}</span>
              <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${ec.bar}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className={`text-sm font-bold w-14 text-right shrink-0 ${ec.text}`}>
                {s.avgEfficiency?.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Analytics page
// ─────────────────────────────────────────────────────────────
export default function AnalyticsPage() {
  const [cellStats, setCellStats] = useState<CellStats[]>([]);
  const [currentShift, setCurrentShift] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [loading, setLoading] = useState(true);
  const [noCells, setNoCells] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [registered, cells, bridgeState] = await Promise.all([
        fetchRegisteredMachines(),
        fetchProductionCells(),
        fetchMachines().catch(() => null),
      ]);

      if (cells.length === 0) {
        setNoCells(true);
        setLoading(false);
        return;
      }

      setNoCells(false);
      if (bridgeState) setCurrentShift(bridgeState.currentShiftNumber || 0);

      const liveData = bridgeState?.machines ?? {};
      const stats = cells.map((cell) => computeCellStats(cell, registered, liveData));
      setCellStats(stats);
    } catch (err) {
      console.error("Analytics load failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const dataInterval  = setInterval(loadData, 5000);
    const clockInterval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => { clearInterval(dataInterval); clearInterval(clockInterval); };
  }, [loadData]);

  // Sort cards by efficiency descending for ranking-aware display
  const ranked = [...cellStats].sort(
    (a, b) => (b.avgEfficiency ?? -1) - (a.avgEfficiency ?? -1)
  );

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Analytics</h2>
          <p className="text-gray-500 text-xs mt-0.5">Cell Performance Comparison</p>
        </div>
        <div className="flex gap-2">
          <span className="bg-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-full">
            <i className="bi bi-calendar3 mr-1"></i>
            {currentTime.toLocaleString("de-DE")}
          </span>
          {currentShift > 0 && (
            <span className="bg-blue-900/40 text-blue-300 text-xs px-3 py-1.5 rounded-full">
              <i className="bi bi-clock mr-1"></i>Shift {currentShift}
            </span>
          )}
          <span className="bg-gray-700/50 text-gray-500 text-xs px-3 py-1.5 rounded-full">
            <i className="bi bi-arrow-repeat mr-1"></i>Live · 5s
          </span>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-gray-400 py-16 justify-center">
          <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></span>
          Loading…
        </div>
      )}

      {/* No cells configured */}
      {!loading && noCells && (
        <div className="bg-gray-800/50 border border-dashed border-gray-700 rounded-xl p-16 text-center">
          <i className="bi bi-collection text-4xl text-gray-600 mb-3 block"></i>
          <p className="text-gray-400 text-sm font-medium">No production cells configured</p>
          <p className="text-gray-600 text-xs mt-1">
            Go to <strong className="text-gray-500">Settings → Machines</strong> to create cells and assign machines.
          </p>
        </div>
      )}

      {/* Cell cards */}
      {!loading && !noCells && (
        <>
          <div className={`grid gap-4 mb-6 ${
            ranked.length === 1 ? "grid-cols-1 max-w-sm" :
            ranked.length === 2 ? "grid-cols-2" :
            "grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
          }`}>
            {ranked.map((stats, i) => (
              <CellCard key={stats.cell.id} stats={stats} rank={i + 1} />
            ))}
          </div>

          {/* Ranking chart — only useful with 2+ cells */}
          {ranked.length >= 2 && <EfficiencyRanking stats={ranked} />}
        </>
      )}
    </div>
  );
}
