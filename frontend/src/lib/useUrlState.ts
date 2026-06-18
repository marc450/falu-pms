"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Syncs key→value pairs to the URL query string via window.history.replaceState()
 * — no Next.js navigation event, no re-render, no Suspense re-trigger.
 * `get` reads the initial URL value synchronously (safe in useState initialisers).
 * `set` merges updates into the live URL without touching React state.
 */
export function useUrlSync() {
  const searchParams = useSearchParams();

  const get = useCallback((key: string): string | null => {
    return searchParams.get(key);
  }, [searchParams]);

  const set = useCallback((updates: Record<string, string | null | undefined>) => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null) params.delete(k);
      else           params.set(k, v);
    }
    const qs = params.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, []);

  return { get, set };
}
