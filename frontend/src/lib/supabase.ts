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
  // Full payload fields spread by bridge from combined cloud/Shift message
  ProductionTime?: number;
  IdleTime?: number;
  ErrorTime?: number;
  CottonTears?: number;
  MissingSticks?: number;
  FoultyPickups?: number;
  OtherErrors?: number;
  ProducedSwabs?: number;
  PackagedSwabs?: number;
  DisgardedSwabs?: number;    // PLC field (typo in PLC spec, preserved as-is)
  DiscardedSwabs?: number;    // backward-compat alias
  ProducedBoxes?: number;
  ProducedBoxesLayerPlus?: number;
  Timestamp?: string;
}

export interface ShiftDataMessage {
  Machine?: string;
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
  Save?: boolean;
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
  /** Unix ms timestamp of the last status transition (from bridge). */
  statusSince?: number;
  /** Idle time in minutes for current shift — PLC-provided, converted from seconds. */
  idleTimeCalc?: number;
  /** Error time in minutes for current shift — PLC-provided, converted from seconds. */
  errorTimeCalc?: number;
  /** Active PLC error codes for this machine (cleared when machine returns to Running). */
  activeErrors?: number[];
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
  id: string;
  machine_code: string;           // PLC UID — never changes
  name: string;                   // user-editable display name (defaults to machine_code)
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
      "id, machine_code, name, packing_format, status, error_message, active_shift, speed, current_swaps, current_boxes, current_efficiency, current_reject, last_sync_status, last_sync_shift, cell_id, cell_position, efficiency_good, efficiency_mediocre, scrap_good, scrap_mediocre, bu_target, bu_mediocre, speed_target"
    )
    .eq("hidden", false)
    .order("machine_code");

  if (error) throw new Error(error.message);
  return data ?? [];
}

// Lightweight version: only the columns that change every few seconds.
// Used by the polling interval to minimise Supabase egress.
export interface MachineLiveData {
  id: string;
  machine_code: string;
  status: string | null;
  error_message: string | null;
  active_shift: number | null;
  speed: number | null;
  current_swabs: number | null;
  current_boxes: number | null;
  current_efficiency: number | null;
  current_reject: number | null;
  last_sync_status: string | null;
  last_sync_shift: number | null;
}

