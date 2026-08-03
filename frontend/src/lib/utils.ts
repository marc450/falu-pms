/**
 * Format seconds to HH:MM:SS string. Use this for PLC counters (the bridge
 * mirrors ProductionTime / IdleTime / ErrorTime as raw seconds), so the
 * caller doesn't have to convert before formatting.
 */
export function formatSecondsToTime(seconds: number | undefined | null): string {
  if (!seconds || seconds === 0) return "00:00:00";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Format file size in human readable form
 */
export function formatFileSize(bytes: number): string {
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Get status badge color class
 */
export function getStatusColor(status?: string): {
  bg: string;
  text: string;
  dot: string;
} {
  switch (status?.toLowerCase()) {
    case "running":
      return { bg: "bg-green-900/30", text: "text-green-400", dot: "bg-green-400" };
    case "idle":
      return { bg: "bg-slate-700/50", text: "text-slate-300", dot: "bg-slate-400" };
    case "error":
      return { bg: "bg-red-900/30", text: "text-red-400", dot: "bg-red-400" };
    default:
      return { bg: "bg-slate-700/50", text: "text-slate-500", dot: "bg-slate-500" };
  }
}

/**
 * Compact "time in current state" label (e.g. "45s", "5m 03s", "2h 14m").
 * sinceMs is the bridge-tracked statusSince transition timestamp (unix ms).
 */
export function formatStateDuration(sinceMs: number, nowMs: number): string {
  const elapsed = Math.max(0, Math.floor((nowMs - sinceMs) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  if (elapsed < 3600) {
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/**
 * Map raw MQTT status values to display labels
 */
export function formatStatus(status?: string): string {
  switch (status?.toLowerCase()) {
    case "running":  return "Running";
    case "idle":     return "Idle";
    case "error":    return "Error";
    case "offline":  return "Offline";
    default:         return "Offline";
  }
}
