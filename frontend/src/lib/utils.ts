/**
 * Format minutes to HH:MM string (matches developer's FormatMinutesToTime)
 */
export function formatMinutesToTime(minutes: number | undefined | null): string {
  if (!minutes || minutes === 0) return "00:00:00";
  const totalSeconds = Math.round(minutes * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
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
    case "run":
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
 * Map raw MQTT status values to display labels
 */
export function formatStatus(status?: string): string {
  switch (status?.toLowerCase()) {
    case "run":
    case "running":  return "Running";
    case "idle":     return "Idle";
    case "error":    return "Error";
    case "offline":  return "Offline";
    default:         return "Offline";
  }
}