export async function fetchMachineLiveData(): Promise<MachineLiveData[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("machines")
    .select(
      "id, machine_code, status, error_message, active_shift, speed, " +
      "current_swabs, current_boxes, current_efficiency, current_reject, " +
      "last_sync_status, last_sync_shift"
    )
    .eq("hidden", false)
    .order("machine_code");

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MachineLiveData[];
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

export async function updateMachineTargetsBulk(
  machine_codes: string[],
  field: keyof MachineTargets,
  value: number | null
): Promise<void> {
  if (machine_codes.length === 0) return;
  const sb = getSupabase();
  const { error } = await sb
    .from("machines")
    .update({ [field]: value })
    .in("machine_code", machine_codes);
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

export async function renameMachine(machine_code: string, name: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("machines")
    .update({ name: name.trim() || machine_code })
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
    .neq("id", "00000000-0000-0000-0000-000000000000")
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
// ANALYTICS
// ============================================

export interface DateRange {
  start: Date;
  end: Date;
}

export interface FleetTrendRow {
  date: string;        // "YYYY-MM-DD" (daily) or "YYYY-MM-DDTHH" (hourly)
  avgUptime: number;   // avg efficiency % across all machines in bucket
  avgScrap: number;    // avg reject_rate % across all machines in bucket
  totalBoxes: number;  // sum of per-(machine_id, shift_number) MAX produced_boxes
  totalSwabs: number;  // sum of per-(machine_id, shift_number) MAX produced_swabs
  machineCount: number;// unique machines with readings in bucket
  readingCount: number;// total readings in bucket
  shiftCount: number;  // distinct shift_numbers with data in this bucket
}

export interface FleetTrendResult {
  rows:          FleetTrendRow[];
  granularity:   "hour" | "day";
  totalReadings: number;
}

export async function fetchFleetTrend(range: DateRange): Promise<FleetTrendResult> {
  const sb = getSupabase();

  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // daily_fleet_summary has one row per calendar day — max ~365 rows/year.
  // A plain SELECT is safe; the PostgREST row limit is never a concern.
  // Exclude today (incomplete day) by using lt(today).
  const { data, error } = await sb
    .from("daily_fleet_summary")
    .select("summary_date, total_swabs, total_boxes, machine_count, shift_count, reading_count, avg_uptime, avg_scrap")
    .gte("summary_date", fmtDate(range.start))
    .lt("summary_date",  fmtDate(new Date()))
    .order("summary_date");

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    return { rows: [], granularity: "day", totalReadings: 0 };
  }

  const rows: FleetTrendRow[] = (data as Record<string, unknown>[]).map(r => ({
    date:         String(r.summary_date),
    avgUptime:    Number(r.avg_uptime)    || 0,
    avgScrap:     Number(r.avg_scrap)     || 0,
    totalBoxes:   Number(r.total_boxes)   || 0,
    totalSwabs:   Number(r.total_swabs)   || 0,
    machineCount: Number(r.machine_count) || 0,
    readingCount: Number(r.reading_count) || 0,
    shiftCount:   Number(r.shift_count)   || 1,
  }));

  const totalReadings = rows.reduce((s, r) => s + r.readingCount, 0);
  return { rows, granularity: "day", totalReadings };
}

// ============================================
// HOURLY ANALYTICS (pre-aggregated 24h view)
// ============================================

interface HourlyAnalyticsRow {
  plc_hour:                string;
  machine_id:              string;
  shift_number:            number;
  swabs_produced:          number;
  boxes_produced:          number;
  production_time_seconds: number;
  idle_time_seconds:       number;
  error_time_seconds:      number;
  discarded_swabs:         number;
  reading_count:           number;
  avg_efficiency:          number;
  avg_scrap_rate:          number;
}

export async function fetchHourlyAnalytics(range: DateRange): Promise<FleetTrendResult> {
  const sb = getSupabase();

  const { data, error } = await sb
    .from("hourly_analytics")
    .select(
      "plc_hour, machine_id, shift_number, swabs_produced, boxes_produced, " +
      "production_time_seconds, idle_time_seconds, error_time_seconds, " +
      "discarded_swabs, reading_count, avg_efficiency, avg_scrap_rate"
    )
    .gte("plc_hour", range.start.toISOString())
    .lt("plc_hour",  range.end.toISOString())
    .order("plc_hour");

  if (error) throw new Error(error.message);
  const rows_raw = (data as unknown) as HourlyAnalyticsRow[];
  if (!rows_raw || rows_raw.length === 0) {
    return { rows: [], granularity: "hour", totalReadings: 0 };
  }

  // Group by plc_hour bucket — aggregate across all machines and shifts
  type BucketAcc = {
    totalSwabs:   number;
    totalBoxes:   number;
    machineIds:   Set<string>;
    shiftNumbers: Set<number>;
    readingCount: number;
    effSum:       number;   // weighted sum of avg_efficiency by reading_count
    scrapSum:     number;   // weighted sum of avg_scrap_rate by reading_count
    weightTotal:  number;   // total weight for the above sums
  };

  const bucketMap = new Map<string, BucketAcc>();

  for (const row of rows_raw) {
    // Bucket key: "YYYY-MM-DDTHH" — matches fmtBucket used by the chart
    const bucketKey = row.plc_hour.slice(0, 13);

    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, {
        totalSwabs:   0,
        totalBoxes:   0,
        machineIds:   new Set(),
        shiftNumbers: new Set(),
        readingCount: 0,
        effSum:       0,
        scrapSum:     0,
        weightTotal:  0,
      });
    }

    const b = bucketMap.get(bucketKey)!;
    b.totalSwabs   += Number(row.swabs_produced)  || 0;
    b.totalBoxes   += Number(row.boxes_produced)  || 0;
    b.readingCount += Number(row.reading_count)   || 0;
    b.machineIds.add(row.machine_id);
    b.shiftNumbers.add(row.shift_number);

    const w   = Number(row.reading_count)  || 1;
    const eff = Number(row.avg_efficiency) || 0;
    const sc  = Number(row.avg_scrap_rate) || 0;
    if (eff > 0) {
      b.effSum      += eff * w;
      b.weightTotal += w;
    }
    b.scrapSum += sc * w;
  }

  const rows: FleetTrendRow[] = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, b]) => ({
      date:         bucket,
      avgUptime:    b.weightTotal > 0 ? Math.round((b.effSum   / b.weightTotal) * 10) / 10 : 0,
      avgScrap:     b.weightTotal > 0 ? Math.round((b.scrapSum / b.weightTotal) * 10) / 10 : 0,
      totalBoxes:   b.totalBoxes,
      totalSwabs:   b.totalSwabs,
      machineCount: b.machineIds.size,
      readingCount: b.readingCount,
      shiftCount:   b.shiftNumbers.size,
    }));

  const totalReadings = rows.reduce((s, r) => s + r.readingCount, 0);
  return { rows, granularity: "hour", totalReadings };
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

