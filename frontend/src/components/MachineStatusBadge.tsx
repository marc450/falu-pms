"use client";

interface MachineStatusBadgeProps {
  status: "online" | "offline" | "maintenance";
}

const statusStyles = {
  online: "bg-green-100 text-green-800",
  offline: "bg-slate-100 text-slate-600",
  maintenance: "bg-amber-100 text-amber-800",
};

const statusDot = {
  online: "bg-green-500",
  offline: "bg-slate-400",
  maintenance: "bg-amber-500",
};

export default function MachineStatusBadge({
  status,
}: MachineStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${statusStyles[status]}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${statusDot[status]}`}
      ></span>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
