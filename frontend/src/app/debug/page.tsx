"use client";

import { useEffect, useState, useCallback } from "react";
import { fetchMachines, fetchHealth, fetchRegisteredMachines, getSupabase } from "@/lib/supabase";
import type { MachineData } from "@/lib/supabase";

export default function DebugPage() {
  const [machines, setMachines] = useState<Record<string, MachineData>>({});
  const [health, setHealth] = useState({ status: "unknown", mqttConnected: false, machineCount: 0 });

  // Supabase diagnostics
  const [supabaseUrl, setSupabaseUrl] = useState<string>("");
  const [sessionStatus, setSessionStatus] = useState<string>("checking...");
  const [dbQueryResult, setDbQueryResult] = useState<string>("not run");
  const [dbRowCount, setDbRowCount] = useState<number | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [state, h] = await Promise.all([fetchMachines(), fetchHealth()]);
      setMachines(state.machines);
      setHealth(h);
    } catch (err) {
      console.error("Debug fetch error:", err);
    }
  }, []);

  // Run Supabase diagnostics once on mount
  useEffect(() => {
    async function runDiagnostics() {
      try {
        const sb = getSupabase();

        // Show URL (partially)
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "(not set)";
        setSupabaseUrl(url.replace(/https?:\/\//, "").substring(0, 30) + "...");

        // Check session
        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        if (sessionError) {
          setSessionStatus(`Error: ${sessionError.message}`);
        } else if (session) {
          setSessionStatus(`Authenticated as ${session.user.email} (role: ${session.user.role ?? "authenticated"})`);
        } else {
          setSessionStatus("No active session");
        }

        // Direct machines query
        const { data, error } = await sb.from("machines").select("machine_code");
        if (error) {
          setDbQueryResult(`Error: ${error.message} (code: ${error.code})`);
        } else {
          setDbRowCount(data?.length ?? 0);
          setDbQueryResult(`OK — returned ${data?.length ?? 0} rows`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setDbQueryResult(`Exception: ${msg}`);
        setSessionStatus("Exception during diagnostics");
      }
    }

    runDiagnostics();
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

  const statusColor = (s: string) =>
    s.startsWith("OK") ? "text-green-400" :
    s.startsWith("Error") || s.startsWith("Exception") || s === "No active session" ? "text-red-400" :
    "text-yellow-400";

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Debug Information</h2>
        <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full">Debug Mode</span>
      </div>

      {/* Supabase Diagnostics */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg mb-4 overflow-hidden">
        <div className="bg-purple-700 px-5 py-3">
          <h4 className="text-white font-semibold">Supabase Diagnostics</h4>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div className="flex gap-2">
            <span className="text-gray-400 w-36 shrink-0">Supabase URL:</span>
            <span className="text-gray-200 font-mono text-xs">{supabaseUrl}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-400 w-36 shrink-0">Auth Session:</span>
            <span className={`font-mono text-xs ${statusColor(sessionStatus)}`}>{sessionStatus}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-gray-400 w-36 shrink-0">Machines Query:</span>
            <span className={`font-mono text-xs ${statusColor(dbQueryResult)}`}>{dbQueryResult}</span>
          </div>
          {dbRowCount !== null && dbRowCount === 0 && (
            <div className="bg-yellow-900/30 border border-yellow-700/50 text-yellow-400 text-xs rounded px-3 py-2 mt-2">
              Query returned 0 rows. Either the machines table is empty, or the RLS policy is blocking reads for this user.
            </div>
          )}
        </div>
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
              <span className="text-gray-400">Machines (bridge):</span>{" "}
              <span className="text-white">{health.machineCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Machine Data */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden mb-4">
        <div className="bg-yellow-600 px-5 py-3">
          <h4 className="text-gray-900 font-semibold">Current Machine Data (Bridge)</h4>
        </div>
        <div className="p-5">
          {Object.keys(machines).length === 0 ? (
            <p className="text-yellow-400 text-sm">No machine data from bridge.</p>
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
    </div>
  );
}
