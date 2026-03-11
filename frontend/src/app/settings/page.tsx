"use client";

import { useEffect, useState, useRef } from "react";
import {
  fetchBrokerSettings,
  fetchRegisteredMachines,
  fetchProductionCells,
  createProductionCell,
  renameProductionCell,
  deleteProductionCell,
  assignMachineToCell,
} from "@/lib/supabase";
import type { RegisteredMachine, ProductionCell } from "@/lib/supabase";

type Tab = "users" | "machines" | "mqtt";

// ─────────────────────────────────────────────────────────────
// Machines tab — production cell management with drag-and-drop
// ─────────────────────────────────────────────────────────────
function MachinesTab() {
  const [machines, setMachines] = useState<RegisteredMachine[]>([]);
  const [cells, setCells] = useState<ProductionCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [draggedMachine, setDraggedMachine] = useState<string | null>(null);
  const [dragOverCell, setDragOverCell] = useState<string | "unassigned" | null>(null);
  const [renamingCell, setRenamingCell] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const [m, c] = await Promise.all([fetchRegisteredMachines(), fetchProductionCells()]);
    setMachines(m);
    setCells(c);
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    if (renamingCell && renameInputRef.current) renameInputRef.current.focus();
  }, [renamingCell]);

  const handleAddCell = async () => {
    const name = `Cell ${cells.length + 1}`;
    await createProductionCell(name, cells.length);
    await reload();
  };

  const handleDeleteCell = async (id: string) => {
    if (!confirm("Delete this cell? Machines inside will become unassigned.")) return;
    await deleteProductionCell(id);
    await reload();
  };

  const startRename = (cell: ProductionCell) => {
    setRenamingCell(cell.id);
    setRenameValue(cell.name);
  };

  const commitRename = async (id: string) => {
    if (renameValue.trim()) await renameProductionCell(id, renameValue.trim());
    setRenamingCell(null);
    await reload();
  };

  // ── Drag handlers ────────────────────────────────────────────
  const onDragStart = (machineCode: string) => setDraggedMachine(machineCode);
  const onDragEnd = () => { setDraggedMachine(null); setDragOverCell(null); };

  const onDrop = async (cellId: string | null) => {
    if (!draggedMachine) return;
    await assignMachineToCell(draggedMachine, cellId);
    setDraggedMachine(null);
    setDragOverCell(null);
    await reload();
  };

  const machinesInCell = (cellId: string) => machines.filter((m) => m.cell_id === cellId);
  const unassigned = machines.filter((m) => !m.cell_id);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 py-8">
        <span className="animate-spin text-lg">⟳</span> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Add cell button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          Drag machines into cells to organise your production floor.
        </p>
        <button
          onClick={handleAddCell}
          className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white text-sm px-4 py-2 rounded-lg transition-colors"
        >
          <i className="bi bi-plus-circle"></i> Add Production Cell
        </button>
      </div>

      {/* Production cells */}
      {cells.length === 0 && (
        <div className="bg-gray-800/50 border border-dashed border-gray-600 rounded-lg p-8 text-center text-gray-500 text-sm">
          No production cells yet. Click <strong className="text-gray-400">Add Production Cell</strong> to create one.
        </div>
      )}

      {cells.map((cell) => {
        const cellMachines = machinesInCell(cell.id);
        const isOver = dragOverCell === cell.id;
        return (
          <div
            key={cell.id}
            className={`rounded-lg border overflow-hidden transition-colors ${
              isOver ? "border-cyan-500 bg-cyan-900/10" : "border-gray-700 bg-gray-800/50"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOverCell(cell.id); }}
            onDragLeave={() => setDragOverCell(null)}
            onDrop={() => onDrop(cell.id)}
          >
            {/* Cell header */}
            <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700">
              {renamingCell === cell.id ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(cell.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(cell.id);
                    if (e.key === "Escape") setRenamingCell(null);
                  }}
                  className="bg-gray-700 text-white text-sm font-semibold px-2 py-0.5 rounded border border-cyan-500 outline-none w-48"
                />
              ) : (
                <h4 className="text-white font-semibold text-sm flex items-center gap-2">
                  <i className="bi bi-collection text-cyan-400"></i>
                  {cell.name}
                  <span className="text-gray-500 font-normal text-xs">{cellMachines.length} machine{cellMachines.length !== 1 ? "s" : ""}</span>
                </h4>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startRename(cell)}
                  className="text-gray-400 hover:text-white text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                >
                  <i className="bi bi-pencil"></i> Rename
                </button>
                <button
                  onClick={() => handleDeleteCell(cell.id)}
                  className="text-gray-400 hover:text-red-400 text-xs px-2 py-1 rounded hover:bg-gray-700 transition-colors"
                >
                  <i className="bi bi-trash"></i> Delete
                </button>
              </div>
            </div>

            {/* Drop zone */}
            <div className="p-3 min-h-[72px] flex flex-wrap gap-2 items-start">
              {cellMachines.length === 0 && !isOver && (
                <div className="flex items-center justify-center w-full text-gray-600 text-xs select-none">
                  <i className="bi bi-arrow-down-circle mr-1.5"></i> Drop machines here
                </div>
              )}
              {cellMachines.map((m) => (
                <MachineChip
                  key={m.machine_code}
                  code={m.machine_code}
                  isDragging={draggedMachine === m.machine_code}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                />
              ))}
              {isOver && draggedMachine && !cellMachines.find((m) => m.machine_code === draggedMachine) && (
                <MachineChip code={draggedMachine} ghost />
              )}
            </div>
          </div>
        );
      })}

      {/* Unassigned pool */}
      <div
        className={`rounded-lg border overflow-hidden transition-colors ${
          dragOverCell === "unassigned" ? "border-gray-500 bg-gray-700/20" : "border-gray-700/50 bg-gray-800/30"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOverCell("unassigned"); }}
        onDragLeave={() => setDragOverCell(null)}
        onDrop={() => onDrop(null)}
      >
        <div className="flex items-center justify-between px-4 py-3 bg-gray-800/60 border-b border-gray-700/50">
          <h4 className="text-gray-400 font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-inbox text-gray-500"></i>
            Unassigned Machines
            <span className="text-gray-600 font-normal text-xs">{unassigned.length} machine{unassigned.length !== 1 ? "s" : ""}</span>
          </h4>
        </div>
        <div className="p-3 min-h-[72px] flex flex-wrap gap-2 items-start">
          {unassigned.length === 0 && dragOverCell !== "unassigned" && (
            <div className="flex items-center justify-center w-full text-gray-700 text-xs select-none">
              All machines assigned
            </div>
          )}
          {unassigned.map((m) => (
            <MachineChip
              key={m.machine_code}
              code={m.machine_code}
              isDragging={draggedMachine === m.machine_code}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))}
          {dragOverCell === "unassigned" && draggedMachine && !unassigned.find((m) => m.machine_code === draggedMachine) && (
            <MachineChip code={draggedMachine} ghost />
          )}
        </div>
      </div>
    </div>
  );
}

// Draggable machine chip
function MachineChip({
  code,
  isDragging,
  ghost,
  onDragStart,
  onDragEnd,
}: {
  code: string;
  isDragging?: boolean;
  ghost?: boolean;
  onDragStart?: (code: string) => void;
  onDragEnd?: () => void;
}) {
  return (
    <div
      draggable={!ghost}
      onDragStart={() => onDragStart?.(code)}
      onDragEnd={onDragEnd}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium select-none transition-all ${
        ghost
          ? "border-2 border-dashed border-cyan-600 text-cyan-600 bg-cyan-900/10 opacity-60 cursor-copy"
          : isDragging
          ? "opacity-30 cursor-grabbing bg-gray-600 text-gray-400 border border-gray-500"
          : "bg-gray-700 text-white border border-gray-600 cursor-grab hover:border-cyan-500 hover:bg-gray-600 active:cursor-grabbing"
      }`}
    >
      {!ghost && <i className="bi bi-grip-vertical text-gray-400 text-xs"></i>}
      <i className="bi bi-cpu text-cyan-400 text-xs"></i>
      {code}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main settings page
// ─────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("machines");
  const [brokerSettings, setBrokerSettings] = useState({
    host: "",
    port: 0,
    username: "",
    isLocal: false,
    subscribeTopic: "",
    publishTopicPrefix: "",
  });

  useEffect(() => {
    fetchBrokerSettings().then(setBrokerSettings).catch(console.error);
  }, []);

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "users",    label: "Users",    icon: "bi-people-fill" },
    { id: "machines", label: "Machines", icon: "bi-cpu-fill" },
    { id: "mqtt",     label: "MQTT",     icon: "bi-router-fill" },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <span className="bg-yellow-600/20 text-yellow-400 text-xs px-3 py-1.5 rounded-full">
          Configuration
        </span>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 bg-gray-800/60 p-1 rounded-lg w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-5 py-2 rounded-md text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-gray-700 text-white shadow"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            <i className={`bi ${tab.icon}`}></i>
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── USERS ── */}
      {activeTab === "users" && (
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
          <div className="bg-gray-700 px-5 py-3">
            <h4 className="text-white font-semibold">
              <i className="bi bi-people-fill mr-2"></i>Users
            </h4>
            <p className="text-gray-300 text-xs">Manage who has access to this dashboard</p>
          </div>
          <div className="p-10 flex flex-col items-center justify-center text-center text-gray-500">
            <i className="bi bi-people text-5xl mb-3 opacity-30"></i>
            <p className="text-sm">User management coming soon.</p>
            <p className="text-xs mt-1">For now, create and manage users directly in Supabase.</p>
          </div>
        </div>
      )}

      {/* ── MACHINES ── */}
      {activeTab === "machines" && <MachinesTab />}

      {/* ── MQTT ── */}
      {activeTab === "mqtt" && (
        <div className="bg-gray-800/50 border border-red-700/50 rounded-lg overflow-hidden">
          <div className="bg-red-700 px-5 py-3">
            <h4 className="text-white font-semibold">
              <i className="bi bi-router-fill mr-2"></i>MQTT Broker Settings
            </h4>
            <p className="text-red-200 text-xs">
              Configured via environment variables on the bridge service
            </p>
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
      )}
    </div>
  );
}
