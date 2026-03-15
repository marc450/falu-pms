import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (!url || !key) {
      throw new Error("Supabase credentials not configured");
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// Legacy export - use getSupabase() instead for lazy initialization
export const supabase = null as unknown as SupabaseClient;

// ============================================
// TYPES (matching MQTT payload structure)
// ============================================

export interface MachineStatusMessage {
  Machine: string;
  Status: string;
  Error: string;
  ActShift: number;
  Speed: number;
  Swabs: number;
  Boxes: number;
  Efficiency: number;
  Reject: number;
}

export interface ShiftDataMessage {
  Machine: string;
  Shift: number;
  ProductionTime: number;
  IdleTime: number;
  CottonTears: number;
  MissingSticks: number;
  FoultyPickups: number;
  OtherErrors: number;
  ProducedSwabs: number;
  PackagedSwabs: number;
  ProducedBoxes: number;
  ProducedBoxesLayerPlus: number;
  DiscardedSwabs: number;
  Efficiency: number;
  Reject: number;
  Save: boolean;
}

export interface MachineData {
  machine: string;
  machineStatus?: MachineStatusMessage;
  shift1?: ShiftDataMessage;
  shift2?: ShiftDataMessage;
  shift3?: ShiftDataMessage;
  total?: ShiftDataMessage;
  lastSyncStatus?: string;
  lastSyncShift?: string;
  lastRequestShift?: string;
}

export interface BridgeState {
  machines: Record<string, MachineData>;
  mqttConnected: boolean;
  currentShiftNumber: number;
  shiftStartedAt: number; // Unix ms timestamp when current shift began
}

// ============================================
// SUPABASE DIRECT QUERIES
// ============================================

// ============================================
// PACKING FORMATS
// ============================================

export const PACKING_FORMATS = {
  blister: "Blisters",
  box:     "Boxes",
  bag:     "Bags",
  bulk:    "Bulk",
} as const;

export type PackingFormat = keyof typeof PACKING_FORMATS;

export interface RegisteredMachine {
  machine_code: string;
  packing_format: PackingFormat | null;
  status: string | null;
  error_message: string | null;
  active_shift: number | null;
  speed: number | null;
  current_swaps: number | null;
  current_boxes: number | null;
  current_efficiency: number | null;
  current_reject: number | null;
  last_sync_status: string | null;
  last_sync_shift: string | null;
  cell_id: string | null;
  cell_position: number | null;
  // Per-machine targets (null = not set)
  efficiency_good: number | null;
  efficiency_mediocre: number | null;
  scrap_good: number | null;
  scrap_mediocre: number | null;
  bu_target: number | null;
  bu_mediocre: number | null;
  speed_target: number | null;
}

export async function fetchRegisteredMachines(): Promise<RegisteredMachine[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("machines")
    .select(
      "machine_code, packing_format, status, error_message, active_shift, speed, current_swaps, current_boxes, current_efficiency, current_reject, last_sync_status, last_sync_shift, cell_id, cell_position, efficiency_good, efficiency_mediocre, scrap_good, scrap_mediocre, bu_target, bu_mediocre, speed_target"
    )
    .eq("hidden", false)
    .order("machine_code");

  if (error) throw new Error(error.message);
  return data ?? [];
}

export interface MachineTargets {
  efficiency_good: number | null;
  efficiency_mediocre: number | null;
  scrap_good: number | null;
  scrap_mediocre: number | null;
  bu_target: number | null;
  bu_mediocre: number | null;
  speed_target: number | null;
}

export async function fetchMachineTargets(machine_code: string): Promise<MachineTargets> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("machines")
    .select("efficiency_good, efficiency_mediocre, scrap_good, scrap_mediocre, bu_target, bu_mediocre, speed_target")
    .eq("machine_code", machine_code)
    .single();
  if (error) throw new Error(error.message);
  return data as MachineTargets;
}

export async function updateMachineTargets(
  machine_code: string,
  targets: MachineTargets
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("machines")
    .update(targets)
    .eq("machine_code", machine_code);
  if (error) throw new Error(error.message);
}

export async function updateMachinePackingFormat(
  machine_code: string,
  packing_format: PackingFormat | null
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("machines")
    .update({ packing_format: packing_format || null })
    .eq("machine_code", machine_code);
  if (error) throw new Error(error.message);
}

// ============================================
// PRODUCTION CELLS
// ============================================

export interface ProductionCell {
  id: string;
  name: string;
  position: number;
}

