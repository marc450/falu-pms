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
  current_swaps: number | null;   // DB column is current_swaps (legacy typo)
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
      "current_swaps, current_boxes, current_efficiency, current_reject, " +
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
  avgUptime: number;   // avg efficiency % across all machines in bucket (0 for idle hours)
  avgScrap: number;    // avg reject_rate % across all machines in bucket (0 for idle hours)
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
    .select("summary_date, total_swabs, total_boxes, total_discarded_swabs, machine_count, shift_count, reading_count, avg_uptime")
    .gte("summary_date", fmtDate(range.start))
    .lt("summary_date",  fmtDate(new Date()))
    .order("summary_date");

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    return { rows: [], granularity: "day", totalReadings: 0 };
  }

  const rows: FleetTrendRow[] = (data as Record<string, unknown>[]).map(r => {
    const totalSwabs     = Number(r.total_swabs)           || 0;
    const totalDiscarded = Number(r.total_discarded_swabs) || 0;
    return {
      date:         String(r.summary_date),
      // avg_uptime already includes idle machines (fixed in migration 046)
      avgUptime:    Number(r.avg_uptime)    || 0,
      // Scrap: volume-weighted ratio — discarded swabs / produced swabs
      avgScrap:     totalSwabs > 0
        ? Math.round((totalDiscarded / totalSwabs) * 1000) / 10
        : 0,
      totalBoxes:   Number(r.total_boxes)   || 0,
      totalSwabs,
      machineCount: Number(r.machine_count) || 0,
      readingCount: Number(r.reading_count) || 0,
      shiftCount:   Number(r.shift_count)   || 1,
    };
  });

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
    totalSwabs:     number;
    totalBoxes:     number;
    totalDiscarded: number;  // for volume-weighted scrap: discarded / produced
    machineIds:     Set<string>;
    shiftNumbers:   Set<number>;
    readingCount:   number;
    effSum:         number;  // weighted sum of avg_efficiency by reading_count
    weightTotal:    number;  // total reading_count weight (all machines, incl. idle)
  };

  const bucketMap = new Map<string, BucketAcc>();

  for (const row of rows_raw) {
    // Bucket key: "YYYY-MM-DDTHH" — matches fmtBucket used by the chart
    const bucketKey = row.plc_hour.slice(0, 13);

    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, {
        totalSwabs:     0,
        totalBoxes:     0,
        totalDiscarded: 0,
        machineIds:     new Set(),
        shiftNumbers:   new Set(),
        readingCount:   0,
        effSum:         0,
        weightTotal:    0,
      });
    }

    const b = bucketMap.get(bucketKey)!;
    b.totalSwabs     += Number(row.swabs_produced)  || 0;
    b.totalBoxes     += Number(row.boxes_produced)  || 0;
    b.totalDiscarded += Number(row.discarded_swabs) || 0;
    b.readingCount   += Number(row.reading_count)   || 0;
    b.machineIds.add(row.machine_id);
    b.shiftNumbers.add(row.shift_number);

    // Uptime: include ALL machines weighted by reading_count.
    // Idle machines report efficiency = 0 and must count toward the average.
    const w   = Number(row.reading_count)  || 1;
    const eff = Number(row.avg_efficiency) || 0;
    b.effSum      += eff * w;
    b.weightTotal += w;
  }

  // Fill every hour in the requested range so the chart has no gaps.
  // Hours with no machine data get zeroed-out entries (machines offline/idle).
  // Only include an hour if it has fully elapsed — the pg_cron aggregation job
  // runs at :05 past each hour, so a slot whose end time is still in the future
  // will have no DB row yet and must not appear as a false zero bar.
  const now         = new Date();
  const filledRows: FleetTrendRow[] = [];
  const cursor = new Date(range.start);
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor < range.end) {
    const key = cursor.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
    // Never render an hour that has not yet fully elapsed — the cron job
    // for that hour has not run yet so any data would be partial/incomplete.
    const hourEnd = new Date(cursor);
    hourEnd.setUTCHours(hourEnd.getUTCHours() + 1);
    if (hourEnd > now) {
      cursor.setUTCHours(cursor.getUTCHours() + 1);
      continue;
    }
    const b = bucketMap.get(key);
    if (b) {
      // Real data from hourly_analytics — include now that the hour is complete.
      filledRows.push({
        date:         key,
        avgUptime:    b.weightTotal > 0
          ? Math.round((b.effSum / b.weightTotal) * 10) / 10
          : 0,
        avgScrap:     b.totalSwabs > 0
          ? Math.round((b.totalDiscarded / b.totalSwabs) * 1000) / 10
          : 0,
        totalBoxes:   b.totalBoxes,
        totalSwabs:   b.totalSwabs,
        machineCount: b.machineIds.size,
        readingCount: b.readingCount,
        shiftCount:   b.shiftNumbers.size,
      });
    } else {
      // No DB row — emit a zero slot (hour is idle/offline).
      filledRows.push({
        date:         key,
        avgUptime:    0,
        avgScrap:     0,
        totalBoxes:   0,
        totalSwabs:   0,
        machineCount: 0,
        readingCount: 0,
        shiftCount:   0,
      });
    }
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }

  const totalReadings = filledRows.reduce((s, r) => s + r.readingCount, 0);
  return { rows: filledRows, granularity: "hour", totalReadings };
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
  knownTeams?: string[],
): Promise<ShiftAssignment[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("shift_assignments")
    .select("shift_date, slot_teams, day_team, night_team")
    .gte("shift_date", from)
    .lte("shift_date", to)
    .order("shift_date", { ascending: true });
  if (error) throw new Error(error.message);

  // Build a case-insensitive lookup map so legacy values like "Shift C"
  // are silently resolved to the canonical name "SHIFT C".
  const canonMap = new Map<string, string>();
  for (const t of (knownTeams ?? [])) canonMap.set(t.toUpperCase(), t);
  const canonicalise = (v: string | null): string | null => {
    if (!v) return v;
    return canonMap.get(v.toUpperCase()) ?? v;
  };

  // Normalize: old rows have day_team/night_team, new rows have slot_teams
  return (data ?? []).map((r: Record<string, unknown>) => {
    const raw = r.slot_teams as (string | null)[] | null;
    const hasSlotTeams = Array.isArray(raw) && raw.length > 0;
    const teams = hasSlotTeams
      ? raw!
      : [r.day_team as string | null, r.night_team as string | null];
    return {
      shift_date: r.shift_date as string,
      slot_teams: teams.map(canonicalise),
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

export async function fetchMachineShiftSummary(range: DateRange, slots: TimeSlot[] = slotsFromDuration(12, 7)): Promise<MachineShiftRow[]> {
  const sb = getSupabase();
  const slotCount    = slots.length;
  const durationHrs  = slotCount > 0 ? 24 / slotCount : 12;

  // Helper: local YYYY-MM-DD string (no UTC offset shift)
  const toLocalDate = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  // Determine which configured slot a save timestamp belongs to.
  // We completely ignore the PLC shift_number — it only signals that a shift
  // transition occurred. The actual slot is derived from the saved_at time
  // and the configured slot start hours.
  // Because saved_shift_logs are written at the END of a shift, saved_at right
  // at a slot boundary (e.g. 07:00 local) means the PREVIOUS slot just ended.
  // Subtracting 1 hour pushes the check into the correct slot.
  const resolveSlot = (savedAt: Date): number => {
    const localHour = savedAt.getHours(); // browser local time
    const adjusted  = (localHour - 1 + 24) % 24;
    for (let i = 0; i < slots.length; i++) {
      const start = slots[i].startHour;
      const end   = (start + durationHrs) % 24;
      if (start < end) {
        if (adjusted >= start && adjusted < end) return i;
      } else {
        // Wraps midnight (e.g. 19:00 – 07:00)
        if (adjusted >= start || adjusted < end) return i;
      }
    }
    return 0; // fallback
  };

  const logsResult = await sb
    .from("saved_shift_logs")
    .select("machine_id, machine_code, shift_number, production_time, produced_swabs, produced_boxes, discarded_swabs, efficiency, saved_at")
    .gte("saved_at", range.start.toISOString())
    .lte("saved_at", range.end.toISOString())
    .order("saved_at", { ascending: false });

  if (logsResult.error) throw new Error(logsResult.error.message);

  // Aggregate by (shift_date, slot_index, machine_id).
  // slot_index is derived from the saved_at timestamp and the configured time slots.
  // shift_date = calendar date when the slot STARTED (derived from local time).
  // The crew label comes from shift_assignments[shift_date].slot_teams[slotIndex].
  type Acc = {
    machineCode:  string;
    shiftDate:    string;
    slotIndex:    number;
    swabs:        number;
    boxes:        number;
    prodTimeSecs: number;
    discarded:    number;
    effSum:       number;
    effCount:     number;
  };
  const map = new Map<string, Acc>();

  for (const row of (logsResult.data ?? []) as Record<string, unknown>[]) {
    const savedAt   = new Date(String(row.saved_at));
    const slotIndex = resolveSlot(savedAt);

    // shift_date: calendar date when this slot STARTED (local time).
    // For the first slot (e.g. 07:00–19:00) this is the same calendar day.
    // For a night slot (e.g. 19:00–07:00) that saves after midnight, the slot
    // started the previous evening — subtract one day.
    const slotStart = slots[slotIndex].startHour;
    const localHour = savedAt.getHours();
    const startedYesterday = localHour < slotStart; // e.g. 06:00 local < 19:00 start
    const shiftDateObj = new Date(savedAt);
    if (startedYesterday) {
      shiftDateObj.setDate(shiftDateObj.getDate() - 1);
    }
    const shiftDate = toLocalDate(shiftDateObj);

    const key = `${shiftDate}|${slotIndex}|${String(row.machine_id)}`;
    if (!map.has(key)) {
      map.set(key, { machineCode: String(row.machine_code), shiftDate, slotIndex, swabs: 0, boxes: 0, prodTimeSecs: 0, discarded: 0, effSum: 0, effCount: 0 });
    }
    const b = map.get(key)!;
    b.swabs        += Number(row.produced_swabs)  || 0;
    b.boxes        += Number(row.produced_boxes)  || 0;
    b.prodTimeSecs += Number(row.production_time) || 0;
    b.discarded    += Number(row.discarded_swabs) || 0;
    const eff = Number(row.efficiency);
    if (eff > 0) { b.effSum += eff; b.effCount += 1; }
  }

  return Array.from(map.entries()).map(([key, b]) => {
    // key = "shiftDate|slotIndex|machineId"
    const machineId = key.split("|")[2];

    // Store the slot letter ("A", "B", …) so the display layer (teamNameForShift)
    // can resolve the crew name from shift_assignments at render time.
    // Using a raw slot letter here avoids "Shift SHIFT A" double-prefix bugs.
    const shiftLabel = String.fromCharCode(65 + b.slotIndex); // 0→"A", 1→"B", …

    const runHours = b.prodTimeSecs > 0 ? b.prodTimeSecs / 3600 : null;
    const buNorm   = runHours && runHours > 0
      ? Math.round(((b.swabs / 7200) / runHours * 12) * 10) / 10
      : null;
    return {
      work_day:       b.shiftDate,
      shift_label:    shiftLabel,
      machine_id:     machineId,
      machine_code:   b.machineCode,
      run_hours:      runHours != null ? Math.round(runHours * 100) / 100 : null,
      swabs_produced: b.swabs,
      boxes_produced: b.boxes,
      bu_normalized:  buNorm,
      avg_efficiency: b.effCount > 0 ? Math.round((b.effSum / b.effCount) * 10) / 10 : null,
      avg_scrap:      b.swabs > 0 ? Math.round((b.discarded / b.swabs) * 1000) / 10 : null,
    };
  }).sort((a, b) =>
    b.work_day.localeCompare(a.work_day)
    || a.shift_label.localeCompare(b.shift_label)
    || a.machine_code.localeCompare(b.machine_code)
  );
}

// ============================================
// SHIFT MECHANICS
// ============================================

// Maps crew name (e.g. "A") → user id
export type ShiftMechanics = Record<string, string | null>;

export async function fetchShiftMechanics(): Promise<ShiftMechanics> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "shift_mechanics")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.value ?? {}) as ShiftMechanics;
}

export async function saveShiftMechanics(mechanics: ShiftMechanics): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("app_settings")
    .upsert(
      { key: "shift_mechanics", value: mechanics as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw new Error(error.message);
}

// ============================================
// DOWNTIME ALERT CONFIG
// ============================================

export interface DowntimeAlertConfig {
  enabled: boolean;
  threshold_minutes: number;
  cooldown_minutes: number;
}

const DEFAULT_DOWNTIME_ALERT_CONFIG: DowntimeAlertConfig = {
  enabled: false,
  threshold_minutes: 10,
  cooldown_minutes: 30,
};

export async function fetchDowntimeAlertConfig(): Promise<DowntimeAlertConfig> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "downtime_alert_config")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { ...DEFAULT_DOWNTIME_ALERT_CONFIG, ...(data?.value as Partial<DowntimeAlertConfig> | null) };
}

