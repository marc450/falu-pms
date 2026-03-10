"use client";

interface KpiCardProps {
  title: string;
  value: string | number;
  unit?: string;
  trend?: "up" | "down" | "neutral";
  trendValue?: string;
  color?: "default" | "success" | "warning" | "danger";
}

const colorMap = {
  default: "border-l-blue-500",
  success: "border-l-green-500",
  warning: "border-l-amber-500",
  danger: "border-l-red-500",
};

export default function KpiCard({
  title,
  value,
  unit,
  trend,
  trendValue,
  color = "default",
}: KpiCardProps) {
  return (
    <div
      className={`bg-white rounded-lg shadow-sm border border-slate-200 border-l-4 ${colorMap[color]} p-5`}
    >
      <p className="text-sm font-medium text-slate-500 mb-1">{title}</p>
      <div className="flex items-baseline gap-2">
        <p className="text-2xl font-bold text-slate-900">{value}</p>
        {unit && <span className="text-sm text-slate-400">{unit}</span>}
      </div>
      {trend && trendValue && (
        <p
          className={`text-xs mt-2 ${
            trend === "up"
              ? "text-green-600"
              : trend === "down"
                ? "text-red-600"
                : "text-slate-400"
          }`}
        >
          {trend === "up" ? "\u25B2" : trend === "down" ? "\u25BC" : "\u25CF"}{" "}
          {trendValue}
        </p>
      )}
    </div>
  );
}
