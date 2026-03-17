"use client";

import { useEffect, useState, useRef } from "react";
import {
  fetchRegisteredMachines,
  fetchProductionCells,
  createProductionCell,
  renameProductionCell,
  deleteProductionCell,
  assignMachineToCell,
  updateCellOrder,
  updateMachinePackingFormat,
  updateMachineTargets,
  deleteMachine,
  deleteMachineFromBridge,
  fetchThresholds,
  saveThresholds,
  DEFAULT_THRESHOLDS,
  PACKING_FORMATS,
  fetchShiftConfig,
  saveShiftConfig,
  fetchShiftAssignments,
  saveShiftAssignment,
  saveShiftAssignmentsBulk,
  shiftLengthFromSlots,
  DEFAULT_SHIFT_CONFIG,
} from "@/lib/supabase";
import type { RegisteredMachine, ProductionCell, Thresholds, PackingFormat, MachineTargets, ShiftConfig, ShiftAssignment, TimeSlot } from "@/lib/supabase";

type DropTarget = {
  cellId: string | null;      // destination cell (null = unassigned)
  beforeCode: string | null;  // insert before this machine (null = append to end)
};

type Tab = "users" | "machines" | "thresholds" | "shifts";

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
  const [confirmDeleteMachine, setConfirmDeleteMachine] = useState<string | null>(null);
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

  const handleDeleteMachine = async () => {
    if (!confirmDeleteMachine) return;
    await deleteMachine(confirmDeleteMachine);
    await deleteMachineFromBridge(confirmDeleteMachine);
    setConfirmDeleteMachine(null);
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
            onDelete={() => setConfirmDeleteMachine(m.machine_code)}
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
      {/* Cell delete confirmation modal */}
      {confirmDelete && (
        <ConfirmModal
          message={`Delete "${confirmDelete.cellName}"? All machines inside will become unassigned.`}
          confirmLabel="Delete Cell"
          onConfirm={confirmDeleteCell}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {/* Machine delete confirmation modal */}
      {confirmDeleteMachine && (
        <ConfirmModal
          message={`Remove "${confirmDeleteMachine}" from the dashboard? All production history for this machine will remain in the database. If the machine sends data again it will be re-registered automatically.`}
          confirmLabel="Remove Machine"
          onConfirm={handleDeleteMachine}
          onCancel={() => setConfirmDeleteMachine(null)}
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
  onDelete,
}: {
  code: string;
  packingFormat?: PackingFormat | null;
  isDragging?: boolean;
  onFormatChange?: (fmt: PackingFormat | null) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onChipDragOver?: (e: React.DragEvent) => void;
  onDelete?: () => void;
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
      {/* Delete button */}
      {onDelete && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="ml-1 text-gray-500 hover:text-red-400 transition-colors"
          title="Remove machine"
        >
          <i className="bi bi-x-lg text-xs"></i>
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Thresholds tab
// ─────────────────────────────────────────────────────────────
function ThresholdRow({
  label, sublabel, value, onChange, onSave, unit, inverted, max,
}: {
  label: string; sublabel?: string; value: number;
  onChange: (v: number) => void; onSave?: (v: number) => void;
  unit: string; inverted?: boolean; max?: number;
}) {
  const [display, setDisplay] = useState(String(value));
  const focused = useRef(false);

  // Keep display in sync when parent value changes externally (e.g. on load)
  // but never while the user is actively editing the field
  useEffect(() => {
    if (!focused.current) setDisplay(String(value));
  }, [value]);

  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <span className="text-sm text-white">{label}</span>
        {sublabel && <span className="text-xs text-gray-500 ml-2">{sublabel}</span>}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0} max={max ?? 100} step={0.5}
          value={display}
          onWheel={(e) => e.currentTarget.blur()}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => {
            setDisplay(e.target.value);
            const n = parseFloat(e.target.value);
            if (!isNaN(n)) onChange(n);
          }}
          onBlur={(e) => {
            focused.current = false;
            const n = parseFloat(e.target.value);
            if (isNaN(n) || e.target.value === "") {
              setDisplay(String(value)); // revert to last valid value
            } else {
              onChange(n);
              setDisplay(String(n));
              onSave?.(n);
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
  value, onChange, onSave, unit, placeholder,
}: {
  value: number | null; onChange: (v: number | null) => void;
  onSave?: (val: number | null) => void;
  unit?: string; placeholder?: string;
}) {
  const [display, setDisplay] = useState(value !== null ? String(value) : "");
  const focused = useRef(false);

  // Only sync incoming value changes when the field is not being edited
  useEffect(() => {
    if (!focused.current) {
      setDisplay(value !== null ? String(value) : "");
    }
  }, [value]);

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        min={0} step={0.5}
        value={display}
        placeholder={placeholder ?? "—"}
        onWheel={(e) => e.currentTarget.blur()}
        onFocus={() => { focused.current = true; }}
        onChange={(e) => {
          setDisplay(e.target.value);
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange(n);
        }}
        onBlur={(e) => {
          focused.current = false;
          const n = parseFloat(e.target.value);
          const final = (e.target.value === "" || isNaN(n)) ? null : n;
          if (final === null) { setDisplay(""); onChange(null); }
          else { onChange(final); setDisplay(String(final)); }
          onSave?.(final);
        }}
        className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white text-right focus:border-cyan-500 outline-none placeholder-gray-600"
      />
      {unit && <span className="text-gray-500 text-xs">{unit}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Module-level so React never re-mounts them on parent re-render
// ─────────────────────────────────────────────────────────────
function MachineTargetRow({
  m, targets, onSetTarget, onSaveTarget,
}: {
  m: RegisteredMachine;
  targets: Record<string, MachineTargets>;
  onSetTarget: (code: string, field: keyof MachineTargets, val: number | null) => void;
  onSaveTarget: (code: string, field: keyof MachineTargets, val: number | null) => void;
}) {
  const tgt = targets[m.machine_code] ?? { efficiency_good: null, efficiency_mediocre: null, scrap_good: null, scrap_mediocre: null, bu_target: null, bu_mediocre: null, speed_target: null };
  return (
    <tr className="border-t border-gray-700/50 hover:bg-gray-800/30">
      <td className="px-4 py-2.5 font-bold text-cyan-400 text-sm whitespace-nowrap">{m.machine_code}</td>
      {/* Uptime group — cyan tint */}
      <td className="px-3 py-2.5 bg-cyan-900/5">
        <TargetInput value={tgt.efficiency_good} onChange={v => onSetTarget(m.machine_code, "efficiency_good", v)} onSave={v => onSaveTarget(m.machine_code, "efficiency_good", v)} unit="%" placeholder="e.g. 82" />
      </td>
      <td className="px-3 py-2.5 bg-cyan-900/5 border-r border-gray-700/50">
        <TargetInput value={tgt.efficiency_mediocre} onChange={v => onSetTarget(m.machine_code, "efficiency_mediocre", v)} onSave={v => onSaveTarget(m.machine_code, "efficiency_mediocre", v)} unit="%" placeholder="e.g. 72" />
      </td>
      {/* Scrap group — orange tint */}
      <td className="px-3 py-2.5 bg-orange-900/5">
        <TargetInput value={tgt.scrap_good} onChange={v => onSetTarget(m.machine_code, "scrap_good", v)} onSave={v => onSaveTarget(m.machine_code, "scrap_good", v)} unit="%" placeholder="e.g. 4" />
      </td>
      <td className="px-3 py-2.5 bg-orange-900/5 border-r border-gray-700/50">
        <TargetInput value={tgt.scrap_mediocre} onChange={v => onSetTarget(m.machine_code, "scrap_mediocre", v)} onSave={v => onSaveTarget(m.machine_code, "scrap_mediocre", v)} unit="%" placeholder="e.g. 5" />
      </td>
      {/* BU target — purple tint */}
      <td className="px-3 py-2.5 bg-purple-900/5 border-l border-gray-700/50">
        <TargetInput value={tgt.bu_target} onChange={v => onSetTarget(m.machine_code, "bu_target", v)} onSave={v => onSaveTarget(m.machine_code, "bu_target", v)} unit="BUs" placeholder="e.g. 180" />
      </td>
      <td className="px-3 py-2.5 bg-purple-900/5 border-l border-gray-700/50 border-r border-gray-700/50">
        <TargetInput value={tgt.bu_mediocre} onChange={v => onSetTarget(m.machine_code, "bu_mediocre", v)} onSave={v => onSaveTarget(m.machine_code, "bu_mediocre", v)} unit="BUs" placeholder="e.g. 150" />
      </td>
      {/* Speed target — teal tint */}
      <td className="px-3 py-2.5 bg-teal-900/5">
        <TargetInput value={tgt.speed_target} onChange={v => onSetTarget(m.machine_code, "speed_target", v)} onSave={v => onSaveTarget(m.machine_code, "speed_target", v)} unit="p/m" placeholder="e.g. 2800" />
      </td>
    </tr>
  );
}

function CellGroup({
  title, ms, targets, onSetTarget, onSaveTarget,
}: {
  title: string;
  ms: RegisteredMachine[];
  targets: Record<string, MachineTargets>;
  onSetTarget: (code: string, field: keyof MachineTargets, val: number | null) => void;
  onSaveTarget: (code: string, field: keyof MachineTargets, val: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  if (ms.length === 0) return null;
  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
      <div className="bg-gray-800 px-4 py-2.5 border-b border-gray-700 cursor-pointer hover:bg-gray-750 transition-colors flex items-center justify-between" onClick={() => setOpen(!open)}>
        <span className="text-white font-semibold text-sm">
          <i className="bi bi-collection text-cyan-400 mr-2"></i>{title}
        </span>
        <i className={`bi bi-chevron-${open ? "up" : "down"} text-gray-400 text-xs`}></i>
      </div>
      {open && <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left" rowSpan={2}>
                <span className="text-xs text-gray-500 font-medium">Machine</span>
              </th>
              <th colSpan={2} className="px-3 pt-2.5 pb-1 text-center border-b-2 border-cyan-500 bg-cyan-900/20">
                <span className="text-xs font-semibold text-cyan-300 tracking-wide uppercase">
                  <i className="bi bi-speedometer2 mr-1.5"></i>Uptime Thresholds
                </span>
              </th>
              <th colSpan={2} className="px-3 pt-2.5 pb-1 text-center border-b-2 border-orange-500 bg-orange-900/20">
                <span className="text-xs font-semibold text-orange-300 tracking-wide uppercase">
                  <i className="bi bi-exclamation-triangle mr-1.5"></i>Scrap Rate Thresholds
                </span>
              </th>
              <th colSpan={2} className="px-3 pt-2.5 pb-1 text-center border-b-2 border-purple-500 bg-purple-900/20">
                <span className="text-xs font-semibold text-purple-300 tracking-wide uppercase">
                  <i className="bi bi-bullseye mr-1.5"></i>Output Target
                </span>
              </th>
              <th className="px-3 pt-2.5 pb-1 text-center border-b-2 border-teal-500 bg-teal-900/20">
                <span className="text-xs font-semibold text-teal-300 tracking-wide uppercase">
                  <i className="bi bi-speedometer mr-1.5"></i>Speed Target
                </span>
              </th>
            </tr>
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
                <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
                  Target <span className="text-gray-500 font-normal">(≥)</span>
                </span>
              </th>
              <th className="px-3 py-1.5 text-center bg-purple-900/10 border-l border-gray-700/50 border-r border-gray-700/50">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-400">
                  <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block"></span>
                  Mediocre <span className="text-gray-500 font-normal">(≥)</span>
                </span>
              </th>
              <th className="px-3 py-1.5 text-center bg-teal-900/10 border-l border-gray-700/50">
                <span className="text-xs font-medium text-teal-300">pcs/min</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ms.map(m => (
              <MachineTargetRow key={m.machine_code} m={m} targets={targets} onSetTarget={onSetTarget} onSaveTarget={onSaveTarget} />
            ))}
          </tbody>
        </table>
      </div>}
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
          bu_target:           m.bu_target || null,
          bu_mediocre:         m.bu_mediocre || null,
          speed_target:        m.speed_target || null,
        };
      }
      setTargets(init);
    }).catch(console.error).finally(() => setLoading(false));
  }, []);

  const setTarget = (code: string, field: keyof MachineTargets, val: number | null) => {
    setTargets(prev => ({ ...prev, [code]: { ...prev[code], [field]: val } }));
  };

  // Auto-save individual machine target field on blur
  const saveTargetField = (code: string, field: keyof MachineTargets, val: number | null) => {
    const current = targets[code] ?? { efficiency_good: null, efficiency_mediocre: null, scrap_good: null, scrap_mediocre: null, bu_target: null, bu_mediocre: null, speed_target: null };
    updateMachineTargets(code, { ...current, [field]: val }).catch(console.error);
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

  return (
    <div className="space-y-5">

      {/* ── Per-machine targets ───────────────────────────────── */}
      {machines.length === 0 ? (
        <p className="text-gray-500 text-sm">No machines registered yet.</p>
      ) : (
        <div className="space-y-4">
          {cells.map(cell => (
            <CellGroup key={cell.id} title={cell.name} ms={cellMachines(cell.id)} targets={targets} onSetTarget={setTarget} onSaveTarget={saveTargetField} />
          ))}
          {unassigned.length > 0 && (
            <CellGroup title="Unassigned" ms={unassigned} targets={targets} onSetTarget={setTarget} onSaveTarget={saveTargetField} />
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Shifts tab — manage shift teams, time slots & weekly calendar
// ─────────────────────────────────────────────────────────────

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const TEAM_PALETTE = [
  "bg-cyan-600", "bg-amber-600", "bg-emerald-600", "bg-purple-600",
  "bg-rose-600", "bg-teal-600", "bg-orange-500", "bg-indigo-600",
  "bg-pink-600", "bg-lime-600",
];
function teamColor(team: string, teams: string[]): string {
  const idx = teams.indexOf(team);
  if (idx < 0) return "bg-gray-600";
  return TEAM_PALETTE[idx % TEAM_PALETTE.length];
}

const SLOT_ICONS = ["bi-sunrise", "bi-sun", "bi-moon-stars", "bi-moon"];

function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

/** Compute end hour for a slot (= start hour of next slot, wrapping around). */
function slotEndHour(slots: TimeSlot[], index: number): number {
  return index < slots.length - 1
    ? slots[index + 1].startHour
    : slots[0].startHour; // wraps to first slot
}

function ShiftsTab() {
  const [config, setConfig] = useState<ShiftConfig>(DEFAULT_SHIFT_CONFIG);
  // Draft slots: edited locally, only persisted on explicit Save
  const [draftSlots, setDraftSlots] = useState<TimeSlot[]>(DEFAULT_SHIFT_CONFIG.slots);
  const [draftDowntime, setDraftDowntime] = useState<number>(0);
  const [downtimeDisplay, setDowntimeDisplay] = useState("0");
  const [slotsDirty, setSlotsDirty] = useState(false);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [slotSuccess, setSlotSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  const [assignments, setAssignments] = useState<Record<string, ShiftAssignment>>({});
  const [monthDate, setMonthDate] = useState<Date>(() => new Date()); // tracks current displayed month
  const [loading, setLoading] = useState(true);
  const [newTeamName, setNewTeamName] = useState("");
  const [editingSlot, setEditingSlot] = useState<number | null>(null);

  // Build calendar grid dates for the displayed month
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  // Start on Monday: day 0=Sun maps to offset 6, Mon=0, Tue=1, etc.
  const startDay = firstOfMonth.getDay();
  const leadingBlanks = startDay === 0 ? 6 : startDay - 1;
  const totalDays = lastOfMonth.getDate();
  const trailingBlanks = (7 - ((leadingBlanks + totalDays) % 7)) % 7;

  // All days of the month
  const monthDates: Date[] = [];
  for (let d = 1; d <= totalDays; d++) monthDates.push(new Date(year, month, d));

  // Date range for fetching assignments (just the month)
  const fromStr = toISODate(firstOfMonth);
  const toStr = toISODate(lastOfMonth);

  const draftShiftMins = draftSlots.length > 0 ? Math.round(24 * 60 / draftSlots.length) : 480;

  // Load config + assignments (only show full-page spinner on first load)
  const initialLoad = useRef(true);
  useEffect(() => {
    if (initialLoad.current) setLoading(true);
    Promise.all([fetchShiftConfig(), fetchShiftAssignments(fromStr, toStr)])
      .then(([cfg, rows]) => {
        setConfig(cfg);
        setDraftSlots(cfg.slots);
        setDraftDowntime(cfg.plannedDowntimeMinutes);
        setDowntimeDisplay(String(cfg.plannedDowntimeMinutes));
        setSlotsDirty(false);
        setSlotError(null);
        const map: Record<string, ShiftAssignment> = {};
        for (const r of rows) map[r.shift_date] = r;
        setAssignments(map);
      })
      .catch(console.error)
      .finally(() => { setLoading(false); initialLoad.current = false; });
  }, [fromStr, toStr]);

  // Month navigation
  const prevMonth = () => setMonthDate(new Date(year, month - 1, 1));
  const nextMonth = () => setMonthDate(new Date(year, month + 1, 1));
  const goToday = () => setMonthDate(new Date());

  // Persist helper for team changes (these still auto-save, only slot structure requires explicit save)
  const persistConfig = (updated: ShiftConfig) => {
    setConfig(updated);
    saveShiftConfig(updated).catch(console.error);
  };

  // ── Team management ───────────────────────────────────────
  const addTeam = () => {
    const name = newTeamName.trim().toUpperCase();
    if (!name || config.teams.includes(name)) return;
    persistConfig({ ...config, teams: [...config.teams, name] });
    setNewTeamName("");
  };
  const removeTeam = (name: string) => {
    persistConfig({ ...config, teams: config.teams.filter(t => t !== name) });
  };

  // ── Draft slot management (local only until Save) ─────────
  const markDirty = () => { setSlotsDirty(true); setSlotError(null); setSlotSuccess(false); };

  // Realistic pre-fills for each successive slot (indexed by current slot count before adding)
  const SLOT_PRESETS: TimeSlot[] = [
    { name: "Day",       startHour: 6  },
    { name: "Night",     startHour: 18 },
    { name: "Afternoon", startHour: 14 },
    { name: "Morning",   startHour: 2  },
  ];

  const addSlot = () => {
    if (draftSlots.length >= 4) return;
    const preset = SLOT_PRESETS[draftSlots.length] ?? { name: `Shift ${draftSlots.length + 1}`, startHour: 0 };
    // Keep existing slots intact; append the new preset and re-sort by start hour
    const newSlots = [...draftSlots, { name: preset.name, startHour: preset.startHour }]
      .sort((a, b) => a.startHour - b.startHour);
    setDraftSlots(newSlots);
    markDirty();
  };

  const removeSlot = (idx: number) => {
    if (draftSlots.length <= 1) return;
    setDraftSlots(draftSlots.filter((_, i) => i !== idx));
    markDirty();
  };

  const updateSlot = (idx: number, patch: Partial<TimeSlot>) => {
    setDraftSlots(draftSlots.map((s, i) => i === idx ? { ...s, ...patch } : s));
    setEditingSlot(null);
    markDirty();
  };

  const updateDraftDowntime = (raw: string) => {
    setDowntimeDisplay(raw);
    const n = Number(raw);
    if (raw !== "" && !isNaN(n)) {
      setDraftDowntime(Math.max(0, Math.round(n)));
    }
    markDirty();
  };

  const commitDraftDowntime = () => {
    if (downtimeDisplay === "" || isNaN(Number(downtimeDisplay))) {
      setDraftDowntime(0);
      setDowntimeDisplay("0");
    }
  };

  const clearAllSlots = () => {
    setDraftSlots([]);
    markDirty();
  };

  // ── Validate and save slot configuration ───────────────────
  const validateAndSave = async () => {
    setSlotError(null);
    setSlotSuccess(false);

    // Must have at least 1 slot
    if (draftSlots.length === 0) {
      setSlotError("You need at least one time slot. Add slots before saving.");
      return;
    }

    // Check that all slots have names
    if (draftSlots.some(s => !s.name.trim())) {
      setSlotError("Every slot needs a name.");
      return;
    }

    // Validate 24h coverage: each slot = 24 / slotCount hours, start hours must be unique
    const hours = draftSlots.map(s => s.startHour);
    const uniqueHours = new Set(hours);
    if (uniqueHours.size !== hours.length) {
      setSlotError("Each slot must have a unique start hour.");
      return;
    }

    // Check slots tile 24h evenly
    const slotLength = 24 / draftSlots.length;
    if (slotLength !== Math.floor(slotLength)) {
      setSlotError(`${draftSlots.length} slots do not divide evenly into 24 hours. Use 1, 2, 3, or 4 slots.`);
      return;
    }

    // Check downtime is less than shift length
    const shiftMinsDraft = Math.round(24 * 60 / draftSlots.length);
    if (draftDowntime >= shiftMinsDraft) {
      setSlotError(`Planned downtime (${draftDowntime} min) must be less than shift duration (${shiftMinsDraft} min).`);
      return;
    }

    // Sort slots by start hour for consistency
    const sorted = [...draftSlots].sort((a, b) => a.startHour - b.startHour);

    setSaving(true);
    try {
      const updated: ShiftConfig = { ...config, slots: sorted, plannedDowntimeMinutes: draftDowntime };
      await saveShiftConfig(updated);
      setConfig(updated);
      setDraftSlots(sorted);
      setSlotsDirty(false);
      setSlotSuccess(true);
      setTimeout(() => setSlotSuccess(false), 3000);
    } catch (e) {
      setSlotError(`Failed to save: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  const discardDraftChanges = () => {
    setDraftSlots(config.slots);
    setDraftDowntime(config.plannedDowntimeMinutes);
    setDowntimeDisplay(String(config.plannedDowntimeMinutes));
    setSlotsDirty(false);
    setSlotError(null);
    setSlotSuccess(false);
  };

  // ── Assignment management ─────────────────────────────────
  const assign = (dateStr: string, slotIdx: number, team: string | null) => {
    const prev = assignments[dateStr] ?? { shift_date: dateStr, slot_teams: config.slots.map(() => null) };
    const newTeams = [...prev.slot_teams];
    // Extend array if needed (e.g. old data had fewer slots)
    while (newTeams.length < config.slots.length) newTeams.push(null);
    newTeams[slotIdx] = team;
    const updated: ShiftAssignment = { shift_date: dateStr, slot_teams: newTeams };
    setAssignments(a => ({ ...a, [dateStr]: updated }));
    saveShiftAssignment(dateStr, newTeams).catch(console.error);
  };

  const clearMonth = () => {
    const emptySlots = config.slots.map(() => null);
    const bulk: ShiftAssignment[] = [];
    const map = { ...assignments };
    for (const d of monthDates) {
      const dateStr = toISODate(d);
      const a: ShiftAssignment = { shift_date: dateStr, slot_teams: emptySlots };
      map[dateStr] = a;
      bulk.push(a);
    }
    setAssignments(map);
    saveShiftAssignmentsBulk(bulk).catch(console.error);
  };

  const copyPrevMonth = async () => {
    const prevFirst = new Date(year, month - 1, 1);
    const prevLast = new Date(year, month, 0);
    try {
      const prevRows = await fetchShiftAssignments(toISODate(prevFirst), toISODate(prevLast));
      const bulk: ShiftAssignment[] = [];
      const map = { ...assignments };
      for (const d of monthDates) {
        const dateStr = toISODate(d);
        // Match by day-of-month from previous month (capped at prev month length)
        const prevDay = Math.min(d.getDate(), prevLast.getDate());
        const prevDateStr = toISODate(new Date(prevFirst.getFullYear(), prevFirst.getMonth(), prevDay));
        const src = prevRows.find(r => r.shift_date === prevDateStr);
        const a: ShiftAssignment = {
          shift_date: dateStr,
          slot_teams: src?.slot_teams ?? config.slots.map(() => null),
        };
        map[dateStr] = a;
        bulk.push(a);
      }
      setAssignments(map);
      await saveShiftAssignmentsBulk(bulk);
    } catch (e) { console.error(e); }
  };

  const isToday = (d: Date) => toISODate(d) === toISODate(new Date());

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 py-8">
      <span className="animate-spin text-lg">⟳</span> Loading…
    </div>
  );

  return (
    <div className="space-y-5">

      {/* ── Shift teams ─────────────────────────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden max-w-lg">
        <div className="bg-gray-800 px-5 py-3 border-b border-gray-700">
          <h4 className="text-white font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-people-fill text-cyan-400"></i>Shift Teams
          </h4>
          <p className="text-gray-500 text-xs mt-0.5">Define which teams rotate through shifts</p>
        </div>
        <div className="px-5 py-3">
          <div className="flex flex-wrap gap-2 mb-3">
            {config.teams.map(team => (
              <span key={team} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-white text-sm font-semibold ${teamColor(team, config.teams)}`}>
                {team}
                {config.teams.length > 1 && (
                  <button onClick={() => removeTeam(team)} className="ml-1 opacity-60 hover:opacity-100 transition-opacity" title={`Remove team ${team}`}>
                    <i className="bi bi-x-lg text-xs"></i>
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text" value={newTeamName}
              onChange={e => setNewTeamName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addTeam()}
              placeholder="New team name…" maxLength={10}
              className="bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-36 focus:outline-none focus:border-cyan-500"
            />
            <button onClick={addTeam} disabled={!newTeamName.trim()} className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm rounded transition-colors">
              Add
            </button>
          </div>
        </div>
      </div>

      {/* ── PLC Shift Structure ──────────────────────────── */}
      <div className={`bg-gray-800/50 border rounded-lg overflow-hidden max-w-lg ${slotsDirty ? "border-amber-500/60" : "border-gray-700"}`}>
        <div className="bg-gray-800 px-5 py-3 border-b border-gray-700">
          <h4 className="text-white font-semibold text-sm flex items-center gap-2">
            <i className="bi bi-clock text-cyan-400"></i>Shift Slots
          </h4>
          <p className="text-gray-500 text-xs mt-0.5">
            Match the shift slots to the shift configuration on the machine HMI. You <em className="text-gray-400 not-italic font-semibold">cannot</em> override the machine&apos;s shift structure here.
          </p>
        </div>
        <div className="px-5 py-3 space-y-2">
          {draftSlots.length === 0 && (
            <p className="text-gray-500 text-sm py-2 italic">No shifts configured. Add at least one slot.</p>
          )}
          {draftSlots.map((slot, idx) => {
            const end = slotEndHour(draftSlots, idx);
            const icon = SLOT_ICONS[idx % SLOT_ICONS.length];
            return (
              <div key={idx} className="flex items-center justify-between py-1.5 border-b border-gray-700/30 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-600 font-mono w-5 text-right">#{idx + 1}</span>
                  <i className={`bi ${icon} text-sm text-gray-400`}></i>
                  {editingSlot === idx ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text" defaultValue={slot.name} maxLength={15} autoFocus
                        onBlur={e => updateSlot(idx, { name: e.target.value.trim() || slot.name })}
                        onKeyDown={e => e.key === "Enter" && updateSlot(idx, { name: (e.target as HTMLInputElement).value.trim() || slot.name })}
                        className="bg-gray-900 border border-cyan-500 rounded px-2 py-1 text-sm text-white w-28 focus:outline-none"
                      />
                      <span className="text-gray-500 text-xs">starts at</span>
                      <input
                        type="number" min={0} max={23} defaultValue={slot.startHour}
                        onBlur={e => updateSlot(idx, { startHour: Math.max(0, Math.min(23, Number(e.target.value))) })}
                        onKeyDown={e => e.key === "Enter" && updateSlot(idx, { startHour: Math.max(0, Math.min(23, Number((e.target as HTMLInputElement).value))) })}
                        className="bg-gray-900 border border-cyan-500 rounded px-2 py-1 text-sm text-white w-14 text-right focus:outline-none"
                      />
                      <span className="text-gray-600 text-xs">&ndash;</span>
                      <span className="text-gray-500 text-xs">ends at</span>
                      <span className="text-gray-400 text-xs font-mono">{fmtHour(end)}</span>
                    </div>
                  ) : (
                    <button onClick={() => setEditingSlot(idx)} className="text-sm text-white hover:text-cyan-300 transition-colors">
                      {slot.name} <span className="text-gray-500 ml-1">{fmtHour(slot.startHour)} &ndash; {fmtHour(end)}</span>
                    </button>
                  )}
                </div>
                {editingSlot !== idx && (
                  <button onClick={() => removeSlot(idx)} className="text-gray-600 hover:text-red-400 transition-colors p-1" title="Remove slot">
                    <i className="bi bi-x-lg text-xs"></i>
                  </button>
                )}
              </div>
            );
          })}
          <div className="flex items-center gap-3 pt-1">
            {draftSlots.length < 4 && (
              <button onClick={addSlot} className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
                <i className="bi bi-plus-circle"></i> Add shift
              </button>
            )}
            {draftSlots.length > 0 && (
              <button onClick={clearAllSlots} className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors">
                <i className="bi bi-trash3"></i> Clear all
              </button>
            )}
          </div>
        </div>

        {/* Shift duration + downtime (derived from draft slots) */}
        <div className="px-5 py-3 border-t border-gray-700/50 divide-y divide-gray-700/30">
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-white">Shift duration</span>
            <span className="text-sm text-cyan-400">{draftSlots.length > 0 ? `${(draftShiftMins / 60).toFixed(1)} hrs` : "\u2014"}</span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-white">Planned downtime</span>
            <div className="flex items-center gap-2">
              <input
                type="number" min={0} max={draftShiftMins}
                value={downtimeDisplay}
                onChange={e => updateDraftDowntime(e.target.value)}
                onBlur={commitDraftDowntime}
                onWheel={e => e.currentTarget.blur()}
                className="w-20 bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-white text-right focus:border-cyan-500 outline-none"
              />
              <span className="text-gray-400 text-sm w-8">min</span>
            </div>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-white">Effective production time</span>
            <span className="text-sm text-cyan-400">
              {draftSlots.length > 0 ? `${((draftShiftMins - draftDowntime) / 60).toFixed(1)} hrs` : "\u2014"}
            </span>
          </div>
        </div>

        {/* Error / success messages */}
        {slotError && (
          <div className="mx-5 mb-3 px-3 py-2 bg-red-900/40 border border-red-700/50 rounded text-sm text-red-300 flex items-start gap-2">
            <i className="bi bi-exclamation-triangle-fill mt-0.5 shrink-0"></i>
            <span>{slotError}</span>
          </div>
        )}
        {slotSuccess && (
          <div className="mx-5 mb-3 px-3 py-2 bg-green-900/40 border border-green-700/50 rounded text-sm text-green-300 flex items-center gap-2">
            <i className="bi bi-check-circle-fill"></i>
            Shift structure saved successfully.
          </div>
        )}

        {/* Save / Discard buttons */}
        <div className="px-5 py-3 border-t border-gray-700/50 flex items-center gap-3">
          <button
            onClick={validateAndSave}
            disabled={!slotsDirty || saving}
            className={`px-4 py-2 text-sm font-medium rounded transition-colors flex items-center gap-2 ${
              slotsDirty
                ? "bg-cyan-600 hover:bg-cyan-500 text-white"
                : "bg-gray-700 text-gray-500 cursor-not-allowed"
            }`}
          >
            {saving ? <span className="animate-spin">&#x27F3;</span> : <i className="bi bi-check-lg"></i>}
            Save shift structure
          </button>
          {slotsDirty && (
            <button onClick={discardDraftChanges} className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors">
              Discard
            </button>
          )}
          {slotsDirty && (
            <span className="text-xs text-amber-400 ml-auto flex items-center gap-1">
              <i className="bi bi-exclamation-circle"></i> Unsaved changes
            </span>
          )}
        </div>
      </div>

      {/* ── Monthly calendar ─────────────────────────────── */}
      <div className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden">
        <div className="bg-gray-800 px-5 py-3 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h4 className="text-white font-semibold text-sm flex items-center gap-2">
              <i className="bi bi-calendar3 text-cyan-400"></i>Monthly Schedule
            </h4>
            <p className="text-gray-500 text-xs mt-0.5">Assign teams to each day&apos;s shifts</p>
          </div>
          <button onClick={copyPrevMonth} className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors" title="Copy assignments from previous month">
            <i className="bi bi-clipboard mr-1"></i>Copy prev. month
          </button>
        </div>

        {/* Month navigation */}
        <div className="px-5 py-2 border-b border-gray-700/50 flex items-center justify-between">
          <button onClick={prevMonth} className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors">
            <i className="bi bi-chevron-left"></i>
          </button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white font-medium">
              {firstOfMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </span>
            <button onClick={goToday} className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">Today</button>
          </div>
          <button onClick={nextMonth} className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors">
            <i className="bi bi-chevron-right"></i>
          </button>
        </div>

        {/* Calendar grid */}
        <div className="p-3">
          {/* Day-of-week header */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map(day => (
              <div key={day} className="text-center text-xs text-gray-500 font-medium py-1">{day}</div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-1">
            {/* Leading blanks */}
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <div key={`lb-${i}`} className="min-h-[60px]" />
            ))}

            {/* Actual days */}
            {monthDates.map(d => {
              const dateStr = toISODate(d);
              const today = isToday(d);
              const weekend = d.getDay() === 0 || d.getDay() === 6;
              const a = assignments[dateStr];
              return (
                <div
                  key={dateStr}
                  className={`rounded-md border p-1.5 min-h-[60px] transition-colors ${
                    today
                      ? "border-cyan-500/60 bg-cyan-900/15"
                      : weekend
                        ? "border-gray-700/40 bg-gray-800/30"
                        : "border-gray-700/30 bg-gray-800/20"
                  }`}
                >
                  <div className={`text-xs font-medium mb-1 ${today ? "text-cyan-300" : weekend ? "text-gray-500" : "text-gray-400"}`}>
                    {d.getDate()}
                  </div>
                  <div className="space-y-0.5">
                    {config.slots.map((slot, slotIdx) => {
                      const team = a?.slot_teams?.[slotIdx] ?? null;
                      return (
                        <select
                          key={slotIdx}
                          value={team ?? ""}
                          onChange={e => assign(dateStr, slotIdx, e.target.value || null)}
                          title={`${slot.name} (${fmtHour(slot.startHour)})`}
                          className={`w-full text-center text-[11px] font-semibold rounded py-0.5 px-0.5 border-0 cursor-pointer focus:outline-none focus:ring-1 focus:ring-cyan-500 transition-colors ${
                            team ? `${teamColor(team, config.teams)} text-white` : "bg-gray-700/50 text-gray-600"
                          }`}
                        >
                          <option value="" className="bg-gray-800 text-gray-400">{slot.name.charAt(0)}</option>
                          {config.teams.map(t => (
                            <option key={t} value={t} className="bg-gray-800 text-white">{t}</option>
                          ))}
                        </select>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Trailing blanks */}
            {Array.from({ length: trailingBlanks }).map((_, i) => (
              <div key={`tb-${i}`} className="min-h-[60px]" />
            ))}
          </div>
        </div>

        {/* Slot legend + quick actions */}
        <div className="px-5 py-3 border-t border-gray-700/50 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            {config.slots.map((slot, idx) => {
              const icon = SLOT_ICONS[idx % SLOT_ICONS.length];
              return (
                <span key={idx} className="text-xs text-gray-500 flex items-center gap-1">
                  <i className={`bi ${icon}`}></i>
                  Row {idx + 1} = {slot.name}
                </span>
              );
            })}
          </div>
          <button onClick={clearMonth} className="px-2.5 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors">
            Clear month
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main settings page
// ─────────────────────────────────────────────────────────────
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("machines");

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "machines",    label: "Machines",    icon: "bi-cpu-fill"       },
    { id: "thresholds",  label: "Targets",     icon: "bi-sliders"        },
    { id: "shifts",      label: "Shifts",      icon: "bi-calendar3"      },
    { id: "users",       label: "Users",       icon: "bi-people-fill"    },
  ];

  return (
    <div>
      {/* Page header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-bold text-white">Settings</h2>
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

      {/* ── SHIFTS ── */}
      {activeTab === "shifts" && <ShiftsTab />}

    </div>
  );
}
