"use client";

import type { Machine } from "@/lib/supabase";
import MachineStatusBadge from "./MachineStatusBadge";

interface MachineSelectorProps {
  machines: Machine[];
  selectedId: string | null;
  onSelect: (machineId: string | null) => void;
}

export default function MachineSelector({
  machines,
  selectedId,
  onSelect,
}: MachineSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        onClick={() => onSelect(null)}
        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
          selectedId === null
            ? "bg-blue-600 text-white border-blue-600"
            : "bg-white text-slate-600 border-slate-300 hover:border-blue-400"
        }`}
      >
        All Machines
      </button>
      {machines.map((machine) => (
        <button
          key={machine.id}
          onClick={() => onSelect(machine.id)}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors flex items-center gap-2 ${
            selectedId === machine.id
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-slate-600 border-slate-300 hover:border-blue-400"
          }`}
        >
          {machine.name}
          {selectedId !== machine.id && (
            <MachineStatusBadge status={machine.status} />
          )}
        </button>
      ))}
    </div>
  );
}
