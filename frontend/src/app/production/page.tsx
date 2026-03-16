"use client";

import { useEffect, useState, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchMachine, fetchMachineTargets, fetchSavedShiftLogs, PACKING_FORMATS } from "@/lib/supabase";
import type { MachineData, MachineTargets, ShiftDataMessage, SavedShiftLog, PackingFormat } from "@/lib/supabase";
import { formatMinutesToTime, getStatusColor, formatStatus } from "@/lib/utils";

function ProductionContent() {
  const searchParams = useSearchParams();
  const machineName = searchParams.get("machine") || "";
  const packingFormat = (searchParams.get("packing") || null) as PackingFormat | null;
  const [machine, setMachine] = useState<MachineData | null>(null);
  const [savedLogs, setSavedLogs] = useState<SavedShiftLog[]>([]);
  const [targets, setTargets] = useState<MachineTargets | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const failCount = useRef(0);
  const router = useRouter();

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

  const status = getStatusColor(machine?.machineStatus?.Status);
  const activeShift = machine?.machineStatus?.ActShift || 0;

  const shiftCellClass = (shiftNum: number) =>
    activeShift === shiftNum ? "font-bold bg-cyan-900/20" : "";

  // Map saved logs by shift number for O(1) lookup
  const savedByShift = Object.fromEntries(savedLogs.map(l => [l.shift_number, l]));

  // Build a unified ShiftDataMessage for a given shift number:
  // - active shift → live bridge data (machineStatus fields)
  // - completed shift → most recent saved_shift_logs row
  const shiftData = (shiftNum: number): ShiftDataMessage | undefined => {
    if (shiftNum === activeShift) {
      const s = machine?.machineStatus;
      if (!s) return undefined;
      return {
        Shift:                  shiftNum,
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
        Efficiency:             s.Efficiency             ?? 0,
        Reject:                 s.Reject                 ?? 0,
      };
    }
    const log = savedByShift[shiftNum];
    if (!log) return undefined;
    return {
      Shift:                  log.shift_number,
      ProductionTime:         log.production_time,
      IdleTime:               log.idle_time,
      ProducedSwabs:          log.produced_swabs,
      PackagedSwabs:          log.packaged_swabs,
      DiscardedSwabs:         log.discarded_swabs,
      ProducedBoxes:          log.produced_boxes,
      ProducedBoxesLayerPlus: log.produced_boxes_layer_plus,
      CottonTears:            log.cotton_tears,
      MissingSticks:          log.missing_sticks,
      FoultyPickups:          log.faulty_pickups,
      OtherErrors:            log.other_errors,
      Efficiency:             log.efficiency,
      Reject:                 log.reject_rate,
    };
  };

  // Total across all shifts that have data
  const totalData = (): ShiftDataMessage | undefined => {
    const slots = [1, 2, 3].map(shiftData).filter((s): s is ShiftDataMessage => !!s);
    if (slots.length === 0) return undefined;
    const sum = slots.reduce((acc, s) => ({
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
    const totalTime = sum.ProductionTime + sum.IdleTime;
    sum.Efficiency = totalTime > 0 ? (sum.ProductionTime / totalTime) * 100 : 0;
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
      case "percent": return `${(val as number).toFixed(1)}%`;
      default:        return (val as number).toLocaleString();
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
            Machine Monitor — <span className="text-cyan-400">{machineName}</span>
          </h2>
        </div>
        <span className="bg-cyan-900/30 text-cyan-400 text-xs px-3 py-1.5 rounded-full">
          Live Data
        </span>
      </div>

      {offline || !machine ? (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg px-6 py-12 flex flex-col items-center gap-3 text-center">
          <i className="bi bi-wifi-off text-4xl text-gray-600"></i>
          <p className="text-gray-300 font-medium">Machine Offline</p>
          <p className="text-gray-500 text-sm max-w-sm">
            <span className="text-cyan-400 font-mono">{machineName}</span> is not currently connected to the MQTT bridge. Live shift data will appear here automatically once the machine comes online.
          </p>
        </div>
      ) : (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
          {/* Card header */}
          <div className="bg-gray-700/60 border-b border-gray-600 px-5 py-3 flex justify-between items-center">
            <h4 className="text-white font-semibold"><span className="text-cyan-400">{machine.machine}</span> — Shift Data</h4>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
                {formatStatus(machine.machineStatus?.Status)}
              </span>
              <span className="bg-gray-700/50 text-gray-300 text-xs px-2.5 py-1 rounded-full">
                Last Request: {machine.lastRequestShift
                  ? new Date(machine.lastRequestShift).toLocaleTimeString("de-DE")
                  : "---"}
              </span>
            </div>
          </div>

          {/* Shift data table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-center text-gray-400 border-b border-gray-700">
                  <th className="px-4 py-3 text-left w-1/5 font-medium">Metric</th>
                  <th className={`px-4 py-3 font-medium ${activeShift === 1 ? "bg-cyan-600 text-white" : "text-cyan-400"}`}>
                    Shift 1
                  </th>
                  <th className={`px-4 py-3 font-medium ${activeShift === 2 ? "bg-cyan-600 text-white" : "text-cyan-400"}`}>
                    Shift 2
                  </th>
                  <th className={`px-4 py-3 font-medium ${activeShift === 3 ? "bg-cyan-600 text-white" : "text-cyan-400"}`}>
                    Shift 3
                  </th>
                  <th className="px-4 py-3 font-medium text-cyan-400">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700/50">
                {metrics.map((metric) => (
                  <tr key={metric.key} className="hover:bg-white/5">
                    <td className="px-4 py-2.5 font-medium text-gray-200">{metric.label}</td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(1)} ${cellColor(metric, shiftData(1))}`}>
                      {renderShiftValue(shiftData(1), metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(2)} ${cellColor(metric, shiftData(2))}`}>
                      {renderShiftValue(shiftData(2), metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(3)} ${cellColor(metric, shiftData(3))}`}>
                      {renderShiftValue(shiftData(3), metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${cellColor(metric, totalData())}`}>
                      {renderShiftValue(totalData(), metric.key, metric.format)}
                    </td>
                  </tr>
                ))}
                {/* Errors section separator */}
                <tr className="bg-gray-900/40">
                  <td colSpan={5} className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-t border-gray-600">
                    <i className="bi bi-exclamation-triangle mr-1.5"></i>Errors
                  </td>
                </tr>
                {errorMetrics.map((metric) => (
                  <tr key={metric.key} className="hover:bg-white/5 bg-gray-900/20">
                    <td className="px-4 py-2.5 font-medium text-gray-300">{metric.label}</td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(1)} ${cellColor(metric, shiftData(1))}`}>
                      {renderShiftValue(shiftData(1), metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(2)} ${cellColor(metric, shiftData(2))}`}>
                      {renderShiftValue(shiftData(2), metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(3)} ${cellColor(metric, shiftData(3))}`}>
                      {renderShiftValue(shiftData(3), metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${cellColor(metric, totalData())}`}>
                      {renderShiftValue(totalData(), metric.key, metric.format)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-gray-700 flex justify-between text-xs text-gray-500">
            <span>
              Last Update:{" "}
              {machine.lastSyncShift
                ? new Date(machine.lastSyncShift).toLocaleTimeString("de-DE")
                : "---"}
            </span>
            {machine.lastSyncShift && (
              <span className="text-green-400">
                <i className="bi bi-check-circle mr-1"></i> Data synchronized
              </span>
            )}
          </div>
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