export async function fetchProductionCells(): Promise<ProductionCell[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("production_cells")
    .select("id, name, position")
    .order("position");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createProductionCell(name: string, position: number): Promise<ProductionCell> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("production_cells")
    .insert({ name, position })
    .select("id, name, position")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function renameProductionCell(id: string, name: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from("production_cells").update({ name }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteProductionCell(id: string): Promise<void> {
  // Machines in this cell will have cell_id set to null via ON DELETE SET NULL
  const sb = getSupabase();
  const { error } = await sb.from("production_cells").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function assignMachineToCell(machineCode: string, cellId: string | null): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("machines")
    .update({ cell_id: cellId })
    .eq("machine_code", machineCode);
  if (error) throw new Error(error.message);
}

// ============================================
// THRESHOLDS
// ============================================

export interface Thresholds {
  efficiency: { good: number; mediocre: number }; // good ≥ good, mediocre ≥ mediocre, bad < mediocre
  scrap:      { good: number; mediocre: number }; // good ≤ good, mediocre ≤ mediocre, bad > mediocre
  bu:         { good: number; mediocre: number; shiftLengthMinutes: number; plannedDowntimeMinutes: number }; // good ≥ good, mediocre ≥ mediocre, bad < mediocre
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  efficiency: { good: 85,  mediocre: 70 },
  scrap:      { good: 2,   mediocre: 5  },
  bu:         { good: 1400, mediocre: 800, shiftLengthMinutes: 480, plannedDowntimeMinutes: 0 },
};

export async function fetchThresholds(): Promise<Thresholds> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("key, value")
    .in("key", ["threshold_efficiency", "threshold_scrap", "threshold_bu"]);
  if (error) throw new Error(error.message);
  const map = Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
  const buRaw = map["threshold_bu"] ?? {};
  return {
    efficiency: map["threshold_efficiency"] ?? DEFAULT_THRESHOLDS.efficiency,
    scrap:      map["threshold_scrap"]      ?? DEFAULT_THRESHOLDS.scrap,
    // Merge with defaults so new fields (e.g. plannedDowntimeMinutes) appear
    // on existing DB rows that pre-date the field being added.
    bu: { ...DEFAULT_THRESHOLDS.bu, ...buRaw },
  };
}

export async function saveThresholds(t: Thresholds): Promise<void> {
  const sb = getSupabase();
  const opts = { onConflict: "key" } as const;
  await Promise.all([
    sb.from("app_settings").upsert({ key: "threshold_efficiency", value: t.efficiency, updated_at: new Date().toISOString() }, opts),
    sb.from("app_settings").upsert({ key: "threshold_scrap",      value: t.scrap,      updated_at: new Date().toISOString() }, opts),
    sb.from("app_settings").upsert({ key: "threshold_bu",         value: t.bu,         updated_at: new Date().toISOString() }, opts),
  ]);
}

export function applyEfficiencyColor(val: number | null, t: Thresholds) {
  if (val === null) return { text: "text-gray-500", border: "border-gray-700", bg: "bg-gray-800/50" };
  if (val >= t.efficiency.good)    return { text: "text-green-400",  border: "border-green-700",  bg: "bg-green-900/10"  };
  if (val >= t.efficiency.mediocre) return { text: "text-yellow-400", border: "border-yellow-700", bg: "bg-yellow-900/10" };
  return                                   { text: "text-red-400",    border: "border-red-700",    bg: "bg-red-900/10"    };
}

export function applyScrapColor(val: number | null, t: Thresholds) {
  if (val === null) return { text: "text-gray-500", border: "border-gray-700", bg: "bg-gray-800/50" };
  if (val <= t.scrap.good)    return { text: "text-green-400",  border: "border-green-700",  bg: "bg-green-900/10"  };
  if (val <= t.scrap.mediocre) return { text: "text-yellow-400", border: "border-yellow-700", bg: "bg-yellow-900/10" };
  return                              { text: "text-red-400",    border: "border-red-700",    bg: "bg-red-900/10"    };
}

export function applyBuColor(val: number | null, t: Thresholds) {
  if (val === null) return { text: "text-gray-500", border: "border-gray-700", bg: "bg-gray-800/50" };
  if (val >= t.bu.good)    return { text: "text-green-400",  border: "border-green-700",  bg: "bg-green-900/10"  };
  if (val >= t.bu.mediocre) return { text: "text-yellow-400", border: "border-yellow-700", bg: "bg-yellow-900/10" };
  return                           { text: "text-red-400",    border: "border-red-700",    bg: "bg-red-900/10"    };
}

// Per-machine threshold helpers (accept nullable thresholds — null means no target set)
export function applyMachineEfficiencyColor(val: number | null, good: number | null, mediocre: number | null) {
  if (val === null || good === null || mediocre === null) return { text: "text-gray-300" };
  if (val >= good)    return { text: "text-green-400"  };
  if (val >= mediocre) return { text: "text-yellow-400" };
  return                     { text: "text-red-400"    };
}

export function applyMachineScrapColor(val: number | null, good: number | null, mediocre: number | null) {
  if (val === null || good === null || mediocre === null) return { text: "text-gray-300",   border: "border-gray-700"   };
  if (val <= good)    return { text: "text-green-400",  border: "border-green-700"  };
  if (val <= mediocre) return { text: "text-yellow-400", border: "border-yellow-700" };
  return                     { text: "text-red-400",    border: "border-red-700"    };
}

// Run rate color: rate = projected ÷ target (e.g. 1.05 = 105 %)
export function applyRunRateColor(rate: number | null): { text: string; border: string } {
  if (rate === null) return { text: "text-gray-500", border: "border-gray-700" };
  if (rate >= 1.0)   return { text: "text-green-400",  border: "border-green-600"  };
  if (rate >= 0.80)  return { text: "text-yellow-400", border: "border-yellow-600" };
  return                    { text: "text-red-400",    border: "border-red-600"    };
}

// Speed color for individual machine rows — on target shows plain white (row rule: no green in rows)
export function applyMachineSpeedColor(val: number | null, target: number | null): { text: string } {
  if (val === null || !target || target <= 0) return { text: "text-gray-300" };
  if (val >= target) return { text: "text-white"   };  // at/above target → white
  return             { text: "text-red-400" };          // below target → red
}

// Speed color for cell header — on target shows green (headers keep traffic-light coloring)
export function applySpeedHeaderColor(avgSpeed: number | null, avgTarget: number | null): { text: string } {
  if (avgSpeed === null || !avgTarget || avgTarget <= 0) return { text: "text-gray-500" };
  if (avgSpeed >= avgTarget) return { text: "text-green-400" };  // at/above target → green
  return                            { text: "text-red-400"   };  // below target → red
}

// BU run rate color using per-machine mediocre threshold
// projected / target = rate; mediocreTarget is the absolute BU floor (optional)
export function applyBuRunRateColor(
  projected: number | null,
  target: number | null,
  mediocreTarget: number | null
): { text: string; border: string } {
  if (projected === null || target === null || target <= 0)
    return { text: "text-gray-500", border: "border-gray-700" };
  const rate = projected / target;
  if (rate >= 1.0)
    return { text: "text-green-400", border: "border-green-600" };
  if (mediocreTarget !== null && mediocreTarget > 0) {
    // Use absolute mediocre BU threshold when configured
    if (projected >= mediocreTarget)
      return { text: "text-yellow-400", border: "border-yellow-600" };
  } else {
    // Fallback: 80 % of target = mediocre
    if (rate >= 0.80)
      return { text: "text-yellow-400", border: "border-yellow-600" };
  }
  return { text: "text-red-400", border: "border-red-600" };
}

export async function updateCellOrder(
  entries: { code: string; position: number }[]
): Promise<void> {
  const sb = getSupabase();
  await Promise.all(
    entries.map(({ code, position }) =>
      sb.from("machines")
        .update({ cell_position: position })
        .eq("machine_code", code)
        .then(({ error }) => { if (error) throw new Error(error.message); })
    )
  );
}

// ============================================
// BRIDGE API CLIENT
// ============================================

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Include ngrok bypass header so the free-tier warning page is skipped
const API_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
  "ngrok-skip-browser-warning": "true",
};

export async function fetchMachines(): Promise<BridgeState> {
  const res = await fetch(`${API_BASE}/api/machines`, { headers: API_HEADERS });
  if (!res.ok) throw new Error("Failed to fetch machines");
  return res.json();
}

export async function fetchMachine(code: string): Promise<MachineData> {
  const res = await fetch(`${API_BASE}/api/machines/${code}`, { headers: API_HEADERS });
  if (!res.ok) throw new Error("Machine not found");
  return res.json();
}

export async function requestShiftData(machineCode: string, shift: number): Promise<void> {
  await fetch(`${API_BASE}/api/machines/${machineCode}/request-shift`, {
    method: "POST",
    headers: API_HEADERS,
    body: JSON.stringify({ shift }),
  });
}

export async function deleteMachine(machineCode: string): Promise<void> {
  // Soft-delete: set hidden = true instead of hard-deleting.
  // Hard-deleting would cascade into shift_readings and saved_shift_logs
  // and permanently destroy production history.
  const sb = getSupabase();
  const { error } = await sb
    .from("machines")
    .update({ hidden: true })
    .eq("machine_code", machineCode);
  if (error) throw new Error(error.message);
}

export async function deleteMachineFromBridge(machineCode: string): Promise<void> {
  // Non-fatal — bridge might be offline or not yet restarted
  await fetch(`${API_BASE}/api/machines/${machineCode}`, {
    method: "DELETE",
    headers: API_HEADERS,
  }).catch(() => {});
}

export async function fetchBrokerSettings() {
  const res = await fetch(`${API_BASE}/api/settings/broker`, { headers: API_HEADERS });
  return res.json();
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}
