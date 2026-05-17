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
