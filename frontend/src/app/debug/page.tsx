"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchMachines, fetchHealth } from "@/lib/supabase";
import type { MachineData } from "@/lib/supabase";

export default function DebugPage() {
  const [machines, setMachines] = useState<Record<string, MachineData>>({});
  const [health, setHealth] = useState({ status: "unknown", mqttConnected: false, machineCount: 0 });

  const loadData = useCallback(async () => {
    try {
      const [state, h] = await Promise.all([fetchMachines(), fetchHealth()]);
      setMachines(state.machines);
      setHealth(h);
    } catch (err) {
      console.error("Debug fetch error:", err);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 3000);
    return () => clearInterval(interval);
  }, [loadData]);

  const renderShift = (label: string, shift: Record<string, unknown> | undefined) => {
    if (!shift) return (
      <div className="mb-2">
        <h6 className="text-gray-400 text-xs font-semibold">{label}:</h6>
        <pre className="text-gray-600 text-xs ml-2">null</pre>
      </div>
    );

    return (
      <div className="mb-2">
        <h6 className="text-gray-400 text-xs font-semibold">{label}:</h6>
        <pre className="text-gray-300 text-xs ml-2">
          Save Flag: {String((shift as Record<string, unknown>).Save ?? "undefined")}
          {"\n"}Shift: {String((shift as Record<string, unknown>).Shift ?? "undefined")}
          {"\n"}ProducedSwaps: {String((shift as Record<string, unknown>).ProducedSwaps ?? "undefined")}
          {"\n"}Efficiency: {String((shift as Record<string, unknown>).Efficiency ?? "undefined")}
        </pre>
      </div>
    );
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Debug Information</h2>
        <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full">Debug Mode</span>
      </div>

      {/* Bridge Health */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg mb-4 overflow-hidden">
        <div className="bg-cyan-600 px-5 py-3">
          <h4 className="text-white font-semibold">Bridge Health</h4>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-gray-400">API Status:</span>{" "}
              <span className={health.status === "ok" ? "text-green-400" : "text-red-400"}>{health.status}</span>
            </div>
            <div>
              <span className="text-gray-400">MQTT Connected:</span>{" "}
              <span className={health.mqttConnected ? "text-green-400" : "text-red-400"}>
                {health.mqttConnected ? "Yes" : "No"}
              </span>
            </div>
            <div>
              <span className="text-gray-400">Machines:</span>{" "}
              <span className="text-white">{health.machineCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Machine Data */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden mb-4">
        <div className="bg-yellow-600 px-5 py-3">
          <h4 className="text-gray-900 font-semibold">Current Machine Data</h4>
        </div>
        <div className="p-5">
          {Object.keys(machines).length === 0 ? (
            <p className="text-yellow-400 text-sm">No machine data received yet...</p>
          ) : (
            Object.values(machines).map((m) => (
              <div key={m.machine} className="mb-4 p-4 border border-gray-700 rounded-lg">
                <h5 className="text-cyan-400 font-semibold mb-3">Machine: {m.machine}</h5>
                {renderShift("Shift 1", m.shift1 as unknown as Record<string, unknown>)}
                {renderShift("Shift 2", m.shift2 as unknown as Record<string, unknown>)}
                {renderShift("Shift 3", m.shift3 as unknown as Record<string, unknown>)}
                {renderShift("Total", m.total as unknown as Record<string, unknown>)}
                <p className="text-xs text-gray-500 mt-3">
                  Last Sync: {m.lastSyncShift ? new Date(m.lastSyncShift).toLocaleString("de-DE") : "---"}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Instructions */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="bg-cyan-600 px-5 py-3">
          <h4 className="text-white font-semibold">Instructions</h4>
        </div>
        <div className="p-5 text-sm text-gray-300 space-y-2">
          <p>1. Check if the "Save Flag" shows <strong className="text-white">true</strong> for any shift</p>
          <p>2. If Save Flag is always <strong className="text-white">false</strong>, the MQTT message does not include Save=true</p>
          <p>3. Check the bridge logs (mqtt-bridge/logs/) for "Save flag received" messages</p>
          <p>4. CSV log files and Supabase saved_shift_logs will only be created when Save=true is received</p>
        </div>
      </div>
    </div>
  );
}
