"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUrlSync } from "@/lib/useUrlState";
import {
  fetchMachine, fetchMachineTargets, fetchSavedShiftLogs, fetchThresholds, fetchShiftConfig,
  fetchShiftAssignments, fetchRegisteredMachines, fetchMachinePeers,
  fetchMachineTrendAtGrain, fetchPeersTrendAtGrain, resolveGrain,
  fetchMachineErrorEvents, fetchErrorCodeLookup, ANALYTICS_SOURCE,
  PACKING_FORMATS,
} from "@/lib/supabase";
import type {
  MachineData, MachineTargets, ShiftDataMessage, SavedShiftLog, PackingFormat,
  Thresholds, ShiftConfig, FleetTrendRow, DateRange, MachineType,
  ErrorEvent, PlcErrorCode, GrainPref,
} from "@/lib/supabase";
import { formatSecondsToTime, getStatusColor, formatStatus } from "@/lib/utils";
import { fmtN, fmtPct } from "@/lib/fmt";
import {
  ProductionTrendSection, PeriodSelector, GranularitySelector, PRESETS,
} from "@/components/ProductionTrend";
import type { Preset, PresetId } from "@/components/ProductionTrend";
import MachineStateTimeline from "@/components/MachineStateTimeline";
import ErrorSummary from "@/components/ErrorSummary";
import { useFactoryTimezone } from "@/lib/useFactoryTimezone";

