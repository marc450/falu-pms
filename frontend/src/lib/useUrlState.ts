"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Syncs a set of key→value pairs to the URL query string using router.replace()
 * (no history push, so back/forward still work naturally). Values are plain
 * strings; callers are responsible for serialising and deserialising.
 *
 * Returns helpers for reading the initial URL values and writing updates.
 */
export function useUrlSync() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // Stable ref so callers can read params without re-rendering.
  const paramsRef = useRef(searchParams);
  useEffect(() => { paramsRef.current = searchParams; }, [searchParams]);

  /** Read an initial value from the URL (call during useState initialiser). */
  const get = useCallback((key: string): string | null => {
    return searchParams.get(key);
  }, [searchParams]);

  /**
   * Merge the given key/value pairs into the current URL and replace the
   * history entry. Entries with `null` or `undefined` values are removed.
   */
  const set = useCallback((updates: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams(paramsRef.current.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v == null) params.delete(k);
      else           params.set(k, v);
    }
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [router]);

  return { get, set };
}
