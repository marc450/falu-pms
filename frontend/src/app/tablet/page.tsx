"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  validateTabletToken, validateTabletPin,
  fetchTabletCellPeers, fetchMachineErrorEvents, fetchErrorCodeLookup,
} from "@/lib/supabase";
import type { TabletSession, TabletPeerRow, ErrorEvent, PlcErrorCode } from "@/lib/supabase";
import { TABLET_LANGS, t } from "@/lib/i18n";
import type { TabletLang } from "@/lib/i18n";

// 3-second poll matches the tablet UX brief without hammering Supabase.
const POLL_MS = 3000;

export default function TabletKioskPage() {
  return (
    <Suspense fallback={<FullScreen><Spinner /></FullScreen>}>
      <TabletKioskInner />
    </Suspense>
  );
}

function TabletKioskInner() {
  const search = useSearchParams();
  const token  = search?.get("token") ?? "";

  const [session, setSession] = useState<TabletSession | null>(null);
  const [tokenChecked, setTokenChecked] = useState(false);
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [lang, setLang] = useState<TabletLang>("en");

  // ── Token validation + PIN session restore ─────────────────────────
  useEffect(() => {
    if (!token) { setTokenChecked(true); return; }
    let cancelled = false;
    (async () => {
      const s = await validateTabletToken(token);
      if (cancelled) return;
      setSession(s);
      setTokenChecked(true);
      if (s) {
        const stored = typeof window !== "undefined"
          ? localStorage.getItem(`tablet_pin_ok_${token}`)
          : null;
        if (stored === "1") setPinUnlocked(true);
        const storedLang = typeof window !== "undefined"
          ? localStorage.getItem(`tablet_lang_${token}`)
          : null;
        if (storedLang === "es" || storedLang === "en") setLang(storedLang);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const onLangChange = useCallback((next: TabletLang) => {
    setLang(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(`tablet_lang_${token}`, next);
    }
  }, [token]);

  const onPinSuccess = useCallback(() => {
    setPinUnlocked(true);
    if (typeof window !== "undefined") {
      localStorage.setItem(`tablet_pin_ok_${token}`, "1");
    }
  }, [token]);

  // ── Render ─────────────────────────────────────────────────────────
  if (!tokenChecked) {
    return <FullScreen><Spinner /></FullScreen>;
  }
  if (!session) {
    return (
      <FullScreen>
        <div className="text-center px-8">
          <i className="bi bi-shield-exclamation text-6xl text-red-400 mb-6 block"></i>
          <h1 className="text-3xl font-bold text-white mb-3">{t(lang, "invalid_token")}</h1>
          <p className="text-gray-400">{t(lang, "invalid_token_hint")}</p>
        </div>
      </FullScreen>
    );
  }
  if (!pinUnlocked) {
    return (
      <FullScreen>
        <PinGate
          token={token}
          session={session}
          lang={lang}
          onSuccess={onPinSuccess}
          onLangChange={onLangChange}
        />
      </FullScreen>
    );
  }
  return (
    <FullScreen>
      <Kiosk session={session} lang={lang} onLangChange={onLangChange} />
    </FullScreen>
  );
}

// ─── Shell ──────────────────────────────────────────────────────────────

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-gray-950 text-white flex items-center justify-center overflow-hidden select-none">
      {children}
    </div>
  );
}

function Spinner() {
  return <span className="inline-block w-8 h-8 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></span>;
}

// ─── PIN pad ────────────────────────────────────────────────────────────

function PinGate({
  token, session, lang, onSuccess, onLangChange,
}: {
  token: string;
  session: TabletSession;
  lang: TabletLang;
  onSuccess: () => void;
  onLangChange: (l: TabletLang) => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const display = useMemo(() => {
    const dots = [];
    for (let i = 0; i < 4; i++) {
      dots.push(
        <span key={i} className={`w-5 h-5 rounded-full border-2 ${i < pin.length ? "bg-cyan-400 border-cyan-400" : "border-gray-600"}`} />
      );
    }
    return dots;
  }, [pin]);

  const push = useCallback(async (digit: string) => {
    setError(false);
    setPin(prev => {
      const next = (prev + digit).slice(0, 4);
      if (next.length === 4) {
        setBusy(true);
        validateTabletPin(token, next).then(ok => {
          if (ok) {
            onSuccess();
          } else {
            setError(true);
            setPin("");
          }
          setBusy(false);
        });
      }
      return next;
    });
  }, [token, onSuccess]);

  const backspace = useCallback(() => {
    setError(false);
    setPin(prev => prev.slice(0, -1));
  }, []);

  const machineLabel = session.name && session.name !== session.machine_code
    ? `${session.name} (${session.machine_code})`
    : session.machine_code;

  return (
    <>
      <LangPicker lang={lang} onChange={onLangChange} />
      <div className="flex flex-col items-center gap-8 px-8">
        <div className="text-center">
          <p className="text-gray-500 text-sm uppercase tracking-widest mb-2">{t(lang, "machine")}</p>
          <h1 className="text-3xl font-bold text-cyan-400">{machineLabel}</h1>
        </div>
        <h2 className="text-xl text-gray-300">{t(lang, "enter_pin")}</h2>
        <div className="flex gap-4">{display}</div>
        {error && (
          <p className="text-red-400 text-sm">{t(lang, "invalid_pin")}</p>
        )}
        <div className="grid grid-cols-3 gap-3">
          {["1","2","3","4","5","6","7","8","9"].map(d => (
            <PadButton key={d} onClick={() => push(d)} disabled={busy}>{d}</PadButton>
          ))}
          <PadButton onClick={backspace} disabled={busy} variant="ghost"><i className="bi bi-backspace"></i></PadButton>
          <PadButton onClick={() => push("0")} disabled={busy}>0</PadButton>
          <div />
        </div>
      </div>
    </>
  );
}

function PadButton({
  children, onClick, disabled, variant = "solid",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "solid" | "ghost";
}) {
  const base = "w-24 h-24 rounded-2xl text-3xl font-medium transition-colors active:scale-95 disabled:opacity-40";
  const styles = variant === "solid"
    ? "bg-gray-800 hover:bg-gray-700 text-white"
    : "bg-transparent hover:bg-gray-800 text-gray-400";
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

// ─── Language picker ───────────────────────────────────────────────────

function LangPicker({ lang, onChange }: { lang: TabletLang; onChange: (l: TabletLang) => void }) {
  const [open, setOpen] = useState(false);
  const current = TABLET_LANGS.find(l => l.code === lang) ?? TABLET_LANGS[0];

  return (
    <div className="absolute top-4 right-4 z-50">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 bg-gray-900/80 hover:bg-gray-800 border border-gray-700 rounded-full px-4 py-2 text-base"
      >
        <span className="text-xl">{current.flag}</span>
        <span className="text-gray-300">{current.label}</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-2 bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden min-w-[180px]">
          {TABLET_LANGS.map(l => (
            <button
              key={l.code}
              onClick={() => { onChange(l.code); setOpen(false); }}
              className={`w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-gray-800 ${l.code === lang ? "bg-cyan-950/40 text-cyan-300" : "text-gray-300"}`}
            >
              <span className="text-xl">{l.flag}</span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Kiosk: polling + view switching ───────────────────────────────────

function Kiosk({
  session, lang, onLangChange,
}: {
  session: TabletSession;
  lang: TabletLang;
  onLangChange: (l: TabletLang) => void;
}) {
  const [peers, setPeers] = useState<TabletPeerRow[]>([]);
  const [openErrors, setOpenErrors] = useState<ErrorEvent[]>([]);
  const [errorLookup, setErrorLookup] = useState<Record<string, PlcErrorCode>>({});
  const [cellName, setCellName] = useState<string | null>(null);

  // Static lookup table — cached after first load via the helper.
  useEffect(() => {
    fetchErrorCodeLookup().then(setErrorLookup).catch(() => {});
  }, []);

  // Cell name (rarely changes — fetch once on mount).
  useEffect(() => {
    if (!session.cell_id) return;
    let cancelled = false;
    (async () => {
      try {
        const { getSupabase } = await import("@/lib/supabase");
        const sb = getSupabase();
        const { data } = await sb.from("production_cells")
          .select("name").eq("id", session.cell_id).maybeSingle();
        if (!cancelled && data) setCellName((data as { name: string }).name);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [session.cell_id]);

  // Live polling loop.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const [peersData, events] = await Promise.all([
          fetchTabletCellPeers(session.cell_id, session.machine_code),
          // Pull the last 4 hours so freshly-opened events appear instantly.
          fetchMachineErrorEvents(session.machine_code, {
            start: new Date(Date.now() - 4 * 60 * 60 * 1000),
            end:   new Date(Date.now() + 60 * 60 * 1000),
          }),
        ]);
        if (cancelled) return;
        setPeers(peersData);
        setOpenErrors(events.filter(e => e.ended_at === null));
      } catch { /* ignore transient errors */ }
    }

    tick();
    pollRef.current = window.setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [session.cell_id, session.machine_code]);

  const selfStatus = peers.find(p => p.machine_code === session.machine_code)?.status ?? null;
  const isErrorView = (selfStatus?.toLowerCase() === "error") && openErrors.length > 0;

  return (
    <>
      <LangPicker lang={lang} onChange={onLangChange} />
      {isErrorView
        ? <ErrorScreen errors={openErrors} lookup={errorLookup} lang={lang} machineLabel={machineLabel(session)} />
        : <RunningScreen peers={peers} selfCode={session.machine_code} cellName={cellName} lang={lang} machineLabel={machineLabel(session)} />}
    </>
  );
}

function machineLabel(s: TabletSession): string {
  return s.name && s.name !== s.machine_code ? `${s.name} (${s.machine_code})` : s.machine_code;
}

// ─── Running screen ────────────────────────────────────────────────────

function RunningScreen({
  peers, selfCode, cellName, lang, machineLabel,
}: {
  peers: TabletPeerRow[];
  selfCode: string;
  cellName: string | null;
  lang: TabletLang;
  machineLabel: string;
}) {
  // Rank the cell by current-shift BU output, then surface the operator's own
  // machine at the top of the list (regardless of where it actually ranks) so
  // it's always immediately visible on small tablets without scrolling.
  const ranked = [...peers]
    .map(p => ({ ...p, bu: Math.round((p.current_swabs ?? 0) / 7200) }))
    .sort((a, b) => b.bu - a.bu)
    .map((p, idx) => ({ ...p, rank: idx + 1 }));
  const selfRow = ranked.find(p => p.machine_code === selfCode) ?? null;
  const others  = ranked.filter(p => p.machine_code !== selfCode);
  const display = selfRow ? [selfRow, ...others] : others;

  return (
    <div className="w-full h-full flex flex-col p-8">
      <header className="flex items-center justify-between mb-6 pr-40">
        <div>
          <p className="text-gray-500 text-sm uppercase tracking-widest mb-1">{t(lang, "machine")}</p>
          <h1 className="text-4xl font-bold text-white">{machineLabel}</h1>
        </div>
        {cellName && (
          <div className="text-right">
            <p className="text-gray-500 text-sm uppercase tracking-widest mb-1">{t(lang, "cell")}</p>
            <h2 className="text-3xl font-semibold text-cyan-400">{cellName}</h2>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        {display.length === 0 ? (
          <p className="text-gray-500 text-xl text-center mt-20">{t(lang, "no_peers")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {display.map((p) => {
              const isSelf = p.machine_code === selfCode;
              const rank   = p.rank;
              const eff    = p.current_efficiency != null ? `${Math.round(p.current_efficiency)}%` : "—";
              return (
                <li
                  key={p.machine_code}
                  className={`flex items-center gap-5 rounded-2xl px-5 py-3 ${
                    isSelf
                      ? "bg-cyan-500/15 border-2 border-cyan-400"
                      : "bg-gray-900/70 border border-gray-800"
                  }`}
                >
                  <span className={`text-3xl font-bold w-14 text-center ${
                    rank === 1 ? "text-yellow-300" : rank === 2 ? "text-gray-300" : rank === 3 ? "text-amber-600" : "text-gray-500"
                  }`}>{rank}</span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xl font-semibold ${isSelf ? "text-cyan-300" : "text-white"}`}>
                      {p.name && p.name !== p.machine_code ? p.name : p.machine_code}
                    </p>
                    {p.name && p.name !== p.machine_code && (
                      <p className="text-xs text-gray-500">{p.machine_code}</p>
                    )}
                  </div>
                  <div className="text-right w-28">
                    <p className="text-2xl font-bold text-white">{p.bu.toLocaleString()}</p>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">{t(lang, "bu")}</p>
                  </div>
                  <div className="text-right w-24">
                    <p className="text-xl font-semibold text-gray-200">{eff}</p>
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">{t(lang, "uptime")}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Error screen ──────────────────────────────────────────────────────

function ErrorScreen({
  errors, lookup, lang, machineLabel,
}: {
  errors: ErrorEvent[];
  lookup: Record<string, PlcErrorCode>;
  lang: TabletLang;
  machineLabel: string;
}) {
  return (
    <div className="fixed inset-0 bg-red-900/95 text-white flex flex-col p-8 overflow-auto">
      <header className="flex items-center justify-between mb-6 pr-40">
        <div>
          <p className="text-red-200 text-sm uppercase tracking-widest mb-1">{t(lang, "error_header")}</p>
          <h1 className="text-4xl font-bold">{machineLabel}</h1>
        </div>
        <i className="bi bi-exclamation-triangle-fill text-6xl text-red-200"></i>
      </header>

      <div className="flex-1 flex flex-col gap-4 min-h-0">
        {errors.length === 0 ? (
          <p className="text-red-200 text-xl text-center mt-20">{t(lang, "no_active_errors")}</p>
        ) : errors.map(ev => {
          const info = lookup[ev.error_code];
          return (
            <div
              key={ev.id}
              className="bg-red-950/60 border-2 border-red-300/40 rounded-2xl p-6 flex flex-col gap-4 flex-1 min-h-0"
            >
              {/* Error name as large title with the code as a side badge */}
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-3xl md:text-4xl font-bold text-red-50 leading-tight">
                  {info?.description ?? ev.error_code}
                </h2>
                <span className="shrink-0 text-base font-mono font-semibold text-red-200/80 bg-red-950/80 border border-red-300/30 rounded-full px-3 py-1 tracking-wider">
                  {ev.error_code}
                </span>
              </div>

              {/* SOLUTION — the dominant block, fills the remaining vertical space */}
              {info?.solution ? (
                <div className="bg-cyan-950/50 border-2 border-cyan-400/50 rounded-xl px-8 py-6 flex-1 flex flex-col justify-center min-h-0">
                  <p className="text-cyan-300 text-base uppercase tracking-[0.2em] mb-3">{t(lang, "solution")}</p>
                  <p className="text-4xl md:text-5xl font-semibold text-cyan-50 leading-[1.2]">
                    {info.solution}
                  </p>
                </div>
              ) : (
                <div className="flex-1" />
              )}

              {/* Cause demoted to a single-line footer */}
              {info?.cause && (
                <p className="text-base md:text-lg text-red-200/80 leading-snug">
                  <span className="text-red-300/70 uppercase tracking-widest text-xs mr-2">
                    {t(lang, "cause")}:
                  </span>
                  {info.cause}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