function ProductionContent() {
  // Query params are read AFTER mount (not in the render body) so the server-
  // built HTML and the first client render agree (both empty). Reading
  // window.location during render causes a hydration mismatch on static export,
  // which makes React discard the server markup and remount — the "flicker".
  const [mounted, setMounted] = useState(false);
  const [machineName, setMachineName] = useState("");
  const [packingFormat, setPackingFormat] = useState<PackingFormat | null>(null);
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setMachineName(sp.get("machine") || "");
    setPackingFormat((sp.get("packing") || null) as PackingFormat | null);
    setMounted(true);
  }, []);
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

  // Factory timezone — drives all preset date ranges so "Last 7 days" is
  // anchored to the factory's calendar day, not the browser's.
  const factoryTz = useFactoryTimezone();
  const url       = useUrlSync();

  // Production Trend state — mirrors the Analytics fleet tab.
  // Defaults to 24h on the machine page (vs 7d on Analytics) to match the
  // "right now" framing of the Machine Monitor.
  const MACHINE_DEFAULT_PRESET: PresetId = "24h";
  const [trendPresetId, setTrendPresetId] = useState<PresetId | "custom">(() => {
    const p = url.get("preset");
    return (p && (PRESETS.some(pr => pr.id === p) || p === "custom") ? p : MACHINE_DEFAULT_PRESET) as PresetId | "custom";
  });
  const [trendRange, setTrendRange] = useState<DateRange>(() => {
    const p = url.get("preset") as PresetId | "custom" | null;
    if (p === "custom") {
      const s = url.get("start"); const e = url.get("end");
      if (s && e) return { start: new Date(s), end: new Date(e) };
    }
    const preset = p ? PRESETS.find(pr => pr.id === p) : null;
    return (preset ?? PRESETS.find(pr => pr.id === MACHINE_DEFAULT_PRESET)!).getRange(factoryTz);
  });

  // If the factory tz resolves after first render (the hook starts with a
  // fallback), recompute any non-custom range so it lines up with factory
  // calendar boundaries.
  useEffect(() => {
    if (trendPresetId !== "custom") {
      setTrendRange(PRESETS.find(p => p.id === trendPresetId)!.getRange(factoryTz));
    }
    // Intentionally only react to factoryTz changes — preset changes handle
    // their own range update in the click handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factoryTz]);

  const [trendRows, setTrendRows] = useState<FleetTrendRow[]>([]);
  const [trendGranularity, setTrendGranularity] = useState<"hour" | "day">("day");
  // User override of the auto bucket size. "auto" keeps the bespoke window-based
  // routing below (5s < 6h, 5m ≤ 25h, daily beyond); an explicit grain (incl.
  // "Shift") routes through the ClickHouse proxy.
  const [trendGrainPref, setTrendGrainPref] = useState<GrainPref>(() => {
    const g = url.get("grain");
    return (g && ["auto","5s","5m","1h","shift","1d"].includes(g) ? g : "auto") as GrainPref;
  });
  // True when the rendered grain is "shift" → ProductionTrendSection draws bars.
  const [trendShiftMode, setTrendShiftMode] = useState(false);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [peerRows, setPeerRows] = useState<FleetTrendRow[]>([]);
  const [peerType, setPeerType] = useState<MachineType | null>(null);
  const [peerCount, setPeerCount] = useState<number>(0);
  const [errorEvents, setErrorEvents] = useState<ErrorEvent[]>([]);
  const [errorLookup, setErrorLookup] = useState<Record<string, PlcErrorCode>>({});
  // Always 5-min resolution regardless of trendGrainPref — the state timeline
  // needs fine buckets to show individual running/idle/error segments correctly.
  const [timelineRows, setTimelineRows] = useState<FleetTrendRow[]>([]);

  // Sync trend controls to URL so reloads land on the same view.
  useEffect(() => {
    url.set({
      preset: trendPresetId,
      grain:  trendGrainPref === "auto" ? null : trendGrainPref,
      start:  trendPresetId === "custom" ? trendRange.start.toISOString() : null,
      end:    trendPresetId === "custom" ? trendRange.end.toISOString()   : null,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendPresetId, trendGrainPref, trendRange]);

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
      // Only conclude "no machine" once the param has actually been read
      // (post-mount). Before that, keep the loading spinner up.
      if (mounted) setLoading(false);
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
  }, [machineName, mounted, loadData, loadSavedLogs]);

  // Load production trend (machine + peer benchmark) for the selected period.
  // Sub-day windows → 5-min intraday buckets; longer windows → daily summary.
  useEffect(() => {
    if (!machineName) return;
    setTrendLoading(true);
    setTrendError(null);
    // For presets, recompute the range so `end` = now() at call time.
    const effectiveRange: DateRange =
      trendPresetId !== "custom"
        ? PRESETS.find(p => p.id === trendPresetId)!.getRange(factoryTz)
        : trendRange;
    // windowMs gates the error-annotation overlay (a <=24h feature) below.
    const windowMs = effectiveRange.end.getTime() - effectiveRange.start.getTime();
    // Configured shift system for the "Shift" grain (aligns buckets to the
    // factory's wall clock). Falls back to 12h @ 07:00 until the config loads.
    const shiftHours     = shiftConfig?.shiftDurationHours ?? 12;
    const shiftStartHour = shiftConfig?.firstShiftStartHour ?? 7;
    const shiftMs        = shiftHours * 3_600_000;
    const shiftOpts      = { shiftHours, shiftStartHour, tz: factoryTz };
    // Single grain source of truth: resolve the ladder grain (auto resolves via
    // pickGranularity) and render at exactly that grain. This is the SAME path
    // the analytics/park page uses, so the dropdown label always matches the
    // drawn charts and the per-machine view agrees with the park overview. The
    // ClickHouse proxy owns every grain incl. 5s and "shift".
    const grain = resolveGrain(effectiveRange, trendGrainPref, shiftMs);
    setTrendShiftMode(grain === "shift");
    // State timeline (5m rows) and error annotation strip are intraday-only.
    const wantTimeline = windowMs <= 25 * 60 * 60 * 1000;

    (async () => {
      try {
        // Self trend first; peer info second. Peers depends on the machine's
        // machine_type which is read by fetchMachinePeers.
        const [selfResult, peers] = await Promise.all([
          fetchMachineTrendAtGrain(machineName, effectiveRange, grain, shiftOpts),
          fetchMachinePeers(machineName),
        ]);
        setTrendRows(selfResult.rows);
        setTrendGranularity(selfResult.granularity);
        setPeerType(peers.machineType);
        setPeerCount(peers.peerCodes.length);

        if (peers.peerCodes.length === 0) {
          setPeerRows([]);
        } else {
          const peerResult = await fetchPeersTrendAtGrain(peers.peerIds, effectiveRange, grain, shiftOpts);
          setPeerRows(peerResult.rows);
        }

        // Error events are always fetched — the summary card is useful at any range.
        // The 5m timeline rows are intraday-only (too many points otherwise).
        const [events, lookup] = await Promise.all([
          fetchMachineErrorEvents(machineName, effectiveRange),
          fetchErrorCodeLookup(),
        ]);
        setErrorEvents(events);
        setErrorLookup(lookup);

        if (wantTimeline) {
          // Always fetch at 5m regardless of the selected trend grain so the
          // state timeline keeps per-5-min bucket resolution.
          const timelineResult = await fetchMachineTrendAtGrain(machineName, effectiveRange, "5m", shiftOpts);
          setTimelineRows(timelineResult.rows);
        } else {
          setTimelineRows([]);
        }
      } catch (e) {
        setTrendError(e instanceof Error ? e.message : "Failed to load trend");
      } finally {
        setTrendLoading(false);
      }
    })();
  }, [machineName, trendPresetId, trendRange, trendGrainPref, shiftConfig, factoryTz]);

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
  //
  // Everything is SECONDS — productionSecs and idleSecs come from the PLC
  // (ProductionTime / IdleTime / production_time_seconds / idle_time_seconds)
  // and errorSecs is m.errorTimeSeconds. plannedDowntimeMins is converted
  // to seconds once. The earlier version mixed seconds (production/idle)
  // with minutes (error/budget), which under-counted error time and
  // inflated uptime for error-dominated machines.
  const plannedDowntimeSecs = plannedDowntimeMins * 60;
  const correctedEfficiency = (productionSecs: number, idleSecs: number, errorSecs: number = 0): number => {
    const idleOnlySecs      = Math.max(0, idleSecs - errorSecs);
    const unplannedIdleSecs = Math.max(0, idleOnlySecs - plannedDowntimeSecs);
    const effectiveSecs     = productionSecs + unplannedIdleSecs + errorSecs;
    return effectiveSecs > 0 ? (productionSecs / effectiveSecs) * 100 : 0;
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
      // Live crew error time includes the in-flight stint (currentStint) so
      // the displayed uptime reflects an active error before it closes.
      const activeShiftErrorSecs = activeShiftErrorMins * 60;
      return {
        Shift:                  0,
        ProductionTime:         s.ProductionTime         ?? 0,
        IdleTime:               s.IdleTime               ?? 0,
        ErrorTime:              activeShiftErrorSecs,
        ProducedSwabs:          s.ProducedSwabs          ?? s.Swabs ?? 0,
        PackagedSwabs:          s.PackagedSwabs          ?? 0,
        DiscardedSwabs:         s.DiscardedSwabs         ?? 0,
        ProducedBoxes:          s.ProducedBoxes          ?? s.Boxes ?? 0,
        ProducedBoxesLayerPlus: s.ProducedBoxesLayerPlus ?? 0,
        CottonTears:            s.CottonTears            ?? 0,
        MissingSticks:          s.MissingSticks          ?? 0,
        FaultyPickups:          s.FaultyPickups          ?? 0,
        OtherErrors:            s.OtherErrors            ?? 0,
        Efficiency:             correctedEfficiency(s.ProductionTime ?? 0, s.IdleTime ?? 0, activeShiftErrorSecs),
        Reject:                 s.Reject                 ?? 0,
      };
    }
    const log = savedByCrew[crew];
    if (!log) return undefined;
    return {
      Shift:                  0,
      ProductionTime:         log.production_time_seconds,
      IdleTime:               log.idle_time_seconds,
      ErrorTime:              log.error_time_seconds,
      ProducedSwabs:          log.produced_swabs,
      PackagedSwabs:          log.packaged_swabs,
      DiscardedSwabs:         log.discarded_swabs,
      ProducedBoxes:          log.produced_boxes,
      ProducedBoxesLayerPlus: log.produced_boxes_layer_plus,
      CottonTears:            log.cotton_tears,
      MissingSticks:          log.missing_sticks,
      FaultyPickups:          log.faulty_pickups,
      OtherErrors:            log.other_errors,
      Efficiency:             correctedEfficiency(log.production_time_seconds, log.idle_time_seconds, log.error_time_seconds),
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
      ErrorTime:              acc.ErrorTime              + s.ErrorTime,
      ProducedSwabs:          acc.ProducedSwabs          + s.ProducedSwabs,
      PackagedSwabs:          acc.PackagedSwabs          + s.PackagedSwabs,
      DiscardedSwabs:         acc.DiscardedSwabs         + s.DiscardedSwabs,
      ProducedBoxes:          acc.ProducedBoxes          + s.ProducedBoxes,
      ProducedBoxesLayerPlus: acc.ProducedBoxesLayerPlus + s.ProducedBoxesLayerPlus,
      CottonTears:            acc.CottonTears            + s.CottonTears,
      MissingSticks:          acc.MissingSticks          + s.MissingSticks,
      FaultyPickups:          acc.FaultyPickups          + s.FaultyPickups,
      OtherErrors:            acc.OtherErrors            + s.OtherErrors,
      Efficiency:             0,
      Reject:                 0,
    }));
    // Apply the per-crew planned-downtime budget independently before summing,
    // so a crew that under-uses its break budget doesn't subsidise a crew that
    // overruns. Match correctedEfficiency's idle/error handling exactly: strip
    // any error time bleed-through from idle first, then apply the budget,
    // then put error back into the denominator on its own line.
    const totalUnplannedIdle = allCrews.reduce((acc, s) => {
      const idleOnly = Math.max(0, s.IdleTime - s.ErrorTime);
      return acc + Math.max(0, idleOnly - plannedDowntimeSecs);
    }, 0);
    const totalErrorTime     = allCrews.reduce((acc, s) => acc + s.ErrorTime, 0);
    const effectiveTotalTime = sum.ProductionTime + totalUnplannedIdle + totalErrorTime;
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
      case "time":    return formatSecondsToTime(val as number);
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
    { label: "Faulty Pickups", key: "FaultyPickups" },
    { label: "Other Errors",   key: "OtherErrors" },
  ];

  // Per-cell color: apply colorFn to the actual value in that shift
  const cellColor = (metric: MetricDef, shift: ShiftDataMessage | undefined): string => {
    if (!metric.colorFn || !shift) return "";
    const val = shift[metric.key];
    if (val === undefined || val === null) return "";
    return metric.colorFn(val as number);
  };

  // Before mount, the query param hasn't been read yet — show loading rather
  // than briefly flashing "No machine selected".
  if (mounted && !machineName) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">No machine selected. Go back to the dashboard.</div>
      </div>
    );
  }

  if (!mounted || loading) {
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
      <div className="flex justify-between items-start mb-6 gap-6">
        <div className="flex flex-col gap-3">
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
          {thresholds && (
            <div className="flex items-center gap-2">
              <PeriodSelector
                activePresetId={trendPresetId}
                dateRange={trendRange}
                onPresetSelect={(preset: Preset) => {
                  setTrendPresetId(preset.id);
                  setTrendRange(preset.getRange(factoryTz));
                  setTrendGrainPref("auto"); // a new window invalidates a manual grain choice
                }}
                onCustomRange={(range) => {
                  setTrendPresetId("custom");
                  setTrendRange(range);
                  setTrendGrainPref("auto");
                }}
                factoryTz={factoryTz}
                fleetSize={1}
              />
              {ANALYTICS_SOURCE === "clickhouse" && (
                <GranularitySelector
                  dateRange={trendRange}
                  value={trendGrainPref}
                  onChange={setTrendGrainPref}
                  shiftMs={(shiftConfig?.shiftDurationHours ?? 12) * 3_600_000}
                />
              )}
            </div>
          )}
        </div>
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
          <h3 className="text-lg font-semibold text-white mb-4">Production Trend</h3>

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
            peerCount={peerCount}
            errorEvents={errorEvents}
            errorLookup={errorLookup}
            shiftMode={trendShiftMode}
            shiftSlots={shiftConfig?.slots ?? []}
            // Show the uptime chart whenever it isn't the intraday line view —
            // the shift bar view benefits from per-shift uptime bars too.
            showUptimeChart={trendShiftMode || trendGranularity !== "hour"}
          />

          {/* State timeline sits directly below the charts (intraday only). */}
          {!trendShiftMode && trendGranularity === "hour" && trendRows.length > 0 && (
            <div className="mt-4">
              <MachineStateTimeline
                rows={timelineRows}
                errorEvents={errorEvents}
                errorLookup={errorLookup}
              />
            </div>
          )}

          {/* Error summary is always the lowest element in the overview. */}
          {!trendLoading && (
            <div className="mt-4">
              <ErrorSummary
                errorEvents={errorEvents}
                errorLookup={errorLookup}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ProductionPage() {
  return <ProductionContent />;
}