// ─── Shift assignments ──────────────────────────────────────────────────────

export interface TimeSlot {
  name: string;       // e.g. "Day", "Afternoon", "Night"
  startHour: number;  // 0–23
}

export interface ShiftConfig {
  teams: string[];                        // e.g. ["A", "B", "C", "D"]
  slots: TimeSlot[];                      // derived from shiftDurationHours + firstShiftStartHour
  shiftDurationHours: 6 | 8 | 12;        // user-selected shift length
  firstShiftStartHour: number;            // 0–23, start hour of the first slot
  plannedDowntimeMinutes: number;         // per-shift planned downtime
}

/** Generate evenly-spaced slots starting at firstStartHour for a given shift duration. */
export function slotsFromDuration(hours: 6 | 8 | 12, firstStartHour: number = 0): TimeSlot[] {
  const count = 24 / hours;
  const letters = ["A", "B", "C", "D"];
  return Array.from({ length: count }, (_, i) => ({
    name:      `Shift ${letters[i] ?? i + 1}`,
    startHour: (firstStartHour + i * hours) % 24,
  }));
}

/**
 * Map a raw RPC shift label ('A' | 'B' | …) to a human-readable slot name.
 * Used as a fallback when no team assignment exists for the specific day.
 */
export function shiftLabelToName(
  label: string,
  slots: TimeSlot[],
): string {
  const index = label === "A" ? 0 : label === "B" ? 1 : label === "C" ? 2 : 3;
  return slots[index]?.name ?? `Shift ${label}`;
}

/**
 * Return the team name assigned to a specific work-day + shift slot.
 *
 * The PLC sends shift_number 1 / 2 / 3 which the RPC maps to slot labels
 * 'A' / 'B' / 'C' / 'D' based on time-of-day.  The shift_assignments
 * calendar stores which TEAM worked each slot on each date.
 *
 * This function joins those two sources so analytics can display
 * e.g. "SHIFT C" instead of the generic "Shift A".
 *
 * Falls back to the configured slot name when no assignment exists.
 */
export function teamNameForShift(
  workDay:     string,
  shiftLabel:  string,
  assignments: Record<string, ShiftAssignment>,
  slots:       TimeSlot[],
): string {
  const slotIndex = ["A", "B", "C", "D"].indexOf(shiftLabel);
  if (slotIndex !== -1) {
    const team = assignments[workDay]?.slot_teams?.[slotIndex];
    if (team) return team;
  }
  return shiftLabelToName(shiftLabel, slots);
}

export const DEFAULT_SHIFT_CONFIG: ShiftConfig = {
  teams: ["A", "B", "C", "D"],
  shiftDurationHours: 12,
  firstShiftStartHour: 6,
  slots: slotsFromDuration(12, 6),
  plannedDowntimeMinutes: 0,
};

/** Derive per-shift length in minutes from slot count. */
export function shiftLengthFromSlots(slots: TimeSlot[]): number {
  return slots.length > 0 ? Math.round(24 * 60 / slots.length) : 480;
}

export interface ShiftAssignment {
  shift_date: string;              // "YYYY-MM-DD"
  slot_teams: (string | null)[];   // index matches config.slots index
}

export async function fetchShiftConfig(): Promise<ShiftConfig> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "shift_config")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return DEFAULT_SHIFT_CONFIG;
  const val = data.value as Record<string, unknown>;

  // Derive shiftDurationHours — read stored value or back-calculate from slot count
  const rawDuration = val.shiftDurationHours as number | undefined;
  const shiftDurationHours: 6 | 8 | 12 =
    rawDuration === 6 || rawDuration === 8 || rawDuration === 12
      ? rawDuration
      : (() => {
          // Legacy: infer from slot count (2 slots → 12h, 3 → 8h, 4 → 6h)
          const legacyCount = Array.isArray(val.slots) ? (val.slots as unknown[]).length : 2;
          return legacyCount === 4 ? 6 : legacyCount === 3 ? 8 : 12;
        })();

  // Read first shift start hour; back-compat: legacy configs stored startHour in slots[0]
  const rawFirstStart = val.firstShiftStartHour as number | undefined;
  const firstShiftStartHour: number =
    rawFirstStart !== undefined && rawFirstStart >= 0 && rawFirstStart <= 23
      ? rawFirstStart
      : (() => {
          const legacySlots = val.slots as TimeSlot[] | undefined;
          return Array.isArray(legacySlots) && legacySlots.length > 0
            ? (legacySlots[0].startHour ?? 6)
            : 6;
        })();

  // Always regenerate slots from canonical duration + start hour so they stay in sync
  const slots = slotsFromDuration(shiftDurationHours, firstShiftStartHour);

  return {
    teams:                (val.teams as string[]) ?? DEFAULT_SHIFT_CONFIG.teams,
    slots,
    shiftDurationHours,
    firstShiftStartHour,
    plannedDowntimeMinutes: (val.plannedDowntimeMinutes as number) ?? 0,
  };
}

