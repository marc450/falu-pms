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

// Match the Good / Mediocre / Poor zone tints used by the Avg Scrap and Avg
// Uptime charts above so the timeline reads as the same colour family.
const COLORS = {
  running: "#4ade80",
  idle:    "#eab308",
  error:   "#ef4444",
  empty:   "#1f2937",
};

// Diagonal stripe pattern used for "no signal" buckets — windows where the
// machine sent no readings, so we can't tell whether it was running or not.
const EMPTY_PATTERN = "repeating-linear-gradient(45deg, #4b5563 0 5px, #1f2937 5px 10px)";

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

// An error block in the timeline. Carries every ErrorEvent active during
// its time range so the tooltip can list concurrent codes. Errors are
// rendered IN the same band as bucket segments (no overlay) and CARVE the
// adjacent running/idle stretches around them — so what you see on the
// strip is the actual machine state at every moment, not a "running stretch
// with errors painted on top".
type ErrorSeg = {
  start: number;
  end: number;
  events: ErrorEvent[];
};

// One visual block in the timeline band. Either a bucket-derived
// running/idle/empty segment, or an error span carved from an underlying
// bucket. Bucket segments here have already had their time inside any
// error span removed; their production/idle counts are scaled
// proportionally from the parent bucket merge.
type VisualSeg =
  | { kind: "bucket"; seg: MergedSeg }
  | { kind: "error";  seg: ErrorSeg };

type Hover =
  | { kind: "bucket"; seg: MergedSeg; x: number; y: number }
  | { kind: "error";  seg: ErrorSeg;  x: number; y: number };

const TOOLTIP_MAX_WIDTH  = 320;
const TOOLTIP_HEIGHT_EST = 220;
const TOOLTIP_MARGIN     = 8;
const TOOLTIP_GAP        = 6;

// Anchor the tooltip's bottom-left corner above the hovered block, with its
// left edge lined up with the start of the block. Viewport clamping happens
// after the tooltip mounts (in useLayoutEffect) using the real rendered
// width, so a small tooltip near the right edge stays aligned with the
// block instead of being yanked left by a worst-case width estimate.
function anchor(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left, y: rect.top - TOOLTIP_GAP };
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

