"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
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

// A bucket counts as "running" when at least this share of its non-error time
// was production. Errors are overlaid precisely from error_events, so the
// bucket-level split only needs to decide running vs idle.
const RUNNING_THRESHOLD = 0.5;

const COLORS = {
  running: "#16a34a",
  idle:    "#eab308",
  error:   "#dc2626",
  empty:   "#1f2937",
};

const LABEL_LANE_HEIGHT = 14;
const LABEL_CHAR_PX     = 6.5;
const LABEL_PADDING_PX  = 8;
const MIN_LANE_GAP_PX   = 4;

type State = "running" | "idle" | "empty";

// A merged background segment: adjacent same-state buckets coalesce into one
// rectangle so the strip reads as continuous intervals, not 5-min ticks.
type MergedSeg = {
  start: number;
  end: number;
  state: State;
  productionSeconds: number;
  idleSeconds: number;
  errorSeconds: number;
};

type ErrSeg = {
  ev: ErrorEvent;
  start: number;
  end: number;
};

type PackedLabel = {
  ev: ErrorEvent;
  centerPx: number;
  widthPx: number;
  lane: number;
};

type Hover =
  | { kind: "bucket"; seg: MergedSeg; x: number; y: number; flipUp: boolean }
  | { kind: "error";  seg: ErrSeg;    x: number; y: number; flipUp: boolean };

const TOOLTIP_HEIGHT_EST = 220;
const TOOLTIP_MARGIN     = 8;

function anchor(rect: DOMRect): { x: number; y: number; flipUp: boolean } {
  const x = rect.left + rect.width / 2;
  const below = rect.bottom + 6;
  if (below + TOOLTIP_HEIGHT_EST + TOOLTIP_MARGIN > window.innerHeight) {
    return { x, y: rect.top - 6, flipUp: true };
  }
  return { x, y: below, flipUp: false };
}

function fmtSecs(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m - h * 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

// Place labels in horizontal lanes so adjacent ones don't overlap. Lower lane
// index = closer to the strip (= shorter leader line). Mirrors the bracket
// packing logic in ProductionTrend.tsx, simplified for percent-based input.
function packLabels(events: ErrSeg[], firstMs: number, totalMs: number, containerPx: number): { items: PackedLabel[]; laneCount: number } {
  if (containerPx <= 0 || events.length === 0) return { items: [], laneCount: 0 };
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const lanes: number[] = [];
  const items: PackedLabel[] = [];
  for (const e of sorted) {
    const centerMs = (e.start + e.end) / 2;
    const centerPx = ((centerMs - firstMs) / totalMs) * containerPx;
    const widthPx  = e.ev.error_code.length * LABEL_CHAR_PX + LABEL_PADDING_PX;
    const startPx  = centerPx - widthPx / 2;
    const endPx    = centerPx + widthPx / 2;
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] + MIN_LANE_GAP_PX <= startPx) {
        lane = i;
        lanes[i] = endPx;
        break;
      }
    }
    if (lane === -1) {
      lanes.push(endPx);
      lane = lanes.length - 1;
    }
    items.push({ ev: e.ev, centerPx, widthPx, lane });
  }
  return { items, laneCount: lanes.length };
}

