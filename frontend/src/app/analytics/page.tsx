"use client";

import { useEffect, useState, useCallback } from "react";
import { format } from "date-fns";
import {
  fetchFleetTrend, fetchHourlyAnalytics, fetchRegisteredMachines, fetchThresholds, fetchShiftConfig,
  fetchShiftAssignments,
  DEFAULT_THRESHOLDS,
} from "@/lib/supabase";
import type { DateRange, FleetTrendRow, Thresholds, RegisteredMachine, TimeSlot, ShiftAssignment } from "@/lib/supabase";
import { ProductionTrendSection, PeriodSelector, PRESETS, DEFAULT_PRESET_ID } from "@/components/ProductionTrend";
import type { Preset, PresetId } from "@/components/ProductionTrend";
import { useFactoryTimezone } from "@/lib/useFactoryTimezone";
import MachineAnalytics from "./MachineAnalytics";
import ShiftAnalytics   from "./ShiftAnalytics";
import DowntimeAnalytics from "./DowntimeAnalytics";


// ─── Tab types ────────────────────────────────────────────────────────────────

type AnalyticsTab = "fleet" | "machines" | "shifts" | "downtime";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Analytics() {
  // Factory timezone — every preset's date math is computed against the
  // factory's calendar (see useFactoryTimezone). For viewers outside the
  // factory's tz this is the difference between "Last 7 days" meaning
  // their week or the factory's week.
  const factoryTz = useFactoryTimezone();

  const [activePresetId, setActivePresetId] = useState<PresetId | "custom">(DEFAULT_PRESET_ID);
  const [dateRange, setDateRange]           = useState<DateRange>(() =>
    PRESETS.find(p => p.id === DEFAULT_PRESET_ID)!.getRange(factoryTz)
  );
  const [tab, setTab]                     = useState<AnalyticsTab>("fleet");
  const [rows, setRows]                   = useState<FleetTrendRow[]>([]);
  const [granularity, setGranularity]     = useState<"hour" | "day">("day");
  const [thresholds, setThresholds]       = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [buTargetPerShift, setBuTargetPerShift]       = useState<number | null>(null); // sum of all machines' BU targets (per shift)
  const [buMediocrePerShift, setBuMediocrePerShift]   = useState<number | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [machines, setMachines]           = useState<RegisteredMachine[]>([]);
  const [shiftSlots, setShiftSlots]             = useState<TimeSlot[]>([]);
  const [shiftAssignments, setShiftAssignments] = useState<Record<string, ShiftAssignment>>({});

  const load = useCallback(async (bustCache = false) => {
    setLoading(true);
    setError(null);
    // For presets, always recompute the range so `end` = now() at call time.
    // Storing the range at mount would freeze the window and miss readings
    // that arrive after the page first loaded.
    const effectiveRange: DateRange =
      activePresetId !== "custom"
        ? PRESETS.find(p => p.id === activePresetId)!.getRange(factoryTz)
        : dateRange;
    try {
      const rangeFrom = effectiveRange.start.toISOString().slice(0, 10);
      const rangeTo   = effectiveRange.end.toISOString().slice(0, 10);

      // ── SessionStorage cache (2-minute TTL) ──────────────────────────────
      // get_fleet_trend is expensive (~3-8s). Cache the full payload so that
      // navigating away and back within two minutes skips the DB round-trip.
      const CACHE_TTL_MS = 2 * 60 * 1000;
      const cacheKey = `fleet_trend_${activePresetId}_${rangeFrom}_${rangeTo}`;

      let cachedResult: Awaited<ReturnType<typeof fetchFleetTrend>> | null = null;
      if (!bustCache) {
        try {
          const raw = sessionStorage.getItem(cacheKey);
          if (raw) {
            const { ts, payload } = JSON.parse(raw);
            if (Date.now() - ts < CACHE_TTL_MS) cachedResult = payload;
            else sessionStorage.removeItem(cacheKey);
          }
        } catch { /* sessionStorage unavailable — ignore */ }
      }

      const [result, machines, savedThresholds, shiftCfg, assignmentRows] = await Promise.all([
        cachedResult
          ? Promise.resolve(cachedResult)
          : activePresetId === "24h"
            ? fetchHourlyAnalytics(effectiveRange)
            : fetchFleetTrend(effectiveRange),
        fetchRegisteredMachines(),
        fetchThresholds(),
        fetchShiftConfig(),
        fetchShiftAssignments(rangeFrom, rangeTo),
      ]);

      if (!cachedResult) {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), payload: result }));
        } catch { /* quota exceeded or unavailable — ignore */ }
      }
      setShiftSlots(shiftCfg.slots);
      // Build a lookup map keyed by shift_date for O(1) access in child components.
      // Normalise team names against the configured list (case-insensitive) so legacy
      // values like "Shift C" resolve to the canonical "SHIFT C" even before the
      // DB migration runs.
      const canonMap = new Map<string, string>();
      for (const t of shiftCfg.teams) canonMap.set(t.toUpperCase(), t);
      const normalisedRows = assignmentRows.map(a => ({
        ...a,
        slot_teams: a.slot_teams.map(v => (v ? (canonMap.get(v.toUpperCase()) ?? v) : v)),
      }));
      setShiftAssignments(Object.fromEntries(normalisedRows.map(a => [a.shift_date, a])));
      setRows(result.rows);
      setGranularity(result.granularity);
      setMachines(machines);

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
    const timer = setInterval(() => load(true), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [load]);

  function handlePresetSelect(preset: Preset) {
    setActivePresetId(preset.id);
    setDateRange(preset.getRange(factoryTz)); // also update custom inputs in the selector
  }

  function handleCustomRange(range: DateRange) {
    setActivePresetId("custom");
    setDateRange(range);
  }

  // When the factory timezone resolves (or changes), recompute any
  // preset-driven date range so it lines up with the factory calendar.
  useEffect(() => {
    if (activePresetId !== "custom") {
      setDateRange(PRESETS.find(p => p.id === activePresetId)!.getRange(factoryTz));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryTz]);

  // Period range used by sub-tab analytics (and by the fleet section internally).
  const kpiRange: DateRange = activePresetId !== "custom"
    ? PRESETS.find(p => p.id === activePresetId)!.getRange(factoryTz)
    : dateRange;

  return (
    <div>
      {/* ── Header ── */}
      <div className="flex justify-between items-start mb-4 gap-6">
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
              onClick={() => load(true)}
              disabled={loading}
              title="Refresh now"
              className="text-gray-600 hover:text-gray-300 disabled:opacity-40 transition-colors"
            >
              <i className={`bi bi-arrow-clockwise text-xs ${loading ? "animate-spin" : ""}`}></i>
            </button>
          </div>
        )}
      </div>

      {/* ── Tab navigation ── */}
      <div className="flex gap-1 bg-gray-800/50 border border-gray-700 rounded-lg p-1 w-fit mb-5">
        {(["fleet", "machines", "downtime", "shifts"] as AnalyticsTab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === t
                ? "bg-blue-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
          >
            {t === "fleet" ? "Production Trend" : t === "machines" ? "Machine Performance" : t === "shifts" ? "Crew Comparison" : "Downtime"}
          </button>
        ))}
      </div>

      {/* ── Non-fleet tabs ── */}
      {tab === "machines" && (
        <MachineAnalytics dateRange={kpiRange} machines={machines} shiftSlots={shiftSlots} shiftAssignments={shiftAssignments} />
      )}
      {tab === "shifts" && (
        <ShiftAnalytics dateRange={kpiRange} machines={machines} shiftSlots={shiftSlots} shiftAssignments={shiftAssignments} />
      )}
      {tab === "downtime" && (
        <DowntimeAnalytics dateRange={kpiRange} machines={machines} />
      )}

      {tab === "fleet" && (
        <ProductionTrendSection
          rows={rows}
          granularity={granularity}
          loading={loading}
          error={error}
          thresholds={thresholds}
          buTargetPerShift={buTargetPerShift}
          buMediocrePerShift={buMediocrePerShift}
          dateRange={kpiRange}
          kpiSubLabel="Park average · selected period"
          chartTitleSuffix={granularity === "hour" ? "— intraday park total" : "— daily park total"}
        />
      )}
    </div>
  );
}
