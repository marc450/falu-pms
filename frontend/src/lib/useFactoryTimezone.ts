"use client";

// ============================================
// FACTORY TIMEZONE HOOK
// ============================================
// Resolves once per session and caches at module scope so every chart that
// formats time labels reads the same value without re-fetching. The first
// caller triggers the fetch; subsequent callers reuse the in-flight
// promise or the resolved value.
//
// Falls back to "Europe/Zurich" (the prod factory's tz) until the fetch
// resolves, so the very first render isn't blank. If the fetch errors we
// stick with the fallback rather than throwing.
//
// Use this everywhere a UTC Date is rendered for an operator. Browser-
// local formatting is wrong for any viewer not physically at the factory.

import { useEffect, useState } from "react";
import { fetchFactoryTimezone } from "./supabase";

const DEFAULT_TZ = "Europe/Zurich";

let cachedTz: string | null = null;
let inflight: Promise<string> | null = null;

export function useFactoryTimezone(): string {
  const [tz, setTz] = useState<string>(cachedTz ?? DEFAULT_TZ);

  useEffect(() => {
    if (cachedTz) return;
    if (!inflight) {
      inflight = fetchFactoryTimezone()
        .then((v) => { cachedTz = v; inflight = null; return v; })
        .catch(() => { inflight = null; return DEFAULT_TZ; });
    }
    inflight.then((v) => { setTz(v); });
  }, []);

  return tz;
}

// Cached Intl.DateTimeFormat instances. Construction is non-trivial in
// hot paths (X-axis ticks render dozens of times); cache by (tz, kind).
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string, kind: "hm" | "ymdhm"): Intl.DateTimeFormat {
  const key = `${kind}|${tz}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = kind === "hm"
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
        })
      : new Intl.DateTimeFormat("en-US", {
          timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
          hour: "2-digit", minute: "2-digit", hour12: false,
        });
    fmtCache.set(key, f);
  }
  return f;
}

// Format a UTC Date as "HH:mm" in the given timezone.
export function formatHourMinute(d: Date, tz: string): string {
  return getFormatter(tz, "hm").format(d);
}

// Extract calendar parts for a UTC Date as they appear in the given
// timezone. Used to make day/month/year-aware labels honor factory time.
export function getZonedParts(d: Date, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number;
} {
  const parts = getFormatter(tz, "ymdhm").formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year:   get("year"),
    month:  get("month"),
    day:    get("day"),
    hour:   get("hour"),
    minute: get("minute"),
  };
}

// ============================================
// FACTORY-TZ DATE MATH
// ============================================
// All return a UTC Date whose wall clock in `tz` matches the desired
// factory-local moment (e.g. midnight on Mar 1st as the factory sees it).
// Implementation: pick the desired wall-clock instant assuming UTC == tz,
// observe what wall clock that UTC instant actually produces under tz,
// then correct by the offset. Robust across DST except for the missing/
// doubled hour itself, which we never need (we ask for midnight).

export function constructFactoryInstant(
  tz: string,
  year: number, month: number, day: number, hour: number, minute: number,
): Date {
  const wantedMs   = Date.UTC(year, month - 1, day, hour, minute);
  const observed   = getZonedParts(new Date(wantedMs), tz);
  const observedMs = Date.UTC(
    observed.year, observed.month - 1, observed.day,
    observed.hour, observed.minute,
  );
  return new Date(wantedMs - (observedMs - wantedMs));
}

// Factory midnight today.
export function factoryStartOfDay(tz: string, now: Date = new Date()): Date {
  const p = getZonedParts(now, tz);
  return constructFactoryInstant(tz, p.year, p.month, p.day, 0, 0);
}

// 1st of the factory's current month, at factory midnight.
export function factoryStartOfMonth(tz: string, now: Date = new Date()): Date {
  const p = getZonedParts(now, tz);
  return constructFactoryInstant(tz, p.year, p.month, 1, 0, 0);
}

// 1st of the first month of the factory's current quarter, at factory midnight.
export function factoryStartOfQuarter(tz: string, now: Date = new Date()): Date {
  const p = getZonedParts(now, tz);
  const qFirstMonth = Math.floor((p.month - 1) / 3) * 3 + 1;  // 1, 4, 7, 10
  return constructFactoryInstant(tz, p.year, qFirstMonth, 1, 0, 0);
}

// Jan 1 of the factory's current year, at factory midnight.
export function factoryStartOfYear(tz: string, now: Date = new Date()): Date {
  const p = getZonedParts(now, tz);
  return constructFactoryInstant(tz, p.year, 1, 1, 0, 0);
}

// Step back by N factory-calendar days or months from "today at the factory",
// then return factory midnight. For months, day-of-month is clamped down if
// the target month is shorter (Mar 31 - 1 month → Feb 28/29).
export function factoryDateBefore(
  tz: string,
  offset: { days?: number; months?: number },
  now: Date = new Date(),
): Date {
  const today = getZonedParts(now, tz);
  let { year, month, day } = today;

  if (offset.months) {
    const totalMonths = year * 12 + (month - 1) - offset.months;
    year  = Math.floor(totalMonths / 12);
    month = (totalMonths % 12 + 12) % 12 + 1;
    // Clamp day to last day of target month
    const daysInTarget = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > daysInTarget) day = daysInTarget;
  }

  if (offset.days) {
    const ms       = Date.UTC(year, month - 1, day) - offset.days * 86_400_000;
    const fromUtc  = new Date(ms);
    year  = fromUtc.getUTCFullYear();
    month = fromUtc.getUTCMonth() + 1;
    day   = fromUtc.getUTCDate();
  }

  return constructFactoryInstant(tz, year, month, day, 0, 0);
}
