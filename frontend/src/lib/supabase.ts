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

export interface LogFile {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
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

export async function fetchLogFiles(): Promise<LogFile[]> {
  const res = await fetch(`${API_BASE}/api/logs`, { headers: API_HEADERS });
  return res.json();
}

export async function fetchLogPreview(filename: string): Promise<CsvPreview> {
  const res = await fetch(`${API_BASE}/api/logs/preview/${filename}`, { headers: API_HEADERS });
  return res.json();
}

export function getLogDownloadUrl(path: string): string {
  return `${API_BASE}/api/logs/download/${path}`;
}

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}
