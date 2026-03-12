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
  updateMachineTargets,
  fetchThresholds,
  saveThresholds,
  DEFAULT_THRESHOLDS,
  PACKING_FORMATS,
} from "@/lib/supabase";
import type { RegisteredMachine, ProductionCell, Thresholds, PackingFormat, MachineTargets } from "@/lib/supabase";

type DropTarget = {
  cellId: string | null;      // destination cell (null = unassigned)
  beforeCode: string | null;  // insert before this machine (null = append to end)
};

type Tab = "users" | "machines" | "thresholds" | "mqtt";

// ─────────────────────────────────────────────────────────────
// Reusable confirmation modal
// ─────────────────────────────────────────────────────────────
function ConfirmModal({
  message, confirmLabel = "Delete", onConfirm, onCancel, danger = true,
}: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
        <div className="flex items-start gap-3 mb-5">
          <div className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${danger ? "bg-red-500/15" : "bg-yellow-500/15"}`}>
            <i className={`bi ${danger ? "bi-trash3 text-red-400" : "bi-exclamation-triangle text-yellow-400"}`}></i>
          </div>
          <p className="text-sm text-gray-200 leading-relaxed pt-1">{message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm text-white rounded-lg transition-colors ${
              danger ? "bg-red-600 hover:bg-red-700" : "bg-cyan-600 hover:bg-cyan-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [confirmDelete, setConfirmDelete] = useState<{ cellId: string; cellName: string } | null>(null);
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
    const cell = cells.find(c => c.id === id);
    setConfirmDelete({ cellId: id, cellName: cell?.name ?? "this cell" });
  };

  const confirmDeleteCell = async () => {
    if (!confirmDelete) return;
    await deleteProductionCell(confirmDelete.cellId);
    setConfirmDelete(null);
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
      {/* Delete confirmation modal */}
      {confirmDelete && (
        <ConfirmModal
          message={`Delete "${confirmDelete.cellName}"? All machines inside will become unassigned.`}
          confirmLabel="Delete Cell"
          onConfirm={confirmDeleteCell}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

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
  label, sublabel, value, onChange, unit, inverted, max,
}: {
  label: string; sublabel: string; value: number;
  onChange: (v: number) => void; unit: string; inverted?: boolean; max?: number;
}) {
  const [display, setDisplay] = useState(String(value));

  // Keep display in sync when parent value changes externally (e.g. on load)
  useEffect(() => {
    setDisplay(String(value));
  }, [value]);

  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <span className="text-sm text-white">{label}</span>
        <span className="text-xs text-gray-500 ml-2">{sublabel}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0} max={max ?? 100} step={0.5}
          value={display}
          onChange={(e) => {
            setDisplay(e.target.value);
            const n = parseFloat(e.target.value);
            if (!isNaN(n)) onChange(n);
          }}
          onBlur={(e) => {
            const n = parseFloat(e.target.value);
            if (isNaN(n) || e.target.value === "") {
              setDisplay(String(value)); // revert to last valid value
            } else {
              onChange(n);
              setDisplay(String(n));
            }
          }}
          className="w-20 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white text-right focus:border-cyan-500 outline-none"
        />
        <span className="text-gray-400 text-sm w-8">{unit}</span>
      </div>
    </div>
  );
}

function ThresholdPreview({ good, mediocre, inverted, unit = "%" }: { good: number; mediocre: number; inverted?: boolean; unit?: string }) {
  const zones = inverted
    ? [
        { label: `≤ ${good}${unit}`,              pct: good,                       color: "bg-green-500"  },
        { label: `${good}–${mediocre}${unit}`,    pct: mediocre - good,            color: "bg-yellow-500" },
        { label: `> ${mediocre}${unit}`,          pct: Math.max(5, 100 - mediocre), color: "bg-red-500"   },
      ]
    : [
        { label: `≥ ${good}${unit}`,              pct: Math.max(5, 100 - good),    color: "bg-green-500"  },
        { label: `${mediocre}–${good}${unit}`,    pct: good - mediocre,            color: "bg-yellow-500" },
        { label: `< ${mediocre}${unit}`,          pct: mediocre,                   color: "bg-red-500"    },
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

// Compact numeric input for the targets table
function TargetInput({
  value, onChange, unit, placeholder,
}: {
  value: number | null; onChange: (v: number | null) => void;
  unit?: string; placeholder?: string;
}) {
  const [display, setDisplay] = useState(value !== null ? String(value) : "");
  useEffect(() => { setDisplay(value !== null ? String(value) : ""); }, [value]);
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0} step={0.5}
        value={display}
        placeholder={placeholder ?? "—"}
        onChange={(e) => {
          setDisplay(e.target.value);
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(n);
        }}
        onBlur={(e) => {
          const n = parseFloat(e.target.value);
          if (e.target.value === "" || isNaN(n)) { setDisplay(""); onChange(null); }
          else { onChange(n); setDisplay(String(n)); }
        }}
        className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white text-right focus:border-cyan-500 outline-none placeholder-gray-600"
      />
      {unit && <span className="text-gray-500 text-xs">{unit}</span>}
    </div>
  );
}

function ThresholdsTab() {
  // ── Shift length (global) ──────────────────────────────────
  const [t, setT] = useState<Thresholds>(DEFAULT_THRESHOLDS);

  // ── Per-machine targets ────────────────────────────────────
  const [machines, setMachines] = useState<RegisteredMachine[]>([]);
  const [cells, setCells] = useState<ProductionCell[]>([]);
  const [targets, setTargets] = useState<Record<string, MachineTargets>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    Promise.all([
      fetchThresholds(),
      fetchRegisteredMachines(),
      fetchProductionCells(),
    ]).then(([thresh, ms, cs]) => {
      setT(thresh);
      setMachines(ms);
      setCells(cs);
      // Initialise targets from DB values
      const init: Record<string, MachineTargets> = {};
      for (const m of ms) {
        init[m.machine_code] = {
          efficiency_good:     m.efficiency_good,
          efficiency_mediocre: m.efficiency_mediocre,
          scrap_good:          m.scrap_good,
          scrap_mediocre:      m.scrap_mediocre,
          bu_target:           m.bu_target,
        };
      }
      setTargets(init);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const setTarget = (code: string, field: keyof MachineTargets, val: number | null) => {
    setTargets(prev => ({ ...prev, [code]: { ...prev[code], [field]: val } }));
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await Promise.all([
        saveThresholds(t),
        ...machines.map(m => updateMachineTargets(m.machine_code, targets[m.machine_code] ?? {
          efficiency_good: null, efficiency_mediocre: null,
          scrap_good: null, scrap_mediocre: null, bu_target: null,
        })),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  };

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 py-8">
      <span className="animate-spin text-lg">⟳</span> Loading…
    </div>
  );

  // Group machines by cell
  const cellMachines = (cellId: string) =>
    machines
      .filter(m => m.cell_id === cellId)
      .sort((a, b) => (a.cell_position ?? 0) - (b.cell_position ?? 0));
  const unassigned = machines.filter(m => !m.cell_id);

  const MachineTargetRow = ({ m }: { m: RegisteredMachine }) => {
    const tgt = targets[m.machine_code] ?? { efficiency_good: null, efficiency_mediocre: null, scrap_good: null, scrap_mediocre: null, bu_target: null };
    return (
      <tr className="border-t border-gray-700/50 hover:bg-gray-800/30">
        <td className="px-4 py-2.5 font-bold text-cyan-400 text-sm whitespace-nowrap">{m.machine_code}</td>
        {/* Efficiency group — cyan tint */}
        <td className="px-3 py-2.5 bg-cyan-900/5">
          <TargetInput value={tgt.efficiency_good} onChange={v => setTarget(m.machine_code, "efficiency_good", v)} unit="%" placeholder="e.g. 88" />
        </td>
        <td className="px-3 py-2.5 bg-cyan-900/5 border-r border-gray-700/50">
          <TargetInput value={tgt.efficiency_mediocre} onChange={v => setTarget(m.machine_code, "efficiency_mediocre", v)} unit="%" placeholder="e.g. 72" />
        </td>
        {/* Scrap group — orange tint */}
        <td className="px-3 py-2.5 bg-orange-900/5">
          <TargetInput value={tgt.scrap_good} onChange={v => setTarget(m.machine_code, "scrap_good", v)} unit="%" placeholder="e.g. 2" />
        </td>
        <td className="px-3 py-2.5 bg-orange-900/5 border-r border-gray-700/50">
          <TargetInput value={tgt.scrap_mediocre} onChange={v => setTarget(m.machine_code, "scrap_mediocre", v)} unit="%" placeholder="e.g. 5" />
        </td>
        {/* BU target — purple tint */}
        <td className="px-3 py-2.5 bg-purple-900/5">
          <TargetInput value={tgt.bu_target} onChange={v => setTarget(m.machine_code, "bu_target", v)} unit="BUs" placeholder="e.g. 180" />
        </td>
      </tr>
    );
  };

  const CellGroup = ({ title, ms }: { title: string; ms: RegisteredMachine[] }) => {
    if (ms.length === 0) return null;
    return (
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        {/* Cell name header */}
        <div className="bg-gray-800 px-4 py-2.5 border-b border-gray-700">
          <span className="text-white font-semibold text-sm">
            <i className="bi bi-collection text-cyan-400 mr-2"></i>{title}
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {/* Row 1: group headers */}
              <tr>
                <th className="px-4 py-2 text-left" rowSpan={2}>
                  <span className="text-xs text-gray-500 font-medium">Machine</span>
                </th>
                {/* Efficiency group */}
                <th colSpan={2} className="px-3 pt-2.5 pb-1 text-center border-b-2 border-cyan-500 bg-cyan-900/20">
                  <span className="text-xs font-semibold text-cyan-300 tracking-wide uppercase">
                    <i className="bi bi-speedometer2 mr-1.5"></i>Efficiency Thresholds
                  </span>
                </th>
                {/* Scrap group */}
                <th colSpan={2} className="px-3 pt-2.5 pb-1 text-center border-b-2 border-orange-500 bg-orange-900/20">
                  <span className="text-xs font-semibold text-orange-300 tracking-wide uppercase">
                    <i className="bi bi-exclamation-triangle mr-1.5"></i>Scrap Rate Thresholds
                  </span>
                </th>
                {/* BU target */}
                <th className="px-3 pt-2.5 pb-1 text-center border-b-2 border-purple-500 bg-purple-900/20">
                  <span className="text-xs font-semibold text-purple-300 tracking-wide uppercase">
                    <i className="bi bi-bullseye mr-1.5"></i>Output Target
                  </span>
                </th>
              </tr>
              {/* Row 2: sub-column labels */}
              <tr className="bg-gray-800/30">
                <th className="px-3 py-1.5 text-center bg-cyan-900/10 border-r border-gray-700/50">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
                    <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
                    Good <span className="text-gray-500 font-normal">(≥)</span>
                  </span>
                </th>
                <th className="px-3 py-1.5 text-center bg-cyan-900/10">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-400">
                    <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"></span>
                    Mediocre <span className="text-gray-500 font-normal">(≥)</span>
                  </span>
                </th>
                <th className="px-3 py-1.5 text-center bg-orange-900/10 border-r border-gray-700/50 border-l border-gray-700/50">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
                    <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
                    Good <span className="text-gray-500 font-normal">(≤)</span>
                  </span>
                </th>
                <th className="px-3 py-1.5 text-center bg-orange-900/10">
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-400">
                    <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"></span>
                    Mediocre <span className="text-gray-500 font-normal">(≤)</span>
                  </span>
                </th>
                <th className="px-3 py-1.5 text-center bg-purple-900/10 border-l border-gray-700/50">
                  <span className="text-xs font-medium text-purple-300">BUs / shift</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ms.map(m => <MachineTargetRow key={m.machine_code} m={m} />)}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      {/* ── Top toolbar ───────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          Set thresholds and BU targets per machine. Leave a field empty to disable that metric.
          Traffic light:{" "}
          <span className="text-green-400">good</span> / <span className="text-yellow-400">mediocre</span> / <span className="text-red-400">below</span>.
        </p>
        <button
          onClick={handleSaveAll}
          disabled={saving}
          className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white text-sm px-5 py-2 rounded-lg transition-colors shrink-0 ml-6"
        >
          {saving ? <span className="animate-spin text-xs">⟳</span> : <i className="bi bi-check-lg"></i>}
          {saved ? "Saved!" : saving ? "Saving…" : "Save Settings"}
        </button>
      </div>

      {/* ── Shift length ──────────────────────────────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden max-w-sm">
        <div className="bg-gray-800 px-5 py-3 border-b border-gray-700">
          <h4 className="text-white font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-clock text-cyan-400"></i>Shift Length
          </h4>
          <p className="text-gray-500 text-xs mt-0.5">Used to calculate BU run rates across all machines</p>
        </div>
        <div className="px-5 py-3">
          <ThresholdRow
            label="Duration"
            sublabel="Hours per shift"
            value={t.bu.shiftLengthMinutes / 60}
            onChange={(v) => setT({ ...t, bu: { ...t.bu, shiftLengthMinutes: Math.round(v * 60) } })}
            unit="hrs"
            max={24}
          />
        </div>
      </div>

      {/* ── Per-machine targets ───────────────────────────────── */}
      {machines.length === 0 ? (
        <p className="text-gray-500 text-sm">No machines registered yet.</p>
      ) : (
        <div className="space-y-4">
          {cells.map(cell => (
            <CellGroup key={cell.id} title={cell.name} ms={cellMachines(cell.id)} />
          ))}
          {unassigned.length > 0 && (
            <CellGroup title="Unassigned" ms={unassigned} />
          )}
        </div>
      )}
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
    { id: "thresholds",  label: "Thresholds & Targets",  icon: "bi-sliders"  },
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
