"use client";

import { useCallback } from "react";

/**
 * URL state sync without useSearchParams (which requires Suspense and causes
 * re-mount flicker in Next.js static export).
 *
 * `get` reads directly from window.location.search — safe in useState
 * initialisers on the client (static export, "use client" components).
 * Returns null during SSR build pass; useState defaults are used then.
 *
 * `set` writes via history.replaceState — no Next.js navigation, no re-render.
 */
export function useUrlSync() {
  const get = useCallback((key: string): string | null => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get(key);
  }, []);

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
