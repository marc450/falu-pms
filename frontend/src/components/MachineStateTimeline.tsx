"use client";

import { useMemo, useState } from "react";
// @ts-expect-error react-dom types aren't installed; createPortal ships in react-dom at runtime
import { createPortal } from "react-dom";
import { format } from "date-fns";
import { parseBucketKey } from "./ProductionTrend";
import type { FleetTrendRow, ErrorEvent, PlcErrorCode } from "@/lib/supabase";

interface Props {
  rows: FleetTrendRow[];
  errorEvents: ErrorEvent[];
  errorLookup: Record<string, PlcErrorCode>;
}

// A bucket is classified as "running" when at least this share of its non-error
// time was production. Errors are overlaid precisely from error_events, so the
// bucket-level split only needs to decide running vs idle.
const RUNNING_THRESHOLD = 0.5;

const COLORS = {
  running: "#16a34a",
  idle:    "#eab308",
  error:   "#dc2626",
  empty:   "#1f2937",
};

type BucketSeg = {
  start: number;
  end: number;
  state: "running" | "idle" | "empty";
  productionSeconds: number;
  idleSeconds: number;
  errorSeconds: number;
};

type ErrSeg = {
  ev: ErrorEvent;
  start: number;
  end: number;
};

type Hover =
  | { kind: "bucket"; seg: BucketSeg; x: number; y: number }
  | { kind: "error";  seg: ErrSeg;    x: number; y: number };