/**
 * Save shift config and sync shiftLengthMinutes + plannedDowntimeMinutes
 * into threshold_bu so all BU calculations across the app stay correct.
 */
export async function saveShiftConfig(config: ShiftConfig): Promise<void> {
  const sb = getSupabase();
  const opts = { onConflict: "key" } as const;

  // Save shift config
  const { error } = await sb
    .from("app_settings")
    .upsert({ key: "shift_config", value: config as unknown as Record<string, unknown> }, opts);
  if (error) throw new Error(error.message);

  // Sync derived shiftLengthMinutes + plannedDowntimeMinutes into threshold_bu
  const shiftMins = shiftLengthFromSlots(config.slots);
  const { data: buRow } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "threshold_bu")
    .maybeSingle();
  const buVal = (buRow?.value as Record<string, unknown>) ?? {};
  await sb.from("app_settings").upsert({
    key: "threshold_bu",
    value: { ...buVal, shiftLengthMinutes: shiftMins, plannedDowntimeMinutes: config.plannedDowntimeMinutes },
    updated_at: new Date().toISOString(),
  }, opts);
}

export interface SavedShiftLog {
  shift_number:             number;
  production_time:          number;
  idle_time:                number;
  cotton_tears:             number;
  missing_sticks:           number;
  faulty_pickups:           number;
  other_errors:             number;
  produced_swabs:           number;
  packaged_swabs:           number;
  produced_boxes:           number;
  produced_boxes_layer_plus: number;
  discarded_swabs:          number;
  efficiency:               number;
  reject_rate:              number;
  saved_at:                 string;
}

/**
 * Fetch the most recent saved shift log for each shift number for a machine.
 * Returns one row per shift_number (the latest save for that shift).
 */
export async function fetchSavedShiftLogs(machineCode: string): Promise<SavedShiftLog[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("saved_shift_logs")
    .select("shift_number, production_time, idle_time, cotton_tears, missing_sticks, faulty_pickups, other_errors, produced_swabs, packaged_swabs, produced_boxes, produced_boxes_layer_plus, discarded_swabs, efficiency, reject_rate, saved_at")
    .eq("machine_code", machineCode)
    .order("saved_at", { ascending: false })
    .limit(20); // grab recent rows then deduplicate by shift_number in JS
  if (error) throw new Error(error.message);
  if (!data) return [];
  // Keep only the most recent row per shift_number
  const seen = new Set<number>();
  const result: SavedShiftLog[] = [];
  for (const row of data) {
    if (!seen.has(row.shift_number)) {
      seen.add(row.shift_number);
      result.push(row as SavedShiftLog);
    }
  }
  return result;
}

/** Fetch shift assignments for a date range (inclusive). */
export async function fetchShiftAssignments(
  from: string,
  to: string,
): Promise<ShiftAssignment[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("shift_assignments")
    .select("shift_date, slot_teams, day_team, night_team")
    .gte("shift_date", from)
    .lte("shift_date", to)
    .order("shift_date", { ascending: true });
  if (error) throw new Error(error.message);

  // Normalize: old rows have day_team/night_team, new rows have slot_teams
  return (data ?? []).map((r: Record<string, unknown>) => {
    const raw = r.slot_teams as (string | null)[] | null;
    const hasSlotTeams = Array.isArray(raw) && raw.length > 0;
    return {
      shift_date: r.shift_date as string,
      slot_teams: hasSlotTeams
        ? raw!
        : [r.day_team as string | null, r.night_team as string | null],
    };
  });
}

/** Upsert a single day's shift assignment. */
export async function saveShiftAssignment(
  shiftDate: string,
  slotTeams: (string | null)[],
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("shift_assignments")
    .upsert(
      {
        shift_date: shiftDate,
        slot_teams: slotTeams,
        // Also write to legacy columns for backward compat
        day_team: slotTeams[0] ?? null,
        night_team: slotTeams[1] ?? null,
      },
      { onConflict: "shift_date" },
    );
  if (error) throw new Error(error.message);
}

