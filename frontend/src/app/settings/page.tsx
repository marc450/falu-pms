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
  updateCellOrder,
  updateMachinePackingFormat,
  fetchThresholds,
  saveThresholds,
  DEFAULT_THRESHOLDS,
  PACKING_FORMATS,
} from "@/lib/supabase";
import type { RegisteredMachine, ProductionCell, Thresholds, PackingFormat } from "@/lib/supabase";

type DropTarget = {
  cellId: string | null;      // destination cell (null = unassigned)
  beforeCode: string | null;  // insert before this machine (null = append to end)
};

type Tab = "users" | "machines" | "thresholds" | "mqtt";

// ─────────────────────────────────────────────────────────────
// Machines tab — production cell management with drag-and-drop
// ─────────────────────────────────────────────────────────────
function MachinesTab() {
  const [machines, setMachines] = useState<RegisteredMachine[]>([]);
  const [cells, setCells] = useState<ProductionCell[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [renamingCell, setRenamingCell] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newCellName, setNewCellName] = useState("");
  const [addingCell, setAddingCell] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newCellInputRef = useRef<HTMLInputElement>(null);

  const reload = async (silent = false) => {
    const [m, c] = await Promise.all([fetchRegisteredMachines(), fetchProductionCells()]);
    setMachines(m);
    setCells(c);
    if (!silent) setLoading(false);
  };

  useEffect(() => { reload(); }, []);
  useEffect(() => { if (renamingCell) renameInputRef.current?.focus(); }, [renamingCell]);
  useEffect(() => { if (addingCell) newCellInputRef.current?.focus(); }, [addingCell]);

  const machinesInCell = (cellId: string) =>
    machines
      .filter((m) => m.cell_id === cellId)
      .sort((a, b) => (a.cell_position ?? 0) - (b.cell_position ?? 0));

  const unassigned = machines
    .filter((m) => !m.cell_id)
    .sort((a, b) => a.machine_code.localeCompare(b.machine_code));

  // ── Optimistic drop handler ───────────────────────────────────
  const handleDrop = async (e: React.DragEvent, targetCellId: string | null, beforeCode: string | null) => {
    e.preventDefault();
    if (!dragging) return;

    const machine = machines.find((m) => m.machine_code === dragging);
    if (!machine) return;
    const sourceCellId = machine.cell_id;

    // Build new ordered list for target cell (exclude dragged machine)
    const targetList = (targetCellId === null
      ? machines.filter((m) => !m.cell_id)
      : machines.filter((m) => m.cell_id === targetCellId)
    )
      .filter((m) => m.machine_code !== dragging)
      .sort((a, b) => (a.cell_position ?? 0) - (b.cell_position ?? 0));

    const insertIdx = beforeCode
      ? targetList.findIndex((m) => m.machine_code === beforeCode)
      : targetList.length;
    const idx = insertIdx === -1 ? targetList.length : insertIdx;

    const newTargetList = [
      ...targetList.slice(0, idx),
      { ...machine, cell_id: targetCellId, cell_position: idx },
      ...targetList.slice(idx),
    ].map((m, i) => ({ ...m, cell_position: i }));

    // Recompute source cell positions if moving to a different cell
    const newSourceList = sourceCellId !== targetCellId
      ? machines
          .filter((m) => m.cell_id === sourceCellId && m.machine_code !== dragging)
          .sort((a, b) => (a.cell_position ?? 0) - (b.cell_position ?? 0))
          .map((m, i) => ({ ...m, cell_position: i }))
      : [];

    // Build full new machine array
    const unchanged = machines.filter((m) =>
      m.machine_code !== dragging &&
      m.cell_id !== targetCellId &&
      m.cell_id !== sourceCellId
    );
    const newMachines = [...unchanged, ...newTargetList, ...newSourceList];

    // ── Apply immediately — no flicker ────────────────────────
    setMachines(newMachines);
    setDragging(null);
    setDropTarget(null);

    // ── Persist in background ─────────────────────────────────
    try {
      if (sourceCellId !== targetCellId) {
        await assignMachineToCell(dragging, targetCellId);
      }
      await updateCellOrder(newTargetList.map((m, i) => ({ code: m.machine_code, position: i })));
      if (sourceCellId !== targetCellId && newSourceList.length > 0) {
        await updateCellOrder(newSourceList.map((m, i) => ({ code: m.machine_code, position: i })));
      }
    } catch (err) {
      console.error("Failed to save order:", err);
      reload(true); // revert to server state on error
    }
  };

  const handleAddCell = async () => {
    if (!newCellName.trim()) return;
    await createProductionCell(newCellName.trim(), cells.length);
    setNewCellName("");
    setAddingCell(false);
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

  const handleFormatChange = async (code: string, format: PackingFormat | null) => {
    // Optimistic update
    setMachines((prev) =>
      prev.map((m) =>
        m.machine_code === code ? { ...m, packing_format: format } : m
      )
    );
    await updateMachinePackingFormat(code, format);
  };

  // Render chips with insertion-line indicators
  const renderChips = (chipList: RegisteredMachine[], cellId: string | null) => (
    <>
      {chipList.map((m) => (
        <div key={m.machine_code} className="flex items-center">
          {/* Blue insertion line: appears to the left of the chip when dragging over it */}
          {dropTarget?.cellId === cellId && dropTarget?.beforeCode === m.machine_code && (
            <div className="w-0.5 h-8 bg-cyan-400 rounded-full mr-1 shrink-0" />
          )}
          <MachineChip
            code={m.machine_code}
            packingFormat={m.packing_format}
            isDragging={dragging === m.machine_code}
            onFormatChange={(fmt) => handleFormatChange(m.machine_code, fmt)}
            onDragStart={() => setDragging(m.machine_code)}
            onDragEnd={() => { setDragging(null); setDropTarget(null); }}
            onChipDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setDropTarget({ cellId, beforeCode: m.machine_code });
            }}
          />
        </div>
      ))}
      {/* Append-to-end indicator: appears after last chip */}
      {dropTarget?.cellId === cellId && dropTarget?.beforeCode === null &&
       dragging && !chipList.find((m) => m.machine_code === dragging) && (
        <div className="w-0.5 h-8 bg-cyan-400 rounded-full ml-1 shrink-0" />
      )}
    </>
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 py-8">
        <span className="animate-spin text-lg">⟳</span> Loading…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          Drag machines into cells to organise your production floor.
        </p>
        {!addingCell && (
          <button
            onClick={() => setAddingCell(true)}
            className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 text-white text-sm px-4 py-2 rounded-lg transition-colors"
          >
            <i className="bi bi-plus-circle"></i> Add Production Cell
          </button>
        )}
      </div>

      {/* New cell name prompt */}
      {addingCell && (
        <div className="flex items-center gap-2 bg-gray-800/60 border border-cyan-600/50 rounded-lg px-4 py-3">
          <i className="bi bi-collection text-cyan-400"></i>
          <input
            ref={newCellInputRef}
            value={newCellName}
            onChange={(e) => setNewCellName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddCell();
              if (e.key === "Escape") { setAddingCell(false); setNewCellName(""); }
            }}
            placeholder="Enter cell name…"
            className="flex-1 bg-transparent text-white text-sm placeholder-gray-500 outline-none"
          />
          <button
            onClick={handleAddCell}
            disabled={!newCellName.trim()}
            className="bg-cyan-600 hover:bg-cyan-700 disabled:opacity-40 text-white text-sm px-3 py-1 rounded transition-colors"
          >
            Create
          </button>
          <button
            onClick={() => { setAddingCell(false); setNewCellName(""); }}
            className="text-gray-400 hover:text-white text-sm px-2 py-1 rounded transition-colors"
          >
            <i className="bi bi-x-lg"></i>
          </button>
        </div>
      )}

      {/* Unassigned pool — always on top */}
      <div
        className={`rounded-lg border overflow-hidden transition-colors ${
          dropTarget?.cellId === null ? "border-gray-500 bg-gray-700/20" : "border-gray-700/50 bg-gray-800/30"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDropTarget({ cellId: null, beforeCode: null }); }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
        onDrop={(e) => handleDrop(e, null, dropTarget?.beforeCode ?? null)}
      >
        <div className="flex items-center justify-between px-4 py-3 bg-gray-800/60 border-b border-gray-700/50">
          <h4 className="text-gray-400 font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-inbox text-gray-500"></i>
            Unassigned Machines
            <span className="text-gray-600 font-normal text-xs">
              {unassigned.length} machine{unassigned.length !== 1 ? "s" : ""}
            </span>
          </h4>
        </div>
        <div className="p-3 min-h-[72px] flex flex-wrap gap-2 items-center">
          {unassigned.length === 0 && dropTarget?.cellId !== null && (
            <div className="flex items-center justify-center w-full text-gray-700 text-xs select-none">
              All machines assigned
            </div>
          )}
          {renderChips(unassigned, null)}
        </div>
      </div>

      {/* Production cells */}
      {cells.length === 0 && !addingCell && (
        <div className="bg-gray-800/50 border border-dashed border-gray-600 rounded-lg p-8 text-center text-gray-500 text-sm">
          No production cells yet. Click <strong className="text-gray-400">Add Production Cell</strong> to create one.
        </div>
      )}

      {cells.map((cell) => {
        const cellMachines = machinesInCell(cell.id);
        const isTarget = dropTarget?.cellId === cell.id;
        return (
          <div
            key={cell.id}
            className={`rounded-lg border overflow-hidden transition-colors ${
              isTarget ? "border-cyan-500 bg-cyan-900/10" : "border-gray-700 bg-gray-800/50"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDropTarget({ cellId: cell.id, beforeCode: null }); }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
            }}
            onDrop={(e) => handleDrop(e, cell.id, dropTarget?.beforeCode ?? null)}
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
                  <span className="text-gray-500 font-normal text-xs">
                    {cellMachines.length} machine{cellMachines.length !== 1 ? "s" : ""}
                  </span>
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
            <div className="p-3 min-h-[72px] flex flex-wrap gap-2 items-center">
              {cellMachines.length === 0 && !isTarget && (
                <div className="flex items-center justify-center w-full text-gray-600 text-xs select-none">
                  <i className="bi bi-arrow-down-circle mr-1.5"></i> Drop machines here
                </div>
              )}
              {renderChips(cellMachines, cell.id)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Draggable machine chip
// ─────────────────────────────────────────────────────────────
function MachineChip({
  code,
  packingFormat,
  isDragging,
  onFormatChange,
  onDragStart,
  onDragEnd,
  onChipDragOver,
}: {
  code: string;
  packingFormat?: PackingFormat | null;
  isDragging?: boolean;
  onFormatChange?: (fmt: PackingFormat | null) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onChipDragOver?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onChipDragOver}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium select-none transition-all ${
        isDragging
          ? "opacity-30 cursor-grabbing bg-gray-600 text-gray-400 border border-gray-500"
          : "bg-gray-700 text-white border border-gray-600 cursor-grab hover:border-cyan-500 hover:bg-gray-600 active:cursor-grabbing"
      }`}
    >
      <i className="bi bi-grip-vertical text-gray-400 text-xs"></i>
      <i className="bi bi-cpu text-cyan-400 text-xs"></i>
      <span>{code}</span>
      {/* Packing format selector — stopPropagation prevents drag starting on click */}
      <select
        value={packingFormat ?? ""}
        onChange={(e) => onFormatChange?.((e.target.value as PackingFormat) || null)}
        onPointerDown={(e) => e.stopPropagation()}
        className="ml-1 text-xs bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-gray-300 cursor-pointer focus:border-cyan-500 outline-none hover:border-gray-400"
        title="Packing format"
      >
        <option value="">— format</option>
        {(Object.entries(PACKING_FORMATS) as [PackingFormat, string][]).map(([key, label]) => (
          <option key={key} value={key}>{label}</option>
        ))}
      </select>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Thresholds tab
// ─────────────────────────────────────────────────────────────
function ThresholdRow({
  label, sublabel, value, onChange, unit, inverted,
}: {
  label: string; sublabel: string; value: number;
  onChange: (v: number) => void; unit: string; inverted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <span className="text-sm text-white">{label}</span>
        <span className="text-xs text-gray-500 ml-2">{sublabel}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0} max={100} step={0.5}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white text-right focus:border-cyan-500 outline-none"
        />
        <span className="text-gray-400 text-sm w-4">{unit}</span>
      </div>
    </div>
  );
}

function ThresholdPreview({ good, mediocre, inverted }: { good: number; mediocre: number; inverted?: boolean }) {
  const zones = inverted
    ? [
        { label: `≤ ${good}%`,              pct: good,                       color: "bg-green-500"  },
        { label: `${good}–${mediocre}%`,    pct: mediocre - good,            color: "bg-yellow-500" },
        { label: `> ${mediocre}%`,          pct: Math.max(5, 100 - mediocre), color: "bg-red-500"   },
      ]
    : [
        { label: `≥ ${good}%`,              pct: Math.max(5, 100 - good),    color: "bg-green-500"  },
        { label: `${mediocre}–${good}%`,    pct: good - mediocre,            color: "bg-yellow-500" },
        { label: `< ${mediocre}%`,          pct: mediocre,                   color: "bg-red-500"    },
      ];
  const total = zones.reduce((s, z) => s + z.pct, 0);
  return (
    <div className="mt-3">
      <div className="flex h-2 rounded-full overflow-hidden gap-0.5">
        {zones.map((z) => (
          <div key={z.label} className={`${z.color} rounded-full`} style={{ flex: z.pct / total }} />
        ))}
      </div>
      <div className="flex justify-between mt-1">
        {zones.map((z) => (
          <span key={z.label} className="text-xs text-gray-500">{z.label}</span>
        ))}
      </div>
    </div>
  );
}

function ThresholdsTab() {
  const [t, setT] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    fetchThresholds().then(setT).catch(console.error).finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveThresholds(t);
      setSavedMsg(true);
      setTimeout(() => setSavedMsg(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 py-8">
      <span className="animate-spin text-lg">⟳</span> Loading…
    </div>
  );

  return (
    <div className="space-y-4 max-w-lg">
      <p className="text-sm text-gray-400">
        Define cut-off values that determine when a metric is shown as{" "}
        <span className="text-green-400 font-medium">Good</span>,{" "}
        <span className="text-yellow-400 font-medium">Mediocre</span>, or{" "}
        <span className="text-red-400 font-medium">Bad</span> on the dashboard.
      </p>

      {/* Efficiency */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="bg-gray-800 px-5 py-3 border-b border-gray-700">
          <h4 className="text-white font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-speedometer2 text-cyan-400"></i>Efficiency
          </h4>
          <p className="text-gray-500 text-xs mt-0.5">Higher is better</p>
        </div>
        <div className="px-5 py-3 divide-y divide-gray-700/50">
          <ThresholdRow
            label="Good threshold"
            sublabel="≥ this value = green"
            value={t.efficiency.good}
            onChange={(v) => setT({ ...t, efficiency: { ...t.efficiency, good: v } })}
            unit="%"
          />
          <ThresholdRow
            label="Mediocre threshold"
            sublabel="≥ this value = amber, below = red"
            value={t.efficiency.mediocre}
            onChange={(v) => setT({ ...t, efficiency: { ...t.efficiency, mediocre: v } })}
            unit="%"
          />
        </div>
        <div className="px-5 pb-4">
          <ThresholdPreview good={t.efficiency.good} mediocre={t.efficiency.mediocre} />
        </div>
      </div>

      {/* Scrap Rate */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="bg-gray-800 px-5 py-3 border-b border-gray-700">
          <h4 className="text-white font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-exclamation-triangle text-yellow-400"></i>Scrap Rate
          </h4>
          <p className="text-gray-500 text-xs mt-0.5">Lower is better</p>
        </div>
        <div className="px-5 py-3 divide-y divide-gray-700/50">
          <ThresholdRow
            label="Good threshold"
            sublabel="≤ this value = green"
            value={t.scrap.good}
            onChange={(v) => setT({ ...t, scrap: { ...t.scrap, good: v } })}
            unit="%"
            inverted
          />
          <ThresholdRow
            label="Mediocre threshold"
            sublabel="≤ this value = amber, above = red"
            value={t.scrap.mediocre}
            onChange={(v) => setT({ ...t, scrap: { ...t.scrap, mediocre: v } })}
            unit="%"
            inverted
          />
        </div>
        <div className="px-5 pb-4">
          <ThresholdPreview good={t.scrap.good} mediocre={t.scrap.mediocre} inverted />
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-sm px-5 py-2 rounded-lg transition-colors"
      >
        {saving ? <span className="animate-spin text-xs">⟳</span> : <i className="bi bi-check-lg"></i>}
        {savedMsg ? "Saved!" : saving ? "Saving…" : "Save Thresholds"}
      </button>
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
    { id: "users",       label: "Users",       icon: "bi-people-fill"    },
    { id: "machines",    label: "Machines",    icon: "bi-cpu-fill"       },
    { id: "thresholds",  label: "Thresholds",  icon: "bi-sliders"        },
    { id: "mqtt",        label: "MQTT",        icon: "bi-router-fill"    },
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

      {/* ── THRESHOLDS ── */}
      {activeTab === "thresholds" && <ThresholdsTab />}

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