// Hook: returns the live pixel width of the referenced element.
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const update = () => setW(el.getBoundingClientRect().width);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export default function MachineStateTimeline({ rows, errorEvents, errorLookup }: Props) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [stripRef, stripWidthPx] = useElementWidth<HTMLDivElement>();

  const data = useMemo(() => {
    if (rows.length === 0) return null;
    const firstMs = parseBucketKey(rows[0].date).getTime();
    const lastMs  = parseBucketKey(rows[rows.length - 1].date).getTime();
    const bucketMs = rows.length >= 2
      ? parseBucketKey(rows[1].date).getTime() - firstMs
      : 5 * 60 * 1000;
    const endMs   = lastMs + bucketMs;
    const totalMs = endMs - firstMs;

    // Classify each raw bucket, then merge consecutive same-state buckets.
    const raw = rows.map(r => {
      const start = parseBucketKey(r.date).getTime();
      const end   = start + bucketMs;
      const prod  = r.productionSeconds ?? 0;
      const idle  = r.idleSeconds       ?? 0;
      const err   = r.errorSeconds      ?? 0;
      // PLC idle already includes error time, so the running-share denominator
      // strips the double-count the same way the corrected-uptime formula does.
      const idleOnlySecs = Math.max(0, idle - err);
      const knownSecs    = prod + idleOnlySecs;
      let state: State;
      if (knownSecs <= 0)                              state = "empty";
      else if (prod / knownSecs >= RUNNING_THRESHOLD)  state = "running";
      else                                             state = "idle";
      return { start, end, state, productionSeconds: prod, idleSeconds: idle, errorSeconds: err };
    });

    const merged: MergedSeg[] = [];
    for (const r of raw) {
      const last = merged[merged.length - 1];
      if (last && last.state === r.state && last.end === r.start) {
        last.end = r.end;
        last.productionSeconds += r.productionSeconds;
        last.idleSeconds       += r.idleSeconds;
        last.errorSeconds      += r.errorSeconds;
      } else {
        merged.push({ ...r });
      }
    }

    const errs: ErrSeg[] = errorEvents
      .map(ev => {
        const s = new Date(ev.started_at).getTime();
        const e = ev.ended_at ? new Date(ev.ended_at).getTime() : Date.now();
        return { ev, start: Math.max(firstMs, s), end: Math.min(endMs, e) };
      })
      .filter(s => s.end > s.start);

    // Top-of-hour ticks (factory wall clock — bucket keys are stored UTC-naive
    // so getUTCMinutes()===0 lands on factory hour boundaries).
    const hourTicks = rows
      .map(r => parseBucketKey(r.date).getTime())
      .filter(t => new Date(t).getUTCMinutes() === 0);
    const MAX_LABELS = 12;
    const tickStep = Math.max(1, Math.ceil(hourTicks.length / MAX_LABELS));
    const tickPositions = hourTicks.filter((_, i) => i % tickStep === 0);

    // Rank errors by total downtime for the chip summary.
    const byCode = new Map<string, { code: string; count: number; totalSec: number }>();
    for (const e of errs) {
      const code = e.ev.error_code;
      const cur  = byCode.get(code) ?? { code, count: 0, totalSec: 0 };
      cur.count    += 1;
      cur.totalSec += (e.end - e.start) / 1000;
      byCode.set(code, cur);
    }
    const errorRanking = Array.from(byCode.values()).sort((a, b) => b.totalSec - a.totalSec);

    return { firstMs, endMs, totalMs, segments: merged, errs, tickPositions, errorRanking };
  }, [rows, errorEvents]);

  // Per-render pack: depends on container width, so it has to live outside the
  // data useMemo (or take width as an input). Keep cheap; runs on every resize.
  const labelPack = useMemo(() => {
    if (!data) return { items: [], laneCount: 0 };
    return packLabels(data.errs, data.firstMs, data.totalMs, stripWidthPx);
  }, [data, stripWidthPx]);

  if (!data) {
    return <div className="text-gray-500 text-sm py-4">No state data for this period.</div>;
  }

  const pct = (t: number) => ((t - data.firstMs) / data.totalMs) * 100;
  const pxToPct = (px: number) => stripWidthPx > 0 ? (px / stripWidthPx) * 100 : 0;

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

  const enterBucket = (seg: MergedSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    setHover({ kind: "bucket", seg, ...anchor(e.currentTarget.getBoundingClientRect()) });
  };
  const enterError = (seg: ErrSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    setHover({ kind: "error", seg, ...anchor(e.currentTarget.getBoundingClientRect()) });
  };
  const leave = () => setHover(null);

  const labelAreaHeight = labelPack.laneCount > 0
    ? labelPack.laneCount * LABEL_LANE_HEIGHT + 6
    : 0;

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

      {/* Error code labels above the strip, packed into lanes with leader
          lines down to each error block. Only renders once we've measured
          the container width (so packing has real pixel widths to work with). */}
      {labelAreaHeight > 0 && stripWidthPx > 0 && (
        <div
          className="relative"
          style={{ height: labelAreaHeight, marginBottom: 2 }}
        >
          {labelPack.items.map((item, i) => {
            const labelBottomPx = (item.lane + 1) * LABEL_LANE_HEIGHT;
            const leaderHeight  = labelAreaHeight - labelBottomPx;
            return (
              <span key={`lbl-${i}`}>
                <span
                  className="absolute text-[10px] font-semibold text-red-400 whitespace-nowrap select-none"
                  style={{
                    left: `${pxToPct(item.centerPx)}%`,
                    top:  item.lane * LABEL_LANE_HEIGHT,
                    transform: "translateX(-50%)",
                    lineHeight: `${LABEL_LANE_HEIGHT}px`,
                  }}
                >
                  {item.ev.error_code}
                </span>
                <span
                  className="absolute"
                  style={{
                    left: `${pxToPct(item.centerPx)}%`,
                    top:  labelBottomPx,
                    width: 1,
                    height: leaderHeight,
                    background: "rgba(239, 68, 68, 0.55)",
                  }}
                />
              </span>
            );
          })}
        </div>
      )}

      {/* The strip itself. */}
      <div
        ref={stripRef}
        className="relative h-10 rounded overflow-hidden"
        style={{ background: COLORS.empty }}
      >
        {data.segments.map((seg, i) => (
          <div
            key={`b-${i}`}
            className="absolute top-0 bottom-0 cursor-pointer"
            style={{
              left:  `${pct(seg.start)}%`,
              width: `${pct(seg.end) - pct(seg.start)}%`,
              background: seg.state === "empty" ? "transparent" : COLORS[seg.state],
              opacity: 0.9,
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
              className="absolute top-0 bottom-0 cursor-pointer"
              style={{
                left:  `${pct(seg.start)}%`,
                width: `${Math.max(w, 0.15)}%`,
                background: COLORS.error,
              }}
              onMouseEnter={enterError(seg)}
              onMouseLeave={leave}
            />
          );
        })}
      </div>

      {/* Hour ticks. */}
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

      {/* Ranked error summary — turns the colored blocks into an action list. */}
      {data.errorRanking.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.errorRanking.map(r => {
            const desc = errorLookup[r.code]?.description;
            return (
              <span
                key={r.code}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-red-100"
                style={{ background: "rgba(220, 38, 38, 0.18)", border: "1px solid rgba(220, 38, 38, 0.4)" }}
                title={desc ?? ""}
              >
                <span className="font-semibold">{r.code}</span>
                {desc && <span className="text-red-200/80 truncate max-w-[180px]">{desc}</span>}
                <span className="text-red-200/70">× {r.count}</span>
                <span className="text-red-200/70">· {fmtSecs(r.totalSec)}</span>
              </span>
            );
          })}
        </div>
      )}

      {hover && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-50 px-3 py-2 rounded-md shadow-lg text-xs"
          style={{
            left: hover.x,
            top:  hover.y,
            transform: hover.flipUp ? "translate(-50%, -100%)" : "translateX(-50%)",
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

function BucketTooltip({ seg }: { seg: MergedSeg }) {
  const label = seg.state === "running" ? "Running" : seg.state === "idle" ? "Idle" : "No data";
  const color = seg.state === "running" ? COLORS.running : seg.state === "idle" ? COLORS.idle : "#6b7280";
  return (
    <div>
      <div className="text-gray-400 mb-1">
        {format(new Date(seg.start), "HH:mm")} – {format(new Date(seg.end), "HH:mm")}
        <span className="text-gray-500"> · {fmtSecs((seg.end - seg.start) / 1000)}</span>
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
