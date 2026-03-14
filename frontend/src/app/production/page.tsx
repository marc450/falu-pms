"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { fetchMachine, requestShiftData } from "@/lib/supabase";
import type { MachineData, ShiftDataMessage } from "@/lib/supabase";
import { formatMinutesToTime, getStatusColor, formatStatus } from "@/lib/utils";

function ProductionContent() {
  const searchParams = useSearchParams();
  const machineName = searchParams.get("machine") || "";
  const [machine, setMachine] = useState<MachineData | null>(null);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const loadData = useCallback(async () => {
    if (!machineName) return;
    try {
      const data = await fetchMachine(machineName);
      setMachine(data);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [machineName]);

  useEffect(() => {
    if (!machineName) {
      setLoading(false);
      return;
    }

    loadData();

    // Send initial request for all shift data
    requestShiftData(machineName, 0);

    // Poll every 2 seconds for live updates
    const dataInterval = setInterval(loadData, 2000);

    // Request shift data every 10 seconds
    const requestInterval = setInterval(() => {
      const currentShift = machine?.machineStatus?.ActShift || 0;
      requestShiftData(machineName, currentShift);
    }, 10000);

    return () => {
      clearInterval(dataInterval);
      clearInterval(requestInterval);
    };
  }, [machineName, loadData, machine?.machineStatus?.ActShift]);

  const status = getStatusColor(machine?.machineStatus?.Status);
  const activeShift = machine?.machineStatus?.ActShift || 0;

  const shiftCellClass = (shiftNum: number) =>
    activeShift === shiftNum ? "font-bold bg-cyan-900/20" : "";

  const renderShiftValue = (
    shift: ShiftDataMessage | undefined,
    key: keyof ShiftDataMessage,
    format?: "time" | "percent" | "number"
  ) => {
    if (!shift) return <span className="text-gray-600">---</span>;
    const val = shift[key];
    if (val === undefined || val === null) return <span className="text-gray-600">---</span>;

    switch (format) {
      case "time":
        return formatMinutesToTime(val as number);
      case "percent":
        return `${(val as number).toFixed(1)}%`;
      default:
        return (val as number).toLocaleString();
    }
  };

  const metrics: {
    label: string;
    key: keyof ShiftDataMessage;
    format?: "time" | "percent" | "number";
    warnFn?: (val: number) => boolean;
    dangerClass?: string;
  }[] = [
    { label: "Production Time", key: "ProductionTime", format: "time" },
    { label: "Idle Time", key: "IdleTime", format: "time" },
    { label: "Cotton Tears", key: "CottonTears", warnFn: (v) => v > 5, dangerClass: "text-yellow-400" },
    { label: "Missing Sticks", key: "MissingSticks" },
    { label: "Faulty Pickups", key: "FoultyPickups" },
    { label: "Other Errors", key: "OtherErrors" },
    { label: "Produced Swabs", key: "ProducedSwabs" },
    { label: "Packaged Swabs", key: "PackagedSwabs" },
    { label: "Produced Boxes", key: "ProducedBoxes" },
    { label: "Produced Boxes Layer+", key: "ProducedBoxesLayerPlus" },
    { label: "Discarded Swabs", key: "DiscardedSwabs" },
    { label: "Efficiency", key: "Efficiency", format: "percent" },
    { label: "Reject", key: "Reject", format: "percent", dangerClass: "text-red-400" },
  ];

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
            Production Details — {machineName}
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
          <div className="bg-blue-600 px-5 py-3 flex justify-between items-center">
            <h4 className="text-white font-semibold">Machine: {machine.machine}</h4>
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
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(1)} ${metric.dangerClass || ""}`}>
                      {renderShiftValue(machine.shift1, metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(2)} ${metric.dangerClass || ""}`}>
                      {renderShiftValue(machine.shift2, metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${shiftCellClass(3)} ${metric.dangerClass || ""}`}>
                      {renderShiftValue(machine.shift3, metric.key, metric.format)}
                    </td>
                    <td className={`px-4 py-2.5 text-center ${metric.dangerClass || ""}`}>
                      {renderShiftValue(machine.total, metric.key, metric.format)}
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
