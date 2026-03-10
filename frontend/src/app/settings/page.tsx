"use client";

import { useEffect, useState } from "react";
import { fetchBrokerSettings, fetchMachines } from "@/lib/supabase";
import type { MachineData } from "@/lib/supabase";

export default function SettingsPage() {
  const [brokerSettings, setBrokerSettings] = useState({
    host: "",
    port: 0,
    username: "",
    isLocal: false,
    subscribeTopic: "",
    publishTopicPrefix: "",
  });
  const [machines, setMachines] = useState<Record<string, MachineData>>({});
  const [enabledMachines, setEnabledMachines] = useState<string[]>([]);
  const [newMachineName, setNewMachineName] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  useEffect(() => {
    fetchBrokerSettings().then(setBrokerSettings).catch(console.error);
    fetchMachines()
      .then((state) => setMachines(state.machines))
      .catch(console.error);
  }, []);

  const addMachine = () => {
    if (newMachineName.trim() && !enabledMachines.includes(newMachineName.trim())) {
      setEnabledMachines([...enabledMachines, newMachineName.trim()]);
      setNewMachineName("");
    }
  };

  const removeMachine = (name: string) => {
    setEnabledMachines(enabledMachines.filter((m) => m !== name));
  };

  const addFromDiscovered = (name: string) => {
    if (!enabledMachines.includes(name)) {
      setEnabledMachines([...enabledMachines, name]);
    }
  };

  const discoveredNotEnabled = Object.keys(machines).filter(
    (m) => !enabledMachines.includes(m)
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full">
          Configuration
        </span>
      </div>

      {successMessage && (
        <div className="bg-green-900/30 border border-green-700 text-green-400 px-4 py-3 rounded-lg mb-4 flex justify-between items-center">
          <span><i className="bi bi-check-circle-fill mr-2"></i>{successMessage}</span>
          <button onClick={() => setSuccessMessage("")} className="text-green-400 hover:text-green-300">
            <i className="bi bi-x-lg"></i>
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Broker Settings (read-only from bridge) */}
        <div className="bg-gray-800/50 border border-red-700/50 rounded-lg overflow-hidden">
          <div className="bg-red-700 px-5 py-3">
            <h4 className="text-white font-semibold">
              <i className="bi bi-server mr-2"></i>MQTT Broker Settings
            </h4>
            <p className="text-red-200 text-xs">Configured via environment variables on the bridge service</p>
          </div>
          <div className="p-5 space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Host / IP Address</label>
              <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-300">
                {brokerSettings.host || "Loading..."}
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
            <div>
              <label className="block text-xs text-gray-400 mb-1">Subscribe Topic</label>
              <div className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm font-mono text-cyan-400">
                {brokerSettings.subscribeTopic || "---"}
              </div>
            </div>
          </div>
        </div>

        {/* Machine Configuration */}
        <div className="bg-gray-800/50 border border-yellow-700/50 rounded-lg overflow-hidden">
          <div className="bg-yellow-600 px-5 py-3">
            <h4 className="text-gray-900 font-semibold">
              <i className="bi bi-gear-fill mr-2"></i>Machine Configuration
            </h4>
          </div>
          <div className="p-5 space-y-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Add New Machine</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMachineName}
                  onChange={(e) => setNewMachineName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addMachine()}
                  placeholder="Machine name..."
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-blue-500 outline-none"
                />
                <button onClick={addMachine} className="bg-green-600 hover:bg-green-700 text-white px-3 py-2 rounded text-sm transition-colors">
                  <i className="bi bi-plus-circle mr-1"></i> Add
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Enabled Machines ({enabledMachines.length})
              </label>
              <div className="max-h-48 overflow-y-auto border border-gray-700 rounded p-2 space-y-1">
                {enabledMachines.length === 0 ? (
                  <div className="text-xs text-cyan-400 p-2">
                    <i className="bi bi-info-circle mr-1"></i>
                    No machines configured. All discovered machines will be shown.
                  </div>
                ) : (
                  enabledMachines.sort().map((name) => (
                    <div key={name} className="flex justify-between items-center bg-gray-700/50 px-3 py-2 rounded">
                      <span className="text-sm text-white">
                        <i className="bi bi-cpu mr-1"></i> {name}
                      </span>
                      <button onClick={() => removeMachine(name)} className="text-red-400 hover:text-red-300 text-xs">
                        <i className="bi bi-trash"></i> Delete
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <button
              onClick={() => setSuccessMessage("Machine configuration saved!")}
              className="w-full bg-yellow-600 hover:bg-yellow-700 text-gray-900 font-medium py-2 rounded text-sm transition-colors"
            >
              <i className="bi bi-save mr-1"></i> Save Machine Configuration
            </button>
          </div>
        </div>
      </div>

      {/* Discovered Machines */}
      <div className="bg-gray-800/50 border border-cyan-700/50 rounded-lg overflow-hidden">
        <div className="bg-cyan-600 px-5 py-3">
          <h4 className="text-white font-semibold">
            <i className="bi bi-broadcast mr-2"></i>Discovered Machines
          </h4>
          <p className="text-cyan-100 text-xs">Machines currently connected via MQTT</p>
        </div>
        <div className="p-5">
          {discoveredNotEnabled.length === 0 && Object.keys(machines).length === 0 ? (
            <div className="text-yellow-400 text-sm">
              <i className="bi bi-exclamation-triangle mr-1"></i>
              No machines discovered yet. Waiting for MQTT data...
            </div>
          ) : discoveredNotEnabled.length === 0 ? (
            <div className="text-gray-400 text-sm">All discovered machines are already enabled.</div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {discoveredNotEnabled.map((name) => (
                <div key={name} className="bg-gray-700/50 rounded px-3 py-2 flex justify-between items-center">
                  <span className="text-sm text-white">
                    <i className="bi bi-cpu mr-1"></i> {name}
                  </span>
                  <button onClick={() => addFromDiscovered(name)} className="text-green-400 hover:text-green-300 text-xs">
                    <i className="bi bi-plus-circle"></i> Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