export async function saveDowntimeAlertConfig(config: DowntimeAlertConfig): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("app_settings")
    .upsert(
      { key: "downtime_alert_config", value: config as unknown as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw new Error(error.message);
}

// ============================================
// FACTORY TIMEZONE
// ============================================

export async function fetchFactoryTimezone(): Promise<string> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", "factory_timezone")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.value as string) ?? "Europe/Zurich";
}

export async function saveFactoryTimezone(tz: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("app_settings")
    .upsert(
      { key: "factory_timezone", value: tz, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw new Error(error.message);
}

// ============================================
// USER MANAGEMENT
// ============================================

export interface UserProfile {
  id: string;
  email: string;
  role: "admin" | "viewer";
  first_name: string;
  last_name: string;
  whatsapp_phone: string | null;
  created_at: string;
}

export async function fetchUserProfiles(): Promise<UserProfile[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("user_profiles")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as UserProfile[];
}

export async function fetchCurrentUserProfile(userId: string): Promise<UserProfile | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("user_profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error || !data) return null;
  return data as UserProfile;
}

export async function updateUserRole(userId: string, role: "admin" | "viewer"): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("user_profiles")
    .update({ role })
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

export async function updateUserProfile(
  userId: string,
  fields: { first_name?: string; last_name?: string; whatsapp_phone?: string | null }
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb
    .from("user_profiles")
    .update(fields)
    .eq("id", userId);
  if (error) throw new Error(error.message);
}

export async function changePassword(newPassword: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

async function extractEdgeFnError(error: { message: string; context?: unknown }): Promise<string> {
  // Supabase client puts the Response object in error.context for non-2xx
  const ctx = error.context;
  if (ctx && typeof ctx === "object" && "json" in ctx && typeof (ctx as Response).json === "function") {
    try {
      const body = await (ctx as Response).json();
      if (body?.error) return body.error;
    } catch { /* fall through */ }
  }
  return error.message;
}

export async function invokeCreateUser(
  email: string,
  password: string,
  role: "admin" | "viewer",
  first_name: string,
  last_name: string,
  whatsapp_phone?: string
): Promise<{ id: string; email: string; role: string }> {
  const sb = getSupabase();
  const { data, error } = await sb.functions.invoke("create-user", {
    body: { email, password, role, first_name, last_name, whatsapp_phone: whatsapp_phone || null },
  });
  if (error) throw new Error(await extractEdgeFnError(error));
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function invokeDeleteUser(userId: string): Promise<void> {
  const sb = getSupabase();
  const { data, error } = await sb.functions.invoke("delete-user", {
    body: { userId },
  });
  if (error) throw new Error(await extractEdgeFnError(error));
  if (data?.error) throw new Error(data.error);
}

// ============================================
// PLC ERROR CODE LOOKUP
// ============================================
export interface PlcErrorCode {
  code: string;
  severity: string;
  description: string;
  cause: string | null;
  solution: string | null;
  info: string | null;
}

let _errorCodeCache: Record<string, PlcErrorCode> | null = null;

export async function fetchErrorCodeLookup(): Promise<Record<string, PlcErrorCode>> {
  if (_errorCodeCache) return _errorCodeCache;
  const sb = getSupabase();
  const { data, error } = await sb
    .from("plc_error_codes")
    .select("code, severity, description, cause, solution, info");
  if (error || !data) return {};
  _errorCodeCache = {};
  for (const row of data) {
    _errorCodeCache[row.code] = row as PlcErrorCode;
  }
  return _errorCodeCache;
}

// ============================================
// DOWNTIME ANALYTICS
// ============================================
export interface ErrorShiftSummaryRow {
  machine_id: string;
  machine_code: string;
  shift_date: string;
  plc_shift: number;
  error_code: string;
  occurrence_count: number;
  total_duration_secs: number;
}

export async function fetchErrorShiftSummary(range: DateRange): Promise<ErrorShiftSummaryRow[]> {
  const sb = getSupabase();
  const startStr = range.start.toISOString().slice(0, 10);
  const endStr   = range.end.toISOString().slice(0, 10);

  // Fetch from both tables in parallel:
  // 1. error_shift_summary (permanent, aggregated per shift, written at shift end)
  // 2. error_events (detailed, last 48h, written in real time)
  // This ensures the Downtime tab shows data immediately without waiting for a shift to end.
  // Paginate error_shift_summary (Supabase caps at 1000 rows per request)
  const PAGE_SIZE = 1000;
  const allSummaryRows: ErrorShiftSummaryRow[] = [];
  let from = 0;
  let hasMore = true;
  while (hasMore) {
    const { data } = await sb.from("error_shift_summary")
      .select("machine_id, machine_code, shift_date, plc_shift, error_code, occurrence_count, total_duration_secs")
      .gte("shift_date", startStr)
      .lte("shift_date", endStr)
      .order("shift_date", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    const page = (data ?? []) as ErrorShiftSummaryRow[];
    allSummaryRows.push(...page);
    hasMore = page.length === PAGE_SIZE;
    from += PAGE_SIZE;
  }

  // Fetch recent error_events (for real-time data not yet aggregated)
  const eventsRes = await sb.from("error_events")
    .select("machine_id, machine_code, error_code, started_at, duration_secs")
    .gte("started_at", range.start.toISOString())
    .lte("started_at", range.end.toISOString());

  const rows: ErrorShiftSummaryRow[] = allSummaryRows;

  // Build a set of dates already covered by error_shift_summary to avoid double counting
  const coveredKeys = new Set(rows.map(r => `${r.machine_code}|${r.shift_date}|${r.plc_shift}|${r.error_code}`));

  // Aggregate error_events into the same shape, but only for entries not already in the summary
  if (eventsRes.data && eventsRes.data.length > 0) {
    const eventAgg: Record<string, ErrorShiftSummaryRow> = {};
    for (const ev of eventsRes.data) {
      const date = (ev.started_at as string).slice(0, 10);
      // Use plc_shift=0 as a marker for "from live events" (not yet assigned to a shift)
      const key = `${ev.machine_code}|${date}|0|${ev.error_code}`;
      // Skip if this code+date is already covered by the aggregated summary (any shift)
      const alreadyCovered = [1, 2, 3].some(s => coveredKeys.has(`${ev.machine_code}|${date}|${s}|${ev.error_code}`));
      if (alreadyCovered) continue;

      if (!eventAgg[key]) {
        eventAgg[key] = {
          machine_id: ev.machine_id,
          machine_code: ev.machine_code,
          shift_date: date,
          plc_shift: 0,
          error_code: ev.error_code,
          occurrence_count: 0,
          total_duration_secs: 0,
        };
      }
      eventAgg[key].occurrence_count++;
      eventAgg[key].total_duration_secs += ev.duration_secs ?? 0;
    }
    rows.push(...Object.values(eventAgg));
  }

  return rows;
}
