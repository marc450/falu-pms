"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { format } from "date-fns";
import type { ProductionReading } from "@/lib/supabase";

interface ProductionChartProps {
  readings: ProductionReading[];
  metric: keyof ProductionReading;
  title: string;
  color?: string;
  yAxisLabel?: string;
}

export default function ProductionChart({
  readings,
  metric,
  title,
  color = "#2563eb",
  yAxisLabel,
}: ProductionChartProps) {
  const chartData = readings
    .slice()
    .sort(
      (a, b) =>
        new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime()
    )
    .map((r) => ({
      time: format(new Date(r.recorded_at), "HH:mm"),
      fullTime: format(new Date(r.recorded_at), "yyyy-MM-dd HH:mm"),
      value: r[metric] as number,
    }));

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-5">
      <h3 className="text-sm font-semibold text-slate-700 mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "#64748b" }}
            tickLine={false}
            label={
              yAxisLabel
                ? {
                    value: yAxisLabel,
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 11, fill: "#64748b" },
                  }
                : undefined
            }
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              fontSize: "12px",
            }}
            labelFormatter={(_, payload) =>
              payload?.[0]?.payload?.fullTime || ""
            }
          />
          <Legend />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={false}
            name={title}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
