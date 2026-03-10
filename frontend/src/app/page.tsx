"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { fetchMachines } from "@/lib/supabase";
import type { MachineData } from "@/lib/supabase";
import { getStatusColor } from "@/lib/utils";

type SortColumn = "Machine" | "Status" | "Speed" | "Swaps" | "Boxes" | "Efficiency" | "Reject" | "LastSync";

export default function Dashboard() {
  const [machines, setMachines] = useState<Record<string, MachineData>>({});
  const [mqttConnected, setMqttConnected] = useState(false);
  const [sortColumn, setSortColumn] = useState<SortColumn>("Machine");
  const [sortAsc, setSortAsc] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());
  const router = useRouter();

  const loadData = useCallback(async () => {
    try {
      const state = await fetchMachines();
      setMachines(state.machines);
      setMqttConnected(state.mqttConnected);
    } catch (err) {
      console.error("Failed to fetch machines:", err);
    }
  }, []);

  useEffect(() => {
    loadData();
    const dataInterval = setInterval(loadData, 2000);
    const clockInterval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => {
      clearInterval(dataInterval);
      clearInterval(clockInterval);
    };
  }, [loadData]);

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortColumn(col);
      setSortAsc(true);
    }
  };

  const sortedMachines = Object.values(machines).sort((a, b) => {
    let aVal: string | number = 0;
    let bVal: string | number = 0;

    switch (sortColumn) {
      case "Machine": aVal = a.machine; bVal = b.machine; break;
      case "Status": aVal = a.machineStatus?.Status || "zzz"; bVal = b.machineStatus?.Status || "zzz"; break;
      case "Speed": aVal = a.machineStatus?.Speed || 0; bVal = b.machineStatus?.Speed || 0; break;
      case "Swaps": aVal = a.machineStatus?.Swaps || 0; bVal = b.machineStatus?.Swaps || 0; break;
      case "Boxes": aVal = a.machineStatus?.Boxes || 0; bVal = b.machineStatus?.Boxes || 0; break;
      case "Efficiency": aVal = a.machineStatus?.Efficiency || 0; bVal = b.machineStatus?.Efficiency || 0; break;
      case "Reject": aVal = a.machineStatus?.Reject || 0; bVal = b.machineStatus?.Reject || 0; break;
      case "LastSync":
        aVal = a.lastSyncStatus ? new Date(a.lastSyncStatus).getTime() : 0;
        bVal = b.lastSyncStatus ? new Date(b.lastSyncStatus).getTime() : 0;
        break;
    }

    if (typeof aVal === "string") {
      return sortAsc ? aVal.localeCompare(bVal as string) : (bVal as string).localeCompare(aVal);
    }
    return sortAsc ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });

  const machineCount = Object.keys(machines).length;
  const hasData = machineCount > 0;

  const SortHeader = ({ col, label, className }: { col: SortColumn; label: string; className?: string }) => (
    <th
      onClick={() => handleSort(col)}
      className={`px-4 py-3 text-left text-sm font-medium cursor-pointer select-none transition-colors hover:text-cyan-400 hover:bg-cyan-900/10 ${
        sortColumn === col ? "sort-active text-white" : "text-gray-400"
      } ${className || ""}`}
    >
      {label} {sortColumn === col ? (sortAsc ? "▲" : "▼") : ""}
    </th>
  );

  return (
    <div>
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Machine Park Live Status</h2>
        <div className="flex gap-2">
          <span className="bg-gray-700 text-gray-300 text-xs px-3 py-1.5 rounded-full">
            <i className="bi bi-calendar3 mr-1"></i>
            {currentTime.toLocaleString("de-DE")}
          </span>
          {!hasData ? (
            <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse"></span>
              Waiting for MQTT data...
            </span>
          ) : (
            <span
              className={`text-xs px-3 py-1.5 rounded-full flex items-center gap-1 ${
                mqttConnected ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"
              }`}
            >
              <i className={`bi bi-${mqttConnected ? "wifi" : "wifi-off"}`}></i>
              {machineCount} Machines online
              {!mqttConnected && <span className="ml-1">(Reconnecting...)</span>}
            </span>
          )}
        </div>
      </div>

      {/* Machine Table */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-800">
              <tr>
                <SortHeader col="Machine" label="Machine" />
                <SortHeader col="Status" label="Status" />
                <SortHeader col="Speed" label="Speed" />
                <SortHeader col="Swaps" label="Total Swabs" />
                <SortHeader col="Boxes" label="Blisters" />
                <SortHeader col="Efficiency" label="Efficiency" />
                <SortHeader col="Reject" label="Scrap Rate" />
                <SortHeader col="LastSync" label="Last Sync" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {sortedMachines.map((m) => {
                const status = getStatusColor(m.machineStatus?.Status);
                return (
                  <tr
                    key={m.machine}
                    onClick={() => router.push(`/production?machine=${m.machine}`)}
                    className="cursor-pointer hover:bg-white/5 transition-colors"
                  >
                    <td className="px-4 py-3 font-bold text-cyan-400">{m.machine}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
                        {m.machineStatus?.Status || "offline"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {m.machineStatus?.Speed ? (
                        <>{m.machineStatus.Speed} <span className="text-gray-500 text-xs">pcs/m</span></>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {m.machineStatus?.Swaps ? m.machineStatus.Swaps.toLocaleString() : ""}
                    </td>
                    <td className="px-4 py-3">
                      {m.machineStatus?.Boxes ? m.machineStatus.Boxes.toLocaleString() : ""}
                    </td>
                    <td className="px-4 py-3">
                      {m.machineStatus?.Efficiency ? `${m.machineStatus.Efficiency.toFixed(1)}%` : ""}
                    </td>
                    <td className={`px-4 py-3 ${(m.machineStatus?.Reject || 0) > 5 ? "text-red-400" : ""}`}>
                      {m.machineStatus?.Reject ? `${m.machineStatus.Reject.toFixed(1)}%` : ""}
                    </td>
                    <td className="px-4 py-3 text-gray-400">
                      {m.lastSyncStatus
                        ? new Date(m.lastSyncStatus).toLocaleTimeString("de-DE")
                        : <span className="text-gray-600">---</span>}
                    </td>
                  </tr>
                );
              })}
              {sortedMachines.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-500">
                    No machines connected. Start the MQTT bridge and simulator to see data.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
