"use client";

import { format } from "date-fns";
import type { Alert } from "@/lib/supabase";

interface AlertsPanelProps {
  alerts: Alert[];
  onAcknowledge?: (alertId: string) => void;
}

const severityStyles = {
  info: "border-l-blue-400 bg-blue-50",
  warning: "border-l-amber-400 bg-amber-50",
  critical: "border-l-red-400 bg-red-50",
};

const severityLabel = {
  info: "text-blue-700",
  warning: "text-amber-700",
  critical: "text-red-700",
};

export default function AlertsPanel({
  alerts,
  onAcknowledge,
}: AlertsPanelProps) {
  if (alerts.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">
          Active Alerts
        </h3>
        <p className="text-sm text-slate-400">No active alerts</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700">Active Alerts</h3>
        <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
          {alerts.length}
        </span>
      </div>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {alerts.map((alert) => (
          <div
            key={alert.id}
            className={`border-l-4 rounded-r-lg p-3 ${severityStyles[alert.severity]}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <span
                  className={`text-xs font-semibold uppercase ${severityLabel[alert.severity]}`}
                >
                  {alert.severity}
                </span>
                <p className="text-sm text-slate-700 mt-0.5">
                  {alert.message}
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  {format(new Date(alert.created_at), "MMM d, HH:mm")}
                </p>
              </div>
              {onAcknowledge && (
                <button
                  onClick={() => onAcknowledge(alert.id)}
                  className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1 border border-slate-300 rounded hover:bg-white transition-colors shrink-0"
                >
                  Acknowledge
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
