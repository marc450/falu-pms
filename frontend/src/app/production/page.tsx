"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  fetchMachine, fetchMachineTargets, fetchSavedShiftLogs, fetchThresholds, fetchShiftConfig,
  fetchShiftAssignments, fetchRegisteredMachines, fetchMachineDailyTrend, fetchMachineHourlyTrend,
  fetchMachinePeers, fetchPeersDailyTrend, fetchPeersHourlyTrend,
  PACKING_FORMATS,
} from "@/lib/supabase";
import type {
  MachineData, MachineTargets, ShiftDataMessage, SavedShiftLog, PackingFormat,
  Thresholds, ShiftConfig, FleetTrendRow, DateRange, MachineType,
} from "@/lib/supabase";
import { formatMinutesToTime, getStatusColor, formatStatus } from "@/lib/utils";
import { fmtN, fmtPct } from "@/lib/fmt";
import {
  ProductionTrendSection, PeriodSelector, PRESETS,
} from "@/components/ProductionTrend";
import type { Preset, PresetId } from "@/components/ProductionTrend";

function ProductionContent() {
  const searchParams = useSearchParams();
  const machineName = searchParams.get("machine") || "";
  const packingFormat = (searchParams.get("packing") || null) as PackingFormat | null;
  const [machine, setMachine] = useState<MachineData | null>(null);
  const [savedLogs, setSavedLogs] = useState<SavedShiftLog[]>([]);
  const [targets, setTargets] = useState<MachineTargets | null>(null);
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [shiftConfig, setShiftConfig] = useState<ShiftConfig | null>(null);
  const [todayTeams, setTodayTeams] = useState<(string | null)[]>([]);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const failCount = useRef(0);
  const router = useRouter();

  // Production Trend state — mirrors the Analytics fleet tab.
  // Defaults to 24h on the machine page (vs 7d on Analytics) to match the
  // "right now" framing of the Machine Monitor.
  const MACHINE_DEFAULT_PRESET: PresetId = "24h";
  const [trendPresetId, setTrendPresetId] = useState<PresetId | "custom">(MACHINE_DEFAULT_PRESET);
  const [trendRange, setTrendRange] = useState<DateRange>(() =>
    PRESETS.find(p => p.id === MACHINE_DEFAULT_PRESET)!.getRange()
  );
  const [trendRows, setTrendRows] = useState<FleetTrendRow[]>([]);
  const [trendGranularity, setTrendGranularity] = useState<"hour" | "day">("day");
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [peerRows, setPeerRows] = useState<FleetTrendRow[]>([]);
  const [peerType, setPeerType] = useState<MachineType | null>(null);
  const [peerCount, setPeerCount] = useState<number>(0);

  const loadData = useCallback(async () => {
    if (!machineName) return;
    try {
      const data = await fetchMachine(machineName);
      setMachine(data);
      setOffline(false);
      failCount.current = 0;
    } catch {
      failCount.current += 1;
      if (failCount.current >= 3) setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [machineName]);

  const loadSavedLogs = useCallback(async () => {
    if (!machineName) return;
    try {
      const logs = await fetchSavedShiftLogs(machineName);
      setSavedLogs(logs);
    } catch { /* non-fatal */ }
  }, [machineName]);

  useEffect(() => {
    if (!machineName) {
      setLoading(false);
      return;
    }
    fetchMachineTargets(machineName)
      .then(setTargets)
      .catch(() => {});
    fetchRegisteredMachines()
      .then((rows) => {
        const m = rows.find((r) => r.machine_code === machineName);
        if (m && m.name && m.name !== m.machine_code) setDisplayName(m.name);
      })
      .catch(() => {});
    fetchThresholds()
      .then(setThresholds)
      .catch(() => {});
    fetchShiftConfig()
      .then(setShiftConfig)
      .catch(() => {});
    const today = new Date().toISOString().slice(0, 10);
    fetchShiftAssignments(today, today)
      .then(rows => { if (rows[0]) setTodayTeams(rows[0].slot_teams); })
      .catch(() => {});

    loadData();
    loadSavedLogs();

    // Poll live bridge data every 2 s; refresh saved logs every 30 s
    const dataInterval    = setInterval(loadData, 2000);
    const savedLogsInterval = setInterval(loadSavedLogs, 30000);

    return () => {
      clearInterval(dataInterval);
      clearInterval(savedLogsInterval);
    };
  }, [machineName, loadData, loadSavedLogs]);

  // Load production trend (machine + peer benchmark) for the selected period.
  // 24h preset → hourly data, all other presets → daily.
  useEffect(() => {
    if (!machineName) return;
    setTrendLoading(true);
    setTrendError(null);
    // For presets, recompute the range so `end` = now() at call time.
    const effectiveRange: DateRange =
      trendPresetId !== "custom"
        ? PRESETS.find(p => p.id === trendPresetId)!.getRange()
        : trendRange;
    const isHourly = trendPresetId === "24h";

    (async () => {
      try {
        // Self trend first; peer info second. Peers depends on the machine's
        // machine_type which is read by fetchMachinePeers.
        const [selfResult, peers] = await Promise.all([
          isHourly
            ? fetchMachineHourlyTrend(machineName, effectiveRange)
            : fetchMachineDailyTrend(machineName, effectiveRange),
          fetchMachinePeers(machineName),
        ]);
        setTrendRows(selfResult.rows);
        setTrendGranularity(selfResult.granularity);
        setPeerType(peers.machineType);
        setPeerCount(peers.peerCodes.length);

        if (peers.peerCodes.length === 0) {
          setPeerRows([]);
        } else {
          const peerResult = isHourly
            ? await fetchPeersHourlyTrend(peers.peerIds, effectiveRange)
            : await fetchPeersDailyTrend(peers.peerCodes, effectiveRange);
          setPeerRows(peerResult.rows);
        }
      } catch (e) {
        setTrendError(e instanceof Error ? e.message : "Failed to load trend");
      } finally {
        setTrendLoading(false);
      }
    })();
  }, [machineName, trendPresetId, trendRange]);

  const status = getStatusColor(machine?.machineStatus?.Status);

  const slots = shiftConfig?.slots ?? [];

  // Determine which crew is currently active from time + shift config + schedule
  const currentCrew = (() => {
    if (!shiftConfig || slots.length === 0) return null;
    const now = new Date();
    const hour = now.getHours();
    let activeSlotIdx = 0;
    for (let i = slots.length - 1; i >= 0; i--) {
      if (hour >= slots[i].startHour) { activeSlotIdx = i; break; }
    }
    return todayTeams[activeSlotIdx] ?? null;
  })();

  // Crew names for today's columns (from shift schedule)
  const crewNames = todayTeams.filter((t): t is string => t !== null);

  const shiftCellClass = (crew: string) =>
    crew === currentCrew ? "font-bold bg-cyan-900/20" : "";

  // Map saved logs by shift_crew for O(1) lookup
  const savedByCrew: Record<string, SavedShiftLog> = {};
  for (const l of savedLogs) {
    const key = l.shift_crew ?? 'Unassigned';
    if (!savedByCrew[key]) savedByCrew[key] = l;
  }

  // Planned downtime budget for uptime correction
  const plannedDowntimeMins = thresholds?.bu.plannedDowntimeMinutes ?? 0;

  // Recalculate efficiency treating planned downtime as a budget.
  // Idle time up to the budget is expected and does not penalise uptime.
  // Error time always counts against uptime (never absorbed by the budget).
  const correctedEfficiency = (productionTime: number, idleTime: number, errorMins: number = 0): number => {
    const idleOnly      = Math.max(0, idleTime - errorMins);
    const unplannedIdle = Math.max(0, idleOnly - plannedDowntimeMins);
    const effectiveTime = productionTime + unplannedIdle + errorMins;
    return effectiveTime > 0 ? (productionTime / effectiveTime) * 100 : 0;
  };

  // Derive bridge-tracked error minutes for the active shift (completed stints
  // plus the current ongoing stint if the machine is in error state).
  // errorTimeSeconds comes from the bridge in seconds; convert to minutes to
  // match the unit of currentStint (ms / 60000 = minutes).
  const activeShiftErrorMins = (() => {
    const st = (machine?.machineStatus?.Status || "").toLowerCase();
    const currentStint = machine?.statusSince
      ? Math.max(0, (Date.now() - machine.statusSince) / 60000)
      : 0;
    const completedMins = (machine?.errorTimeSeconds ?? 0) / 60;
    return completedMins + (st === "error" ? currentStint : 0);
  })();

  // Build a unified ShiftDataMessage for a given crew:
  // - active crew → live bridge data (machineStatus fields)
  // - completed crew → most recent saved_shift_logs row
  const crewData = (crew: string): ShiftDataMessage | undefined => {
    if (crew === currentCrew) {
      const s = machine?.machineStatus;
      if (!s) return undefined;
      return {
        Shift:                  0,
        ProductionTime:         s.ProductionTime         ?? 0,
        IdleTime:               s.IdleTime               ?? 0,
        ProducedSwabs:          s.ProducedSwabs          ?? s.Swabs ?? 0,
        PackagedSwabs:          s.PackagedSwabs          ?? 0,
        DiscardedSwabs:         s.DiscardedSwabs         ?? 0,
        ProducedBoxes:          s.ProducedBoxes          ?? s.Boxes ?? 0,
        ProducedBoxesLayerPlus: s.ProducedBoxesLayerPlus ?? 0,
        CottonTears:            s.CottonTears            ?? 0,
        MissingSticks:          s.MissingSticks          ?? 0,
        FoultyPickups:          s.FoultyPickups          ?? 0,
        OtherErrors:            s.OtherErrors            ?? 0,
        Efficiency:             correctedEfficiency(s.ProductionTime ?? 0, s.IdleTime ?? 0, activeShiftErrorMins),
        Reject:                 s.Reject                 ?? 0,
      };
    }
    const log = savedByCrew[crew];
    if (!log) return undefined;
    return {
      Shift:                  0,
      ProductionTime:         log.production_time_seconds,
      IdleTime:               log.idle_time_seconds,
      ProducedSwabs:          log.produced_swabs,
      PackagedSwabs:          log.packaged_swabs,
      DiscardedSwabs:         log.discarded_swabs,
      ProducedBoxes:          log.produced_boxes,
      ProducedBoxesLayerPlus: log.produced_boxes_layer_plus,
      CottonTears:            log.cotton_tears,
      MissingSticks:          log.missing_sticks,
      FoultyPickups:          log.faulty_pickups,
      OtherErrors:            log.other_errors,
      Efficiency:             correctedEfficiency(log.production_time_seconds, log.idle_time_seconds),
      Reject:                 log.scrap_rate,
    };
  };

  // Total across all crews
  const totalData = (): ShiftDataMessage | undefined => {
    const allCrews = crewNames.map(crewData).filter((s): s is ShiftDataMessage => !!s);
    if (allCrews.length === 0) return undefined;
    const sum = allCrews.reduce((acc, s) => ({
      Shift:                  0,
      ProductionTime:         acc.ProductionTime         + s.ProductionTime,
      IdleTime:               acc.IdleTime               + s.IdleTime,
      ProducedSwabs:          acc.ProducedSwabs          + s.ProducedSwabs,
      PackagedSwabs:          acc.PackagedSwabs          + s.PackagedSwabs,
      DiscardedSwabs:         acc.DiscardedSwabs         + s.DiscardedSwabs,
      ProducedBoxes:          acc.ProducedBoxes          + s.ProducedBoxes,
      ProducedBoxesLayerPlus: acc.ProducedBoxesLayerPlus + s.ProducedBoxesLayerPlus,
      CottonTears:            acc.CottonTears            + s.CottonTears,
      MissingSticks:          acc.MissingSticks          + s.MissingSticks,
      FoultyPickups:          acc.FoultyPickups          + s.FoultyPickups,
      OtherErrors:            acc.OtherErrors            + s.OtherErrors,
      Efficiency:             0,
      Reject:                 0,
    }));
    const totalUnplannedIdle = allCrews.reduce((acc, s) => acc + Math.max(0, s.IdleTime - plannedDowntimeMins), 0);
    const effectiveTotalTime = sum.ProductionTime + totalUnplannedIdle;
    sum.Efficiency = effectiveTotalTime > 0 ? (sum.ProductionTime / effectiveTotalTime) * 100 : 0;
    sum.Reject     = sum.ProducedSwabs > 0 ? (sum.DiscardedSwabs / sum.ProducedSwabs) * 100 : 0;
    return sum;
  };

  const renderShiftValue = (
    shift: ShiftDataMessage | undefined,
    key: keyof ShiftDataMessage,
    format?: "time" | "percent" | "number"
  ) => {
    if (!shift) return <span className="text-gray-600">---</span>;
    const val = shift[key];
    if (val === undefined || val === null) return <span className="text-gray-600">---</span>;
    switch (format) {
      case "time":    return formatMinutesToTime(val as number);
      case "percent": return fmtPct(val as number, 1);
      default:        return fmtN(val as number);
    }
  };

  // Derive packaging label (e.g. "Blisters", "Boxes", "Bags") from URL param
  const packingLabel = packingFormat && PACKING_FORMATS[packingFormat]
    ? PACKING_FORMATS[packingFormat]
    : "Boxes";

  // Returns a Tailwind color class for a metric value based on thresholds.
  // "good" thresholds: higher is better (Uptime). "bad" thresholds: lower is better (Scrap).
  const uptimeColor = (v: number): string => {
    const good = targets?.efficiency_good ?? null;
    const med  = targets?.efficiency_mediocre ?? null;
    if (good === null && med === null) return "";          // no targets → no color
    if (good !== null && v >= good)    return "text-green-400";
    if (med  !== null && v >= med)     return "text-yellow-400";
    return "text-red-400";
  };
  const scrapColor = (v: number): string => {
    const good = targets?.scrap_good ?? null;
    const med  = targets?.scrap_mediocre ?? null;
    if (good === null && med === null) return "";          // no targets → no color
    if (good !== null && v <= good)    return "text-green-400";
    if (med  !== null && v <= med)     return "text-yellow-400";
    return "text-red-400";
  };

  type MetricDef = {
    label: string;
    key: keyof ShiftDataMessage;
    format?: "time" | "percent" | "number";
    colorFn?: (val: number) => string;
  };

  const metrics: MetricDef[] = [
    { label: "Production Time", key: "ProductionTime", format: "time" },
    { label: "Idle Time",       key: "IdleTime",       format: "time" },
    { label: "Uptime",          key: "Efficiency",     format: "percent", colorFn: uptimeColor },
    { label: "Produced Swabs",  key: "ProducedSwabs" },
    { label: "Packaged Swabs",  key: "PackagedSwabs" },
    { label: "Discarded Swabs", key: "DiscardedSwabs" },
    { label: "Scrap",           key: "Reject",         format: "percent", colorFn: scrapColor },
    { label: `Produced ${packingLabel}`,       key: "ProducedBoxes" },
    { label: `${packingLabel} w. Extra Layer`, key: "ProducedBoxesLayerPlus" },
  ];

  const errorMetrics: MetricDef[] = [
    { label: "Cotton Tears",   key: "CottonTears" },   // no hardcoded color — no thresholds configured
    { label: "Missing Sticks", key: "MissingSticks" },
    { label: "Faulty Pickups", key: "FoultyPickups" },
    { label: "Other Errors",   key: "OtherErrors" },
  ];

  // Per-cell color: apply colorFn to the actual value in that shift
  const cellColor = (metric: MetricDef, shift: ShiftDataMessage | undefined): string => {
    if (!metric.colorFn || !shift) return "";
    const val = shift[metric.key];
    if (val === undefined || val === null) return "";
    return metric.colorFn(val as number);
  };

  if (!machineName) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">No machine selected. Go back to the dashboard.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500 flex items-center gap-2">
          <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
          Loading machine data...
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="px-3 py-1.5 bg-gray-700 text-gray-300 rounded-lg hover:bg-gray-600 transition-colors text-sm"
          >
            <i className="bi bi-arrow-left mr-1"></i> Back
          </button>
          <h2 className="text-xl font-bold text-white">
            Machine Monitor — <span className="text-cyan-400">{displayName ?? machineName}</span>
            {displayName && (
              <span className="text-gray-500 text-sm font-normal ml-2">({machineName})</span>
            )}
          </h2>
        </div>
        <span className="bg-cyan-900/30 text-cyan-400 text-xs px-3 py-1.5 rounded-full">
          Live Data
        </span>
      </div>

      {(offline || !machine) && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-6 py-12 flex flex-col items-center gap-3 text-center">
          <i className="bi bi-wifi-off text-4xl text-gray-600"></i>
          <p className="text-gray-300 font-medium">Machine Offline</p>
          <p className="text-gray-500 text-sm max-w-sm">
            <span className="text-cyan-400 font-mono">{machineName}</span> is not currently connected to the MQTT bridge. Live shift data will appear here automatically once the machine comes online.
          </p>
        </div>
      )}

      {/* ── Production Trend (per-machine history) ── */}
      {thresholds && (
        <div className="mt-8">
          <div className="flex justify-between items-center mb-4 gap-4">
            <h3 className="text-lg font-semibold text-white">Production Trend</h3>
            <PeriodSelector
              activePresetId={trendPresetId}
              dateRange={trendRange}
              onPresetSelect={(preset: Preset) => {
                setTrendPresetId(preset.id);
                setTrendRange(preset.getRange());
              }}
              onCustomRange={(range) => {
                setTrendPresetId("custom");
                setTrendRange(range);
              }}
            />
          </div>
          <ProductionTrendSection
            rows={trendRows}
            granularity={trendGranularity}
            loading={trendLoading}
            error={trendError}
            thresholds={{
              efficiency: {
                good:     targets?.efficiency_good     ?? thresholds.efficiency.good,
                mediocre: targets?.efficiency_mediocre ?? thresholds.efficiency.mediocre,
              },
              scrap: {
                good:     targets?.scrap_good     ?? thresholds.scrap.good,
                mediocre: targets?.scrap_mediocre ?? thresholds.scrap.mediocre,
              },
              bu: thresholds.bu,
            }}
            buTargetPerShift={targets?.bu_target ?? null}
            buMediocrePerShift={targets?.bu_mediocre ?? null}
            dateRange={trendRange}
            showTotalSwabs={false}
            peerRows={peerRows}
            peerLabel={peerType ? `Peers (${peerType}, ${peerCount})` : undefined}
          />
        </div>
      )}
    </div>
  );
}

export default function ProductionPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500 flex items-center gap-2">
            <span className="inline-block w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></span>
            Loading...
          </div>
        </div>
      }
    >
      <ProductionContent />
    </Suspense>
  );
}
