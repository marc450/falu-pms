"use client";

import { useEffect, useState } from "react";
import { getMachines } from "@/lib/supabase";
import type { Machine } from "@/lib/supabase";
import MachineStatusBadge from "@/components/MachineStatusBadge";

export default function MachinesPage() {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMachines()
      .then(setMachines)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-slate-400">Loading machines...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Machines</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Overview of all registered production machines
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {machines.map((machine) => (
          <div
            key={machine.id}
            className="bg-white rounded-lg shadow-sm border border-slate-200 p-5"
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-slate-900">{machine.name}</h3>
                <p className="text-xs text-slate-400 font-mono">
                  {machine.machine_code}
                </p>
              </div>
              <MachineStatusBadge status={machine.status} />
            </div>
            {machine.location && (
              <p className="text-sm text-slate-500">
                Location: {machine.location}
              </p>
            )}
            {machine.line && (
              <p className="text-sm text-slate-500">Line: {machine.line}</p>
            )}
            <p className="text-xs text-slate-400 mt-3">
              Last updated: {new Date(machine.updated_at).toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {machines.length === 0 && (
        <div className="text-center py-12 text-slate-400">
          <p>No machines registered yet.</p>
          <p className="text-sm mt-1">
            Machines are auto-registered when the MQTT bridge receives data.
          </p>
        </div>
      )}
    </div>
  );
}
