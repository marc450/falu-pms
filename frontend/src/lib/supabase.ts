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
  Swaps: number;
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
  ProducedSwaps: number;
  PackagedSwaps: number;
  ProducedBoxes: number;
  ProducedBoxesLayerPlus: number;
  DisgardedSwaps: number;
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
}

// ============================================
// SUPABASE DIRECT QUERIES
// ============================================

export interface RegisteredMachine {
  machine_code: string;
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
}

export async function fetchRegisteredMachines(): Promise<RegisteredMachine[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("machines")
    .select(
      "machine_code, status, error_message, active_shift, speed, current_swaps, current_boxes, current_efficiency, current_reject, last_sync_status, last_sync_shift, cell_id, cell_position"
    )
    .order("machine_code");

  if (error) throw new Error(error.message);
  return data ?? [];
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

export async function fetchBrokerSettings() {
  const res = await fetch(`${API_BASE}/api/settings/broker`, { headers: API_HEADERS });
  return res.json();
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}