/** Bulk-upsert shift assignments for multiple days. */
export async function saveShiftAssignmentsBulk(
  assignments: ShiftAssignment[],
): Promise<void> {
  if (assignments.length === 0) return;
  const sb = getSupabase();
  const { error } = await sb
    .from("shift_assignments")
    .upsert(
      assignments.map(a => ({
        shift_date: a.shift_date,
        slot_teams: a.slot_teams,
        day_team: a.slot_teams[0] ?? null,
        night_team: a.slot_teams[1] ?? null,
      })),
      { onConflict: "shift_date" },
    );
  if (error) throw new Error(error.message);
}

// ============================================
// MACHINE SHIFT SUMMARY
// ============================================

export interface MachineShiftRow {
  work_day:       string;   // 'YYYY-MM-DD'
  shift_label:    string;   // 'A' | 'B' | 'C' | 'D' (based on configured shift slots)
  machine_id:     string;
  machine_code:   string;
  run_hours:      number | null;
  swabs_produced: number;
  boxes_produced: number;
  bu_normalized:  number | null;
  avg_efficiency: number | null;
  avg_scrap:      number | null;
}

export async function fetchMachineShiftSummary(range: DateRange): Promise<MachineShiftRow[]> {
  const sb = getSupabase();

  // Today's calendar date as YYYY-MM-DD
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const rangeStartStr = `${range.start.getFullYear()}-${String(range.start.getMonth() + 1).padStart(2, "0")}-${String(range.start.getDate()).padStart(2, "0")}`;

  // 1) Pre-aggregated data for past days (fast indexed table scan).
  // .range(0, 49999) overrides the default PostgREST 1000-row cap.
  const preAggPromise = sb
    .from("daily_machine_summary")
    .select("summary_date, shift_label, machine_id, machine_code, swabs_produced, boxes_produced, production_time_seconds, avg_efficiency, avg_scrap_rate")
    .gte("summary_date", rangeStartStr)
    .lt("summary_date", todayStr)
    .order("summary_date", { ascending: false })
    .range(0, 49999);

  // 2) Live RPC for today only (scans just one day of shift_readings)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const liveRpcPromise = range.end >= todayStart
    ? sb.rpc("get_machine_shift_summary", {
        p_range_start: todayStart.toISOString(),
        p_range_end:   range.end.toISOString(),
      })
    : Promise.resolve({ data: [], error: null });

  const [preAggResult, liveResult] = await Promise.all([preAggPromise, liveRpcPromise]);

  if (preAggResult.error) throw new Error(preAggResult.error.message);
  if (liveResult.error) throw new Error(liveResult.error.message);

  // Map pre-aggregated rows to MachineShiftRow
  const historicalRows: MachineShiftRow[] = (preAggResult.data ?? []).map((r: Record<string, unknown>) => {
    const runHours = Number(r.production_time_seconds) > 0 ? Number(r.production_time_seconds) / 3600 : null;
    const swabs = Number(r.swabs_produced) || 0;
    const buNorm = runHours && runHours > 0
      ? Math.round(((swabs / 7200) / runHours * 12) * 10) / 10
      : null;
    return {
      work_day:       String(r.summary_date),
      shift_label:    String(r.shift_label),
      machine_id:     String(r.machine_id),
      machine_code:   String(r.machine_code),
      run_hours:      runHours != null ? Math.round(runHours * 100) / 100 : null,
      swabs_produced: swabs,
      boxes_produced: Number(r.boxes_produced) || 0,
      bu_normalized:  buNorm,
      avg_efficiency: r.avg_efficiency != null ? Number(r.avg_efficiency) : null,
      avg_scrap:      r.avg_scrap_rate != null ? Number(r.avg_scrap_rate) : null,
    };
  });

  // Map live RPC rows (same shape as before)
  const liveRows: MachineShiftRow[] = (liveResult.data ?? []).map((r: Record<string, unknown>) => ({
    work_day:       r.work_day       as string,
    shift_label:    r.shift_label    as string,
    machine_id:     r.machine_id     as string,
    machine_code:   r.machine_code   as string,
    run_hours:      r.run_hours != null ? Number(r.run_hours) : null,
    swabs_produced: Number(r.swabs_produced) || 0,
    boxes_produced: Number(r.boxes_produced) || 0,
    bu_normalized:  r.bu_normalized  != null ? Number(r.bu_normalized)  : null,
    avg_efficiency: r.avg_efficiency != null ? Number(r.avg_efficiency) : null,
    avg_scrap:      r.avg_scrap      != null ? Number(r.avg_scrap)      : null,
  }));

  // Merge and sort: newest first, then shift label, then machine
  return [...historicalRows, ...liveRows].sort((a, b) =>
    b.work_day.localeCompare(a.work_day)
    || a.shift_label.localeCompare(b.shift_label)
    || a.machine_code.localeCompare(b.machine_code)
  );
}