function fmtSecs(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

export default function MachineStateTimeline({ rows, errorEvents, errorLookup }: Props) {
  const [hover, setHover] = useState<Hover | null>(null);

  const data = useMemo(() => {
    if (rows.length === 0) return null;
    const firstMs = parseBucketKey(rows[0].date).getTime();
    const lastMs  = parseBucketKey(rows[rows.length - 1].date).getTime();
    const bucketMs = rows.length >= 2
      ? parseBucketKey(rows[1].date).getTime() - firstMs
      : 5 * 60 * 1000;
    const endMs   = lastMs + bucketMs;
    const totalMs = endMs - firstMs;

    const segments: BucketSeg[] = rows.map(r => {
      const start = parseBucketKey(r.date).getTime();
      const end   = start + bucketMs;
      const prod  = r.productionSeconds ?? 0;
      const idle  = r.idleSeconds       ?? 0;
      const err   = r.errorSeconds      ?? 0;
      // PLC idle already includes error time, so the running-share denominator
      // strips the double-count the same way the corrected-uptime formula does.
      const runningSecs = prod;
      const idleOnlySecs = Math.max(0, idle - err);
      const knownSecs    = runningSecs + idleOnlySecs;
      let state: BucketSeg["state"];
      if (knownSecs <= 0)                                    state = "empty";
      else if (runningSecs / knownSecs >= RUNNING_THRESHOLD) state = "running";
      else                                                   state = "idle";
      return { start, end, state, productionSeconds: prod, idleSeconds: idle, errorSeconds: err };
    });

    const errs: ErrSeg[] = errorEvents
      .map(ev => {
        const s = new Date(ev.started_at).getTime();
        const e = ev.ended_at ? new Date(ev.ended_at).getTime() : Date.now();
        return { ev, start: Math.max(firstMs, s), end: Math.min(endMs, e) };
      })
      .filter(s => s.end > s.start);

    // Top-of-hour tick marks. Bucket keys are factory-wall-clock-as-UTC, so
    // `getUTCMinutes() === 0` already lands on factory hour boundaries for
    // whole-hour-offset zones — same convention the line chart uses.
    const hourTicks = rows
      .map(r => parseBucketKey(r.date).getTime())
      .filter(t => new Date(t).getUTCMinutes() === 0);
    // Downsample so labels don't overlap on narrow screens.
    const MAX_LABELS = 12;
    const step = Math.max(1, Math.ceil(hourTicks.length / MAX_LABELS));
    const tickPositions = hourTicks.filter((_, i) => i % step === 0);

    return { firstMs, endMs, totalMs, segments, errs, tickPositions };
  }, [rows, errorEvents]);

  if (!data) {
    return (
      <div className="text-gray-500 text-sm py-4">No state data for this period.</div>
    );
  }

  const pct = (t: number) => ((t - data.firstMs) / data.totalMs) * 100;

  // Aggregate state summary across the window (for the legend strip).
  const summary = data.segments.reduce(
    (acc, s) => {
      const span = (s.end - s.start) / 1000;
      const prod = Math.min(span, s.productionSeconds);
      const err  = Math.min(span, s.errorSeconds);
      const idle = Math.max(0, Math.min(span - prod, s.idleSeconds - s.errorSeconds));
      const empty = Math.max(0, span - prod - idle - err);
      acc.running += prod;
      acc.idle    += idle;
      acc.error   += err;
      acc.empty   += empty;
      return acc;
    },
    { running: 0, idle: 0, error: 0, empty: 0 },
  );
  const totalSec = summary.running + summary.idle + summary.error + summary.empty;
  const sharePct = (s: number) => totalSec > 0 ? (s / totalSec) * 100 : 0;

  const enterBucket = (seg: BucketSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover({ kind: "bucket", seg, x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  const enterError = (seg: ErrSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover({ kind: "error", seg, x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  const leave = () => setHover(null);

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Machine State Timeline</h3>
        <div className="flex gap-3 text-[11px] text-gray-400">
          <Legend color={COLORS.running} label={`Running ${sharePct(summary.running).toFixed(0)}%`} />
          <Legend color={COLORS.idle}    label={`Idle ${sharePct(summary.idle).toFixed(0)}%`} />
          <Legend color={COLORS.error}   label={`Error ${sharePct(summary.error).toFixed(0)}%`} />
        </div>
      </div>

      {/* The strip itself: full-width container, percent-positioned children. */}
      <div className="relative h-12 rounded overflow-hidden" style={{ background: COLORS.empty }}>
        {data.segments.map((seg, i) => (
          <div
            key={`b-${i}`}
            className="absolute top-0 bottom-0 cursor-pointer"
            style={{
              left:  `${pct(seg.start)}%`,
              width: `${pct(seg.end) - pct(seg.start)}%`,
              background: seg.state === "empty" ? "transparent" : COLORS[seg.state],
              opacity: 0.85,
            }}
            onMouseEnter={enterBucket(seg)}
            onMouseLeave={leave}
          />
        ))}
        {data.errs.map((seg, i) => {
          const w = pct(seg.end) - pct(seg.start);
          return (
            <div
              key={`e-${i}`}
              className="absolute top-0 bottom-0 flex items-center justify-center text-[10px] font-bold text-white cursor-pointer"
              style={{
                left:  `${pct(seg.start)}%`,
                width: `${Math.max(w, 0.15)}%`,
                background: COLORS.error,
                borderLeft:  "1px solid rgba(0,0,0,0.4)",
                borderRight: "1px solid rgba(0,0,0,0.4)",
              }}
              onMouseEnter={enterError(seg)}
              onMouseLeave={leave}
            >
              {w > 2.5 ? seg.ev.error_code : ""}
            </div>
          );
        })}
      </div>

      {/* X-axis tick labels — top of factory hour, downsampled. */}
      <div className="relative h-4 mt-1 text-[10px] text-gray-500">
        {data.tickPositions.map((t, i) => (
          <span
            key={i}
            className="absolute"
            style={{ left: `${pct(t)}%`, transform: "translateX(-50%)" }}
          >
            {format(new Date(t), "HH:mm")}
          </span>
        ))}
      </div>

      {hover && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-50 px-3 py-2 rounded-md shadow-lg text-xs"
          style={{
            left: hover.x,
            top:  hover.y,
            transform: "translateX(-50%)",
            background: "#111827",
            border: "1px solid #374151",
            color: "#e5e7eb",
            maxWidth: 320,
          }}
        >
          {hover.kind === "bucket" ? (
            <BucketTooltip seg={hover.seg} />
          ) : (
            <ErrorTooltip seg={hover.seg} lookup={errorLookup[hover.seg.ev.error_code]} />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

function BucketTooltip({ seg }: { seg: BucketSeg }) {
  const label = seg.state === "running" ? "Running" : seg.state === "idle" ? "Idle" : "No data";
  const color = seg.state === "running" ? COLORS.running : seg.state === "idle" ? COLORS.idle : "#6b7280";
  return (
    <div>
      <div className="text-gray-400 mb-1">
        {format(new Date(seg.start), "HH:mm")} – {format(new Date(seg.end), "HH:mm")}
      </div>
      <div className="font-semibold" style={{ color }}>{label}</div>
      <div className="text-gray-400 mt-1 space-y-0.5">
        <div>Production: <span className="text-gray-200">{fmtSecs(seg.productionSeconds)}</span></div>
        <div>Idle: <span className="text-gray-200">{fmtSecs(Math.max(0, seg.idleSeconds - seg.errorSeconds))}</span></div>
        {seg.errorSeconds > 0 && (
          <div>Error: <span className="text-gray-200">{fmtSecs(seg.errorSeconds)}</span></div>
        )}
      </div>
    </div>
  );
}

function ErrorTooltip({ seg, lookup }: { seg: ErrSeg; lookup: PlcErrorCode | undefined }) {
  const ongoing = !seg.ev.ended_at;
  const durSec  = Math.max(0, (seg.end - seg.start) / 1000);
  return (
    <div>
      <div className="font-semibold text-red-400">{seg.ev.error_code}</div>
      {lookup?.description && (
        <div className="text-gray-200 mt-0.5">{lookup.description}</div>
      )}
      <div className="text-gray-400 mt-1">
        {format(new Date(seg.start), "HH:mm:ss")} – {ongoing ? "ongoing" : format(new Date(seg.end), "HH:mm:ss")}
      </div>
      <div className="text-gray-400">Duration: <span className="text-gray-200">{fmtSecs(durSec)}</span></div>
      {lookup?.cause && (
        <div className="text-gray-400 mt-1">Cause: <span className="text-gray-200">{lookup.cause}</span></div>
      )}
      {lookup?.operator_guidance && (
        <div className="text-gray-400 mt-1">Operator: <span className="text-gray-200">{lookup.operator_guidance}</span></div>
      )}
    </div>
  );
}
