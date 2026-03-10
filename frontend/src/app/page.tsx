"use client";

import { useEffect, useState, useCallback } from "react";
import {
  supabase,
  getMachines,
  getLatestReadings,
  getActiveAlerts,
  acknowledgeAlert,
} from "@/lib/supabase";
import type { Machine, ProductionReading, Alert } from "@/lib/supabase";
import KpiCard from "@/components/KpiCard";
import MachineSelector from "@/components/MachineSelector";
import ProductionChart from "@/components/ProductionChart";
import AlertsPanel from "@/components/AlertsPanel";

export default function Dashboard() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [readings, setReadings] = useState<ProductionReading[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [machineData, readingData, alertData] = await Promise.all([
        getMachines(),
        getLatestReadings(selectedMachine || undefined, 100),
        getActiveAlerts(),
      ]);
      setMachines(machineData);
      setReadings(readingData);
      setAlerts(alertData);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedMachine]);

  useEffect(() => {
    fetchData();

    // Subscribe to real-time updates on production_readings
    const channel = supabase
      .channel("production-updates")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "production_readings" },
        () => {
          fetchData();
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "alerts" },
        () => {
          fetchData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchData]);

  const handleAcknowledge = async (alertId: string) => {
    await acknowledgeAlert(alertId, "operator");
    setAlerts((prev) => prev.filter((a) => a.id !== alertId));
  };

  // Calculate KPIs from latest readings
  const latestReading = readings[0];
  const totalProduced = readings.reduce(
    (sum, r) => sum + (r.produced_swabs || 0),
    0
  );
  const totalRejected = readings.reduce(
    (sum, r) => sum + (r.rejected_swabs || 0),
    0
  );
  const avgEfficiency =
    readings.length > 0
      ? readings.reduce((sum, r) => sum + (r.efficiency || 0), 0) /
        readings.filter((r) => r.efficiency != null).length
      : 0;
  const avgScrapRate =
    readings.length > 0
      ? readings.reduce((sum, r) => sum + (r.scrap_rate || 0), 0) /
        readings.filter((r) => r.scrap_rate != null).length
      : 0;
  const onlineMachines = machines.filter((m) => m.status === "online").length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-slate-400">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900">
            Production Dashboard
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Real-time monitoring of cotton swab production
          </p>
        </div>
        <div className="text-xs text-slate-400">
          {onlineMachines}/{machines.length} machines online
        </div>
      </div>

      {/* Machine selector */}
      <MachineSelector
        machines={machines}
        selectedId={selectedMachine}
        onSelect={setSelectedMachine}
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          title="Produced Swabs"
          value={totalProduced.toLocaleString()}
          color="default"
        />
        <KpiCard
          title="Avg Efficiency"
          value={`${(avgEfficiency * 100).toFixed(1)}%`}
          color={avgEfficiency >= 0.8 ? "success" : "warning"}
        />
        <KpiCard
          title="Scrap Rate"
          value={`${(avgScrapRate * 100).toFixed(2)}%`}
          color={avgScrapRate <= 0.05 ? "success" : "danger"}
        />
        <KpiCard
          title="Rejected Swabs"
          value={totalRejected.toLocaleString()}
          color={totalRejected === 0 ? "success" : "warning"}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProductionChart
          readings={readings}
          metric="efficiency"
          title="Efficiency Over Time"
          color="#16a34a"
          yAxisLabel="Efficiency"
        />
        <ProductionChart
          readings={readings}
          metric="produced_swabs"
          title="Swabs Produced"
          color="#2563eb"
          yAxisLabel="Count"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProductionChart
          readings={readings}
          metric="machine_speed"
          title="Machine Speed"
          color="#8b5cf6"
          yAxisLabel="Speed"
        />
        <ProductionChart
          readings={readings}
          metric="scrap_rate"
          title="Scrap Rate"
          color="#dc2626"
          yAxisLabel="Rate"
        />
      </div>

      {/* Alerts */}
      <AlertsPanel alerts={alerts} onAcknowledge={handleAcknowledge} />

      {/* Recent readings table */}
      <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-5 border-b border-slate-200">
          <h3 className="text-sm font-semibold text-slate-700">
            Recent Readings
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-3 text-left">Time</th>
                <th className="px-4 py-3 text-right">Speed</th>
                <th className="px-4 py-3 text-right">Produced</th>
                <th className="px-4 py-3 text-right">Packed</th>
                <th className="px-4 py-3 text-right">Rejected</th>
                <th className="px-4 py-3 text-right">Efficiency</th>
                <th className="px-4 py-3 text-right">Scrap</th>
                <th className="px-4 py-3 text-right">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {readings.slice(0, 20).map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 text-slate-600">
                    {new Date(r.recorded_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.machine_speed ?? "-"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.produced_swabs?.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.packed_swabs?.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.rejected_swabs}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.efficiency != null
                      ? `${(r.efficiency * 100).toFixed(1)}%`
                      : "-"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {r.scrap_rate != null
                      ? `${(r.scrap_rate * 100).toFixed(2)}%`
                      : "-"}
                  </td>
                  <td className="px-4 py-2.5 text-right">{r.error_stops}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