export default function MachineStateTimeline({ rows, errorEvents, errorLookup }: Props) {
  const [hover, setHover] = useState<Hover | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  // After the tooltip mounts at its ideal anchor point, measure the real
  // element and only shift it inward when it would actually overflow the
  // viewport — using a worst-case 320px estimate upfront made narrow
  // tooltips slide off the start of right-edge blocks even when they
  // would have fit fine.
  useLayoutEffect(() => {
    if (!hover || !tooltipRef.current) return;
    const w = tooltipRef.current.offsetWidth;
    const h = tooltipRef.current.offsetHeight;
    let newX = hover.x;
    let newY = hover.y;
    if (newX + w + TOOLTIP_MARGIN > window.innerWidth) {
      newX = window.innerWidth - w - TOOLTIP_MARGIN;
    }
    if (newX < TOOLTIP_MARGIN) newX = TOOLTIP_MARGIN;
    if (newY - h < TOOLTIP_MARGIN) newY = TOOLTIP_MARGIN + h;
    if (newX !== hover.x || newY !== hover.y) {
      setHover(prev => prev ? { ...prev, x: newX, y: newY } : null);
    }
  }, [hover]);

  const data = useMemo(() => {
    if (rows.length === 0) return null;
    const firstMs = parseBucketKey(rows[0].date).getTime();
    const lastMs  = parseBucketKey(rows[rows.length - 1].date).getTime();
    const bucketMs = rows.length >= 2
      ? parseBucketKey(rows[1].date).getTime() - firstMs
      : 5 * 60 * 1000;
    const endMs   = lastMs + bucketMs;
    const totalMs = endMs - firstMs;

    // Each 5-min bucket is split proportionally into a running sub-segment and
    // an idle sub-segment based on its production / pure-idle seconds. We
    // don't know the actual chronological order inside the bucket, so we put
    // production first and idle second — but this guarantees that *any* idle
    // time, no matter how small, renders as its own visible amber strip
    // instead of getting hidden inside a "mostly running" classification.
    const raw: MergedSeg[] = [];
    for (const r of rows) {
      const bStart = parseBucketKey(r.date).getTime();
      const bEnd   = bStart + bucketMs;
      const prod   = r.productionSeconds ?? 0;
      const idle   = r.idleSeconds       ?? 0;
      const err    = r.errorSeconds      ?? 0;
      // PLC idle already includes error time; subtract so the same second
      // doesn't pull both the idle and the error strips wider.
      const idleOnly   = Math.max(0, idle - err);
      const totalKnown = prod + idleOnly;

      if (totalKnown <= 0) {
        raw.push({ start: bStart, end: bEnd, state: "empty", productionSeconds: 0, idleSeconds: 0, errorSeconds: 0 });
        continue;
      }

      const prodMs = (prod      / totalKnown) * bucketMs;
      const idleMs = (idleOnly  / totalKnown) * bucketMs;
      if (prodMs > 0) {
        raw.push({ start: bStart, end: bStart + prodMs, state: "running", productionSeconds: prod, idleSeconds: 0, errorSeconds: 0 });
      }
      if (idleMs > 0) {
        raw.push({ start: bStart + prodMs, end: bEnd, state: "idle", productionSeconds: 0, idleSeconds: idleOnly, errorSeconds: 0 });
      }
    }

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

    // Build error spans from error_events (precise PLC-reported timing). Clip
    // each event to the chart window, drop empty ones, then merge only
    // genuinely time-OVERLAPPING events so concurrent codes land in one
    // combined ErrorSeg — the tooltip lists every code active during the
    // hovered range. Two errors that merely touch (one ends exactly when the
    // next begins) stay separate so a back-to-back sequence reads as distinct
    // errors, not one fused block.
    const clippedErrs = errorEvents
      .map(ev => {
        const s = new Date(ev.started_at).getTime();
        const e = ev.ended_at ? new Date(ev.ended_at).getTime() : Date.now();
        return { ev, start: Math.max(firstMs, s), end: Math.min(endMs, e) };
      })
      .filter(s => s.end > s.start)
      .sort((a, b) => a.start - b.start);

    const errorSpans: ErrorSeg[] = [];
    for (const e of clippedErrs) {
      const last = errorSpans[errorSpans.length - 1];
      if (last && e.start < last.end) {
        last.end = Math.max(last.end, e.end);
        last.events.push(e.ev);
      } else {
        errorSpans.push({ start: e.start, end: e.end, events: [e.ev] });
      }
    }

    // Carve error spans out of the bucket-merged timeline. For each merged
    // bucket, walk the error spans that overlap it: emit a pre-error bucket
    // slice, an error slice, and a post-error bucket slice as appropriate.
    // The bucket slices carry production/idle/error counts scaled to their
    // share of the parent merged segment — so what you see on the strip
    // really is what those minutes contained, no overlay.
    const visual: VisualSeg[] = [];
    let errIdx = 0;
    const slicedBucket = (parent: MergedSeg, start: number, end: number): MergedSeg => {
      const portion = (end - start) / (parent.end - parent.start);
      return {
        start,
        end,
        state: parent.state,
        productionSeconds: parent.productionSeconds * portion,
        // Errors are now their own segments; the bucket slice's idle excludes
        // the error time that's been carved out, so we keep the (idle − error)
        // portion that remains as actual idle within this slice.
        idleSeconds:       Math.max(0, parent.idleSeconds - parent.errorSeconds) * portion,
        errorSeconds:      0,
      };
    };
    for (const bucket of merged) {
      let cursor = bucket.start;
      // Skip error spans that ended before this bucket started.
      while (errIdx < errorSpans.length && errorSpans[errIdx].end <= cursor) errIdx++;
      // Process every error span overlapping this bucket. An error span can
      // extend past the bucket end (errors cross bucket boundaries); we clip
      // and re-visit it via errIdx in the next bucket iteration.
      let i = errIdx;
      while (i < errorSpans.length && errorSpans[i].start < bucket.end) {
        const err = errorSpans[i];
        if (err.start > cursor) {
          visual.push({ kind: "bucket", seg: slicedBucket(bucket, cursor, err.start) });
        }
        const sliceStart = Math.max(err.start, cursor);
        const sliceEnd   = Math.min(err.end, bucket.end);
        visual.push({
          kind: "error",
          seg: { start: sliceStart, end: sliceEnd, events: err.events },
        });
        cursor = sliceEnd;
        if (err.end > bucket.end) break;  // remainder belongs to the next bucket
        i++;
      }
      // Advance errIdx past everything fully consumed by this bucket.
      errIdx = i;
      if (cursor < bucket.end) {
        visual.push({ kind: "bucket", seg: slicedBucket(bucket, cursor, bucket.end) });
      }
    }

    const hourTicks = rows
      .map(r => parseBucketKey(r.date).getTime())
      .filter(t => new Date(t).getUTCMinutes() === 0);
    const MAX_LABELS = 12;
    const tickStep = Math.max(1, Math.ceil(hourTicks.length / MAX_LABELS));
    const tickPositions = hourTicks.filter((_, i) => i % tickStep === 0);

    return { firstMs, endMs, totalMs, visual, tickPositions };
  }, [rows, errorEvents]);

  if (!data) {
    return <div className="text-gray-500 text-sm py-4">No state data for this period.</div>;
  }

  const pct = (t: number) => ((t - data.firstMs) / data.totalMs) * 100;

  const enterBucket = (seg: MergedSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    setHover({ kind: "bucket", seg, ...anchor(e.currentTarget.getBoundingClientRect()) });
  };
  const enterError = (seg: ErrorSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    setHover({ kind: "error", seg, ...anchor(e.currentTarget.getBoundingClientRect()) });
  };
  const leave = () => setHover(null);

  return (
    <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">Machine State Timeline</h3>
      </div>

      {/* The recharts LineChart below uses margin.left: -18 + a YAxis with the
          default 60px width, so its plot area starts ~42px from the chart
          card's inner left and ends 8px from the right (margin.right: 8).
          Mirror those offsets here so the timeline's 23:00 lines up with
          the chart's 23:00 below. */}
      <div style={{ paddingLeft: 42, paddingRight: 8 }}>
        <div
          className="relative h-24 rounded overflow-hidden"
          style={{ background: COLORS.empty }}
        >
          {data.visual.map((v, i) => {
            const start = v.seg.start;
            const end   = v.seg.end;
            const w     = pct(end) - pct(start);
            if (v.kind === "error") {
              // When this error block butts directly against the previous one
              // (a back-to-back sequence), draw a thin dark divider on its left
              // edge so the two read as separate errors instead of one fused
              // red stretch. The red fill bakes its own alpha into the rgba so
              // the divider can stay full-opacity and crisp.
              const prev = data.visual[i - 1];
              const abutsPrevError =
                prev?.kind === "error" && prev.seg.end === v.seg.start;
              return (
                <div
                  key={`v-${i}`}
                  className="absolute top-0 bottom-0 cursor-pointer"
                  style={{
                    left:  `${pct(start)}%`,
                    // Floor a sub-pixel error to a hairline so brief codes
                    // (a few seconds) still register visually and remain
                    // hoverable. Bucket slices don't need this — they're at
                    // least a 5-min wide chunk after the carve.
                    width: `${Math.max(w, 0.15)}%`,
                    background: "rgba(239, 68, 68, 0.4)",
                    borderLeft: abutsPrevError ? "2px solid #0b1220" : undefined,
                  }}
                  onMouseEnter={enterError(v.seg)}
                  onMouseLeave={leave}
                />
              );
            }
            return (
              <div
                key={`v-${i}`}
                className="absolute top-0 bottom-0 cursor-pointer"
                style={{
                  left:  `${pct(start)}%`,
                  width: `${w}%`,
                  background: v.seg.state === "empty" ? EMPTY_PATTERN : COLORS[v.seg.state],
                  opacity: v.seg.state === "empty" ? 0.45 : 0.4,
                }}
                onMouseEnter={enterBucket(v.seg)}
                onMouseLeave={leave}
              />
            );
          })}
        </div>

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
      </div>

      {hover && typeof document !== "undefined" && createPortal(
        <div
          ref={tooltipRef}
          className="pointer-events-none fixed z-50 px-3 py-2 rounded-md shadow-lg text-xs"
          style={{
            left: hover.x,
            top:  hover.y,
            transform: "translateY(-100%)",
            background: "#111827",
            border: "1px solid #374151",
            color: "#e5e7eb",
            // width:max-content gives the tooltip its natural width (up to
            // max-width) regardless of how little room is left to the right
            // of the anchor. The useLayoutEffect above then shifts it
            // leftward when it would overflow the viewport — so blocks near
            // the right edge end up with the tooltip flowing into the open
            // space on the left instead of being squished into a one-word-
            // per-line column.
            width:    "max-content",
            maxWidth: TOOLTIP_MAX_WIDTH,
          }}
        >
          {hover.kind === "bucket" ? (
            <BucketTooltip seg={hover.seg} />
          ) : (
            <ErrorTooltip seg={hover.seg} errorLookup={errorLookup} />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

function BucketTooltip({ seg }: { seg: MergedSeg }) {
  const isEmpty = seg.state === "empty";
  const label = seg.state === "running" ? "Running" : seg.state === "idle" ? "Idle" : "No signal";
  const color = seg.state === "running" ? COLORS.running : seg.state === "idle" ? COLORS.idle : "#9ca3af";
  return (
    <div>
      <div className="text-gray-400 mb-1">
        {format(new Date(seg.start), "HH:mm")} – {format(new Date(seg.end), "HH:mm")}
        <span className="text-gray-500"> · {fmtSecs((seg.end - seg.start) / 1000)}</span>
      </div>
      <div className="font-semibold" style={{ color }}>{label}</div>
      {isEmpty && (
        <div className="text-gray-400 mt-1">
          No PLC readings arrived in this window — likely a brief network or
          bridge gap. The machine state is unknown for these minutes.
        </div>
      )}
    </div>
  );
}

function ErrorTooltip({ seg, errorLookup }: { seg: ErrorSeg; errorLookup: Record<string, PlcErrorCode> }) {
  if (seg.events.length === 0) return null;
  // Deduplicate by error_code — a long error span can carry multiple
  // ErrorEvent rows for the same code (e.g. one per occurrence merged
  // into the span). Show each unique code once in the tooltip.
  const seen = new Set<string>();
  const uniqueEvents = seg.events.filter(ev => {
    if (seen.has(ev.error_code)) return false;
    seen.add(ev.error_code);
    return true;
  });
  return (
    <div>
      <div className="text-gray-400 mb-1">
        {format(new Date(seg.start), "HH:mm")} – {format(new Date(seg.end), "HH:mm")}
        <span className="text-gray-500"> · {fmtSecs((seg.end - seg.start) / 1000)}</span>
      </div>
      <div className="font-semibold text-red-400">Error</div>
      {uniqueEvents.map((ev, i) => {
        const lookup = errorLookup[ev.error_code];
        return (
          <div
            key={i}
            className={`text-gray-400 mt-1 space-y-0.5 ${i > 0 ? "pt-2 border-t border-gray-700" : ""}`}
          >
            <div>Code: <span className="text-gray-200">{ev.error_code}</span></div>
            {lookup?.description && (
              <div>Reason: <span className="text-gray-200">{lookup.description}</span></div>
            )}
            {lookup?.cause && (
              <div>Cause: <span className="text-gray-200">{lookup.cause}</span></div>
            )}
          </div>
        );
      })}
    </div>
  );
}
