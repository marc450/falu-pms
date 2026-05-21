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

// A bucket counts as "running" when at least this share of its non-error time
// was production. Errors are overlaid precisely from error_events, so the
// bucket-level split only needs to decide running vs idle.
const RUNNING_THRESHOLD = 0.5;

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

// Anchor the tooltip's bottom-left corner: it always renders above the
// timeline strip and starts at the right edge of the hovered block. Clamps
// to the viewport so it never gets cut off near the top or right edges.
function anchor(rect: DOMRect): { x: number; y: number } {
  let x = rect.right + TOOLTIP_GAP;
  const maxLeft = window.innerWidth - TOOLTIP_MAX_WIDTH - TOOLTIP_MARGIN;
  if (x > maxLeft) x = maxLeft;
  if (x < TOOLTIP_MARGIN) x = TOOLTIP_MARGIN;

  let y = rect.top - TOOLTIP_GAP;
  const minBottom = TOOLTIP_MARGIN + TOOLTIP_HEIGHT_EST;
  if (y < minBottom) y = minBottom;
  return { x, y };
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

  const data = useMemo(() => {
    if (rows.length === 0) return null;
    const firstMs = parseBucketKey(rows[0].date).getTime();
    const lastMs  = parseBucketKey(rows[rows.length - 1].date).getTime();
    const bucketMs = rows.length >= 2
      ? parseBucketKey(rows[1].date).getTime() - firstMs
      : 5 * 60 * 1000;
    const endMs   = lastMs + bucketMs;
    const totalMs = endMs - firstMs;

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

    // Build error spans from error_events (precise PLC-reported timing). Clip
    // each event to the chart window, drop empty ones, then merge time-
    // overlapping events so concurrent codes land in one combined ErrorSeg —
    // the tooltip lists every code active during the hovered range.
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
      if (last && e.start <= last.end) {
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

  // Summary breakdown across the whole window. Walk the visual list once so
  // the legend percentages line up exactly with what's rendered on the
  // strip — every second is accounted for in exactly one slice.
  const summary = data.visual.reduce(
    (acc, v) => {
      const span = (v.seg.end - v.seg.start) / 1000;
      if (v.kind === "error") {
        acc.error += span;
      } else if (v.seg.state === "empty") {
        acc.empty += span;
      } else if (v.seg.state === "running") {
        acc.running += span;
      } else {
        acc.idle += span;
      }
      return acc;
    },
    { running: 0, idle: 0, error: 0, empty: 0 },
  );
  const totalSec = summary.running + summary.idle + summary.error + summary.empty;
  const sharePct = (s: number) => totalSec > 0 ? (s / totalSec) * 100 : 0;

  const enterBucket = (seg: MergedSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    setHover({ kind: "bucket", seg, ...anchor(e.currentTarget.getBoundingClientRect()) });
  };
  const enterError = (seg: ErrorSeg) => (e: React.MouseEvent<HTMLDivElement>) => {
    setHover({ kind: "error", seg, ...anchor(e.currentTarget.getBoundingClientRect()) });
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
          {summary.empty > 0 && (
            <Legend pattern={EMPTY_PATTERN} label={`No signal ${sharePct(summary.empty).toFixed(0)}%`} />
          )}
        </div>
      </div>

      <div
        className="relative h-24 rounded overflow-hidden"
        style={{ background: COLORS.empty }}
      >
        {data.visual.map((v, i) => {
          const start = v.seg.start;
          const end   = v.seg.end;
          const w     = pct(end) - pct(start);
          if (v.kind === "error") {
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
                  background: COLORS.error,
                  opacity: 0.9,
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
                opacity: v.seg.state === "empty" ? 0.7 : 0.9,
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

      {hover && typeof document !== "undefined" && createPortal(
        <div
          className="pointer-events-none fixed z-50 px-3 py-2 rounded-md shadow-lg text-xs"
          style={{
            left: hover.x,
            top:  hover.y,
            transform: "translateY(-100%)",
            background: "#111827",
            border: "1px solid #374151",
            color: "#e5e7eb",
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

function Legend({ color, pattern, label }: { color?: string; pattern?: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block w-2.5 h-2.5 rounded-sm"
        style={{ background: pattern ?? color, backgroundSize: pattern ? "5px 5px" : undefined }}
      />
      {label}
    </span>
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
      {isEmpty ? (
        <div className="text-gray-400 mt-1">
          No PLC readings arrived in this window — likely a brief network or
          bridge gap. The machine state is unknown for these minutes.
        </div>
      ) : (
        // Bucket slices have had their error time carved out into their
        // own segments, so errorSeconds is always 0 here. The breakdown is
        // production + idle, scaled to this slice's share of the parent
        // bucket merge (so a 3-min slice of a 5-min bucket shows ~60% of
        // that bucket's production).
        <div className="text-gray-400 mt-1 space-y-0.5">
          <div>Production: <span className="text-gray-200">{fmtSecs(seg.productionSeconds)}</span></div>
          <div>Idle: <span className="text-gray-200">{fmtSecs(seg.idleSeconds)}</span></div>
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
