"use client";

import { useEffect, useState } from "react";
import { fetchBrokerSettings, fetchRegisteredMachines } from "@/lib/supabase";
import type { RegisteredMachine } from "@/lib/supabase";

export default function SettingsPage() {
  const [brokerSettings, setBrokerSettings] = useState({
    host: "",
    port: 0,
    username: "",
    isLocal: false,
    subscribeTopic: "",
    publishTopicPrefix: "",
  });
  const [machines, setMachines] = useState<RegisteredMachine[]>([]);

  useEffect(() => {
    fetchBrokerSettings().then(setBrokerSettings).catch(console.error);
    fetchRegisteredMachines().then(setMachines).catch(console.error);
  }, []);

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full">
          Configuration
        </span>
      </div>

      {/* Broker Settings (read-only from bridge) */}
      <div className="bg-gray-800/50 border border-red-700/50 rounded-lg overflow-hidden mb-6">
        <div className="bg-red-700 px-5 py-3">
          <h4 className="text-white font-semibold">
            <i className="bi bi-server mr-2"></i>MQTT Broker Settings
          </h4>
          <p className="text-red-200 text-xs">Configured via environment variables on the bridge service</p>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Host / IP Address</label>
            <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
              {brokerSettings.host || "---"}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Port</label>
            <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
              {brokerSettings.port || "---"}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Username</label>
            <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
              {brokerSettings.username || "---"}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Instance Type</label>
            <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
              {brokerSettings.isLocal ? "Local (plain TCP)" : "Cloud (TLS)"}
            </div>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-gray-400 mb-1">Subscribe Topic</label>
            <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-cyan-400">
              {brokerSettings.subscribeTopic || "---"}
            </div>
          </div>
        </div>
      </div>

      {/* Registered Machines */}
      <div className="bg-gray-800/50 border border-cyan-700/50 rounded-lg overflow-hidden">
        <div className="bg-cyan-600 px-5 py-3">
          <h4 className="text-white font-semibold">
            <i className="bi bi-database mr-2"></i>Registered Machines
          </h4>
          <p className="text-cyan-100 text-xs">All machines registered in the database — manage entries directly in Supabase</p>
        </div>
        <div className="p-5">
          {machines.length === 0 ? (
            <div className="text-yellow-400 text-sm">
              <i className="bi bi-exclamation-triangle mr-1"></i>
              No machines registered in the database yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {machines.map((m) => (
                <div key={m.machine_code} className="bg-gray-700/50 rounded px-3 py-2">
                  <div className="flex items-center gap-2">
                    <i className="bi bi-cpu text-cyan-400"></i>
                    <span className="text-sm text-white font-medium">{m.machine_code}</span>
                  </div>
                  {m.status && (
                    <div className="text-xs text-gray-400 mt-1 capitalize">{m.status}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
