import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ============================================
// TYPE DEFINITIONS
// ============================================

export interface Machine {
  id: string;
  machine_code: string;
  name: string;
  location: string | null;
  line: string | null;
  status: "online" | "offline" | "maintenance";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ProductionReading {
  id: string;
  machine_id: string;
  recorded_at: string;
  production_time: number | null;
  downtime: number | null;
  machine_speed: number | null;
  cotton_tears: number;
  produced_swabs: number;
  packed_swabs: number;
  produced_boxes: number;
  produced_boxes_extra_layer: number;
  rejected_swabs: number;
  faulty_pickups: number;
  error_stops: number;
  efficiency: number | null;
  scrap_rate: number | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
}

export interface Alert {
  id: string;
  machine_id: string;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  message: string | null;
  acknowledged: boolean;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

// ============================================
// DATA FETCHING FUNCTIONS
// ============================================

export async function getMachines(): Promise<Machine[]> {
  const { data, error } = await supabase
    .from("machines")
    .select("*")
    .order("machine_code");

  if (error) throw error;
  return data || [];
}

export async function getLatestReadings(
  machineId?: string,
  limit: number = 50
): Promise<ProductionReading[]> {
  let query = supabase
    .from("production_readings")
    .select("*")
    .order("recorded_at", { ascending: false })
    .limit(limit);

  if (machineId) {
    query = query.eq("machine_id", machineId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getReadingsInRange(
  machineId: string,
  from: string,
  to: string
): Promise<ProductionReading[]> {
  const { data, error } = await supabase
    .from("production_readings")
    .select("*")
    .eq("machine_id", machineId)
    .gte("recorded_at", from)
    .lte("recorded_at", to)
    .order("recorded_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function getActiveAlerts(): Promise<Alert[]> {
  const { data, error } = await supabase
    .from("alerts")
    .select("*")
    .eq("acknowledged", false)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function acknowledgeAlert(
  alertId: string,
  userName: string
): Promise<void> {
  const { error } = await supabase
    .from("alerts")
    .update({
      acknowledged: true,
      acknowledged_by: userName,
      acknowledged_at: new Date().toISOString(),
    })
    .eq("id", alertId);

  if (error) throw error;
}
