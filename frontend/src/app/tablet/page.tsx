"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
// @ts-expect-error react-dom types aren't installed; createPortal ships in react-dom at runtime
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import {
  validateTabletToken, validateTabletPin,
  fetchTabletCellPeers, fetchMachineErrorEvents, fetchErrorCodeLookup,
  fetchChecklistForCode,
  getSupabase,
} from "@/lib/supabase";
import type { TabletSession, TabletPeerRow, ErrorEvent, PlcErrorCode } from "@/lib/supabase";
import { TABLET_LANGS, t } from "@/lib/i18n";
import type { TabletLang } from "@/lib/i18n";

// Peer status (other machines in the cell) still polls — it's a cell-wide
// aggregate where 3s is plenty fresh. Error state and this machine's
// status flip to push via Realtime (see the effect below) so the
// ErrorScreen flip happens in <100ms instead of up to 3s.
const POLL_MS = 3000;

// Per-machine kiosk error allowlist. When a machine_code appears here, the
// kiosk only surfaces error events whose error_code is in the matching
// list — every other open event is hidden from the operator view. Used to
// keep specific kiosks focused on the one alarm they're equipped to act
// on. Machines NOT in this map see every error normally.
const KIOSK_ERROR_ALLOWLIST: Readonly<Record<string, ReadonlyArray<string>>> = {
  "11562": ["A190"], // CB-37 — only show A190
};

function filterErrorsForKiosk(events: ErrorEvent[], machineCode: string): ErrorEvent[] {
  const allowed = KIOSK_ERROR_ALLOWLIST[machineCode];
  if (!allowed) return events;
  return events.filter(e => allowed.includes(e.error_code));
}

function isErrorAllowedForKiosk(errorCode: string, machineCode: string): boolean {
  const allowed = KIOSK_ERROR_ALLOWLIST[machineCode];
  if (!allowed) return true;
  return allowed.includes(errorCode);
}

// Collapse multiple open events of the same error_code down to one — keep
// the most recently started row. Two simultaneous A190 cards on the kiosk
// would otherwise show up if the bridge ever ends up with two open
// error_events rows for the same code (stale row not closed cleanly,
// Realtime replay on reconnect, race during bridge restart, etc.). For the
// operator "A190 is active" is one piece of information, no matter how
// many DB rows represent it.
function dedupeByErrorCode(events: ErrorEvent[]): ErrorEvent[] {
  const byCode = new Map<string, ErrorEvent>();
  for (const e of events) {
    const prior = byCode.get(e.error_code);
    if (!prior || new Date(e.started_at).getTime() > new Date(prior.started_at).getTime()) {
      byCode.set(e.error_code, e);
    }
  }
  return Array.from(byCode.values());
}

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
      <LangPicker lang={lang} onChange={onLangChange} absolute />
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

function LangPicker({
  lang, onChange, dropUp = false, absolute = false,
}: {
  lang: TabletLang;
  onChange: (l: TabletLang) => void;
  dropUp?: boolean;
  absolute?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = TABLET_LANGS.find(l => l.code === lang) ?? TABLET_LANGS[0];

  const wrapper = absolute ? "absolute top-4 right-4 z-50" : "relative";
  const menu    = dropUp   ? "absolute bottom-full right-0 mb-2" : "absolute top-full right-0 mt-2";

  return (
    <div className={wrapper}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 bg-gray-900/80 hover:bg-gray-800 border border-gray-700 rounded-full px-4 py-2 text-base"
      >
        <span className="text-xl">{current.flag}</span>
        <span className="text-gray-300">{current.label}</span>
      </button>
      {open && (
        <div className={`${menu} bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden min-w-[180px] z-50`}>
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

// Bottom bar shared by the Running and Error screens — machine identity on the
// left, cell on the right, language picker far-right.
function BottomBar({
  machineLabel, cellName, lang, onLangChange,
}: {
  machineLabel: string;
  cellName: string | null;
  lang: TabletLang;
  onLangChange: (l: TabletLang) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-gray-800/60 px-6 py-3 bg-gray-950/40">
      <div className="min-w-0">
        <p className="text-gray-500 text-[10px] uppercase tracking-widest">{t(lang, "machine")}</p>
        <p className="text-lg font-semibold text-white truncate">{machineLabel}</p>
      </div>
      {cellName && (
        <div className="min-w-0 text-right">
          <p className="text-gray-500 text-[10px] uppercase tracking-widest">{t(lang, "cell")}</p>
          <p className="text-lg font-semibold text-cyan-400 truncate">{cellName}</p>
        </div>
      )}
      <LangPicker lang={lang} onChange={onLangChange} dropUp />
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
  const [selfStatus, setSelfStatus] = useState<string | null>(null);
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
        const sb = getSupabase();
        const { data } = await sb.from("production_cells")
          .select("name").eq("id", session.cell_id).maybeSingle();
        if (!cancelled && data) setCellName((data as { name: string }).name);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [session.cell_id]);

  // ── Peer polling ──────────────────────────────────────────────────
  // Cell-wide aggregate (other machines' BU/efficiency) — 3 s cadence
  // is fine and Realtime would fire per-row too aggressively for what
  // is a passive secondary view.
  useEffect(() => {
    let cancelled = false;

    async function tickPeers() {
      try {
        const peersData = await fetchTabletCellPeers(session.cell_id, session.machine_code);
        if (cancelled) return;
        setPeers(peersData);
      } catch { /* ignore transient errors */ }
    }

    tickPeers();
    const intervalId = window.setInterval(tickPeers, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [session.cell_id, session.machine_code]);

  // ── Error state via Realtime push ─────────────────────────────────
  // Subscribes to two streams for this machine: error_events
  // (INSERT/UPDATE/DELETE) and machines (status changes). Initial
  // snapshot via REST so we have correct state before the first
  // push lands. After that, every change arrives in <100ms.
  //
  // Backed by migration 087, which adds both tables to the
  // supabase_realtime publication.
  useEffect(() => {
    let cancelled = false;
    const sb = getSupabase();

    // Initial snapshot
    (async () => {
      try {
        const [machineResult, events] = await Promise.all([
          sb.from("machines").select("status").eq("id", session.id).maybeSingle(),
          // Pull the last 4 hours so freshly-opened events appear instantly.
          fetchMachineErrorEvents(session.machine_code, {
            start: new Date(Date.now() - 4 * 60 * 60 * 1000),
            end:   new Date(Date.now() + 60 * 60 * 1000),
          }),
        ]);
        if (cancelled) return;
        setSelfStatus((machineResult.data as { status: string | null } | null)?.status ?? null);
        const open = events.filter(e => e.ended_at === null);
        setOpenErrors(dedupeByErrorCode(filterErrorsForKiosk(open, session.machine_code)));
      } catch { /* ignore — Realtime will catch up via subsequent pushes */ }
    })();

    // Live subscription
    const channel = sb.channel(`tablet-${session.id}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "error_events",
          filter: `machine_id=eq.${session.id}`,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          if (cancelled) return;
          const row = (payload.new ?? payload.old) as Partial<ErrorEvent> | null;
          const id = row?.id;
          if (id == null) return;
          // Skip rows whose error_code is filtered out for this kiosk.
          // A close (UPDATE with ended_at) or DELETE for a filtered code is
          // also irrelevant since the row was never in our state.
          if (row?.error_code && !isErrorAllowedForKiosk(row.error_code, session.machine_code)) {
            return;
          }
          setOpenErrors((prev) => {
            const others = prev.filter(e => e.id !== id);
            // An "open" error has ended_at === null. INSERTs and UPDATEs
            // where ended_at is still null mean the error is active;
            // UPDATEs that set ended_at, and DELETEs, mean it's gone.
            let next: ErrorEvent[];
            if (payload.eventType !== "DELETE" && row?.ended_at == null) {
              next = [...others, row as ErrorEvent];
            } else {
              next = others;
            }
            next.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
            // Collapse multiple open events of the same code into one card.
            return dedupeByErrorCode(next);
          });
        }
      )
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "UPDATE",
          schema: "public",
          table: "machines",
          filter: `id=eq.${session.id}`,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          if (cancelled) return;
          const newRow = payload.new as { status?: string | null } | null;
          setSelfStatus(newRow?.status ?? null);
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      sb.removeChannel(channel);
    };
  }, [session.id, session.machine_code]);

  const isErrorView = (selfStatus?.toLowerCase() === "error") && openErrors.length > 0;

  return isErrorView
    ? <ErrorScreen errors={openErrors} lookup={errorLookup} lang={lang} onLangChange={onLangChange} cellName={cellName} machineLabel={machineLabel(session)} />
    : <RunningScreen peers={peers} selfCode={session.machine_code} cellName={cellName} lang={lang} onLangChange={onLangChange} machineLabel={machineLabel(session)} />;
}

function machineLabel(s: TabletSession): string {
  return s.name && s.name !== s.machine_code ? `${s.name} (${s.machine_code})` : s.machine_code;
}

// ─── Running screen ────────────────────────────────────────────────────

function RunningScreen({
  peers, selfCode, cellName, lang, onLangChange, machineLabel,
}: {
  peers: TabletPeerRow[];
  selfCode: string;
  cellName: string | null;
  lang: TabletLang;
  onLangChange: (l: TabletLang) => void;
  machineLabel: string;
}) {
  // Rank the cell by current-shift BU output; the kiosk machine sits in its
  // natural sorted position with the row highlighted so it's findable.
  const display = [...peers]
    .map(p => ({ ...p, bu: Math.round((p.current_swabs ?? 0) / 7200) }))
    .sort((a, b) => b.bu - a.bu)
    .map((p, idx) => ({ ...p, rank: idx + 1 }));

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 overflow-y-auto p-6">
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
      <BottomBar machineLabel={machineLabel} cellName={cellName} lang={lang} onLangChange={onLangChange} />
    </div>
  );
}

// Parses a numbered operator guidance string (e.g. "1) check this\n2) check that")
// into an array of step bodies, stripping the leading "N)" or "N." prefix and
// dropping empty lines. A guidance string with no newlines comes back as a
// single-element array.
function parseGuidanceSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\d+\s*[\)\.]\s*/, "").trim())
    .filter(line => line.length > 0);
}

// ─── Operator checklist types ──────────────────────────────────────────
// A checklist item is one row in the operator's "what to check" list.
// When an item has steps, the kiosk renders a "How to check ›" affordance
// and the operator can tap into a step-by-step walkthrough (image + text
// per step). Both checklist items and steps come from Supabase
// (checklist_items + checklist_item_steps); the kiosk falls back to
// parsing the legacy operator_guidance text when no DB rows exist for
// the active error code.

type HowToImage = {
  src: string | null;
  description: string;
};

type HowTo = {
  title: string;
  images: HowToImage[];
};

type DisplayChecklistItem = {
  text:  string;
  howto: HowTo | null;
};

// Render a checklist or step description, highlighting any segment wrapped in
// **double asterisks** as bold amber. Keeps the database text plain and human-
// editable while letting authors emphasise critical words (e.g. tool names,
// safety constraints) without HTML.
function renderEmphasized(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <span key={i} className="text-amber-300 font-bold">
          {part.slice(2, -2)}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// Renders the operator-guidance block. One item → plain paragraph (same look
// as before, smaller type). Multiple items → numbered list with a badge per
// row, thin red divider between rows, so the eye can land on a single item
// instead of scanning a wall of text. When an item carries a how-to (DB
// steps), the row becomes tappable; the parent swaps the body to the
// walkthrough view.
function GuidanceBlock({
  items, label, lang, onStepTap,
}: {
  items:      DisplayChecklistItem[];
  label:      string;
  lang:       TabletLang;
  onStepTap?: (howto: HowTo) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-cyan-300 text-sm uppercase tracking-[0.25em] mb-3">
        {label}
      </p>
      {items.length === 1 ? (
        (() => {
          const item   = items[0];
          const tappable = Boolean(item.howto && onStepTap);
          if (tappable) {
            return (
              <button
                type="button"
                onClick={() => onStepTap!(item.howto!)}
                className="text-left flex items-start gap-4 w-full rounded-2xl px-4 py-3 -mx-4 -my-1 hover:bg-red-950/40 active:scale-[0.99] transition"
              >
                <p className="flex-1 text-3xl md:text-4xl font-semibold text-cyan-50 leading-[1.2]">{renderEmphasized(item.text)}</p>
                <span className="shrink-0 inline-flex items-center gap-1.5 text-sm font-semibold text-amber-200 mt-2">
                  {t(lang, "how_to_check")} <i className="bi bi-chevron-right"></i>
                </span>
              </button>
            );
          }
          return (
            <p className="text-3xl md:text-4xl font-semibold text-cyan-50 leading-[1.2]">{renderEmphasized(item.text)}</p>
          );
        })()
      ) : (
        <ol className="flex flex-col">
          {items.map((item, idx) => {
            const tappable = Boolean(item.howto && onStepTap);
            const rowBase  = `flex items-start gap-5 py-3 ${idx > 0 ? "border-t border-red-300/15" : ""}`;
            const inner = (
              <>
                <span className="shrink-0 inline-flex items-center justify-center w-12 h-12 rounded-xl bg-red-950/60 border border-red-300/30 text-cyan-200 text-2xl font-semibold leading-none">
                  {idx + 1}
                </span>
                <p className="flex-1 text-2xl md:text-3xl font-semibold text-cyan-50 leading-[1.25]">
                  {renderEmphasized(item.text)}
                </p>
                {tappable && (
                  <span className="shrink-0 inline-flex items-center gap-1.5 text-sm font-semibold text-amber-200 mt-2">
                    {t(lang, "how_to_check")} <i className="bi bi-chevron-right"></i>
                  </span>
                )}
              </>
            );
            return tappable ? (
              <li key={idx} className={rowBase}>
                <button
                  type="button"
                  onClick={() => onStepTap!(item.howto!)}
                  className="flex-1 flex items-start gap-5 text-left rounded-2xl px-2 -mx-2 hover:bg-red-950/40 active:scale-[0.99] transition"
                >
                  {inner}
                </button>
              </li>
            ) : (
              <li key={idx} className={rowBase}>
                {inner}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// Per-step "how to check" walkthrough. Renders only the stacked
// image+text rows — the back button and title live in the ErrorCard
// header (they replace the error description in howto mode), so the
// whole screen reads as a focused walkthrough of the chosen checklist
// item rather than an addendum below the error.
function HowToView({ howto }: { howto: HowTo }) {
  return (
    <ol className="flex flex-col gap-6">
      {howto.images.map((img, idx) => (
        <li key={idx} className="flex items-start gap-6">
          <div className="basis-1/2 shrink-0 relative">
            <HowToImageFrame src={img.src} alt={img.description} />
            <span className="absolute top-3 left-3 inline-flex items-center justify-center w-12 h-12 rounded-xl bg-red-950/80 border border-red-300/40 text-cyan-200 text-2xl font-semibold leading-none shadow-lg">
              {idx + 1}
            </span>
          </div>
          <p className="basis-1/2 text-2xl md:text-3xl font-semibold text-cyan-50 leading-[1.25]">
            {renderEmphasized(img.description)}
          </p>
        </li>
      ))}
    </ol>
  );
}

// Pass-through: Supabase's image-transformation endpoint strips EXIF
// orientation without baking the rotation into pixels, so landscape
// phone JPGs come out rotated. We load the original URL instead so
// the browser can apply EXIF orientation itself. Trade-off: full
// source size travels over the wire; the preload in ErrorCard hides
// most of the latency, but uploaders should compress source images
// (~1200 px wide, 300–500 KB) before uploading to the bucket.
function optimizeKioskImageUrl(url: string | null): string | null {
  return url;
}

function HowToImageFrame({ src, alt }: { src: string | null; alt: string }) {
  const optimized = optimizeKioskImageUrl(src);
  const [zoomed, setZoomed] = useState(false);

  // Block body scroll while the lightbox is open so a stray tap-drag on
  // the overlay can't move the kiosk view behind it.
  useEffect(() => {
    if (!zoomed) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [zoomed]);

  if (!optimized) {
    return (
      <div className="w-full aspect-[4/3] rounded-2xl border-2 border-dashed border-red-300/30 bg-red-950/30 flex flex-col items-center justify-center gap-2 text-red-200/70">
        <i className="bi bi-image text-5xl"></i>
        <p className="text-sm uppercase tracking-[0.2em]">Image placeholder</p>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        aria-label={alt}
        // Force a consistent 4:3 frame regardless of source orientation —
        // portrait phone photos would otherwise stretch the row to the
        // photo's native height and crowd the description text. object-
        // contain keeps the full image visible with letterboxing on the
        // sides; a dark backdrop hides the bars.
        className="block w-full aspect-[4/3] rounded-2xl overflow-hidden border border-red-300/20 bg-red-950/40 active:scale-[0.98] transition"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={optimized}
          alt={alt}
          loading="eager"
          decoding="async"
          className="w-full h-full object-contain"
        />
      </button>

      {zoomed && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-4 cursor-zoom-out"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={optimized}
            alt={alt}
            className="max-w-full max-h-full object-contain"
          />
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setZoomed(false); }}
            aria-label="Close"
            className="absolute top-6 right-6 w-14 h-14 rounded-full bg-white/10 backdrop-blur text-white text-2xl flex items-center justify-center hover:bg-white/20 active:scale-95 transition"
          >
            <i className="bi bi-x-lg"></i>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

// PIN that gates the technical-support guidance. Intentionally simple and
// shared across all kiosks — escalation, not authentication. The per-machine
// kiosk login PIN (machines.tablet_pin) is unrelated to this one.
const TECH_SUPPORT_PIN = "1234";

// One card per open error. Internal state machine controls whether the
// operator sees their guidance, the PIN pad for tech support, or the tech
// support guidance itself. Tech entry is gated by TECH_SUPPORT_PIN every
// time (no session memory) so a technician walking away can't leave the
// tech view exposed to the next operator.
function ErrorCard({ ev, info, lang }: {
  ev:    ErrorEvent;
  info:  PlcErrorCode | undefined;
  lang:  TabletLang;
}) {
  const [mode, setMode]       = useState<"operator" | "tech-pin" | "tech">("operator");
  const [pin,  setPin]        = useState("");
  const [pinErr, setPinErr]   = useState(false);
  // Active how-to walkthrough, set when the operator taps a tappable item
  // in the operator checklist. Cleared by the back button.
  const [howtoStep, setHowtoStep] = useState<HowTo | null>(null);
  // Operator checklist for this error code. Pulled from Supabase; falls
  // back to parsing PlcErrorCode.operator_guidance text when no DB rows
  // exist for the code. Null while loading.
  const [checklist, setChecklist] = useState<DisplayChecklistItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const dbItems = await fetchChecklistForCode(ev.error_code);
        if (!alive) return;
        if (dbItems.length > 0) {
          // Preload every step image (at the same transformed URL the
          // <img> tag will request) so the operator's first tap shows
          // the image instantly instead of fetching it on demand.
          if (typeof window !== "undefined") {
            for (const it of dbItems) {
              for (const s of it.steps) {
                const url = optimizeKioskImageUrl(s.image_url);
                if (url) {
                  const preloader = new window.Image();
                  preloader.src = url;
                }
              }
            }
          }
          setChecklist(dbItems.map(it => ({
            text:  it.text,
            howto: it.steps.length > 0 ? {
              title:  it.text,
              images: it.steps.map(s => ({ src: s.image_url, description: s.description })),
            } : null,
          })));
          return;
        }
      } catch { /* fall through to text parsing */ }
      if (!alive) return;
      const text = info?.operator_guidance ?? "";
      const parsed = text ? parseGuidanceSteps(text) : [];
      setChecklist(parsed.map(step => ({ text: step, howto: null })));
    })();
    return () => { alive = false; };
  }, [ev.error_code, info?.operator_guidance]);

  const techItems: DisplayChecklistItem[] = info?.technical_support_guidance
    ? parseGuidanceSteps(info.technical_support_guidance).map(step => ({ text: step, howto: null }))
    : [];

  const hasTech = !!info?.technical_support_guidance;

  const pushDigit = (d: string) => {
    setPinErr(false);
    setPin(prev => {
      const next = (prev + d).slice(0, 4);
      if (next.length === 4) {
        if (next === TECH_SUPPORT_PIN) {
          setMode("tech");
          return "";
        }
        setPinErr(true);
        return "";
      }
      return next;
    });
  };
  const backspace = () => { setPinErr(false); setPin(p => p.slice(0, -1)); };
  const cancelPin = () => { setMode("operator"); setPin(""); setPinErr(false); };
  const backToOp  = () => { setMode("operator"); setPin(""); setPinErr(false); };

  return (
    // gap-10 (was gap-5) puts real space between the error title and the
    // guidance section — request from the floor: "increase the spacing
    // between error name and the guidance instructions".
    <article className="flex flex-col gap-10">
      {/* Header — replaced by the back button + checklist-item title
          when the operator drills into a how-to walkthrough. */}
      {mode === "operator" && howtoStep ? (
        <div className="flex flex-col gap-6">
          <button
            type="button"
            onClick={() => setHowtoStep(null)}
            className="self-start inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-red-950/40 border border-red-300/30 text-cyan-200 text-base font-semibold hover:bg-red-950/60 active:scale-95 transition"
          >
            <i className="bi bi-arrow-left"></i>
            {t(lang, "back_to_checklist")}
          </button>
          <h2 className="text-4xl md:text-5xl font-bold text-cyan-50 leading-tight">
            {howtoStep.title}
          </h2>
        </div>
      ) : (
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className="text-red-300/80 text-xs uppercase tracking-[0.25em] mb-1">
              {t(lang, "error_header")}
            </p>
            <h2 className="text-4xl md:text-5xl font-bold text-red-50 leading-tight">
              {info?.description ?? ev.error_code}
            </h2>
          </div>
          <span className="shrink-0 text-sm font-mono font-semibold text-red-200/70 bg-red-950/60 border border-red-300/30 rounded-full px-3 py-1 tracking-wider">
            {ev.error_code}
          </span>
        </div>
      )}

      {/* Body — switches by mode */}
      {mode === "operator" && howtoStep && (
        <HowToView howto={howtoStep} />
      )}
      {mode === "operator" && !howtoStep && (
        <>
          {checklist && checklist.length > 0 && (
            <GuidanceBlock
              items={checklist}
              label={t(lang, "operator_guidance")}
              lang={lang}
              onStepTap={setHowtoStep}
            />
          )}
          {hasTech && (
            <button
              type="button"
              onClick={() => setMode("tech-pin")}
              className="self-start inline-flex items-center gap-2 mt-2 px-5 py-3 rounded-xl bg-red-950/40 border border-red-300/30 text-amber-200 text-base font-semibold hover:bg-red-950/60 active:scale-95 transition"
            >
              <i className="bi bi-shield-lock"></i>
              {t(lang, "tech_support")}
            </button>
          )}
        </>
      )}

      {mode === "tech-pin" && (
        <TechPinPad pin={pin} err={pinErr} onDigit={pushDigit} onBackspace={backspace} onCancel={cancelPin} lang={lang} />
      )}

      {mode === "tech" && info?.technical_support_guidance && (
        <>
          <button
            type="button"
            onClick={backToOp}
            className="self-start inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-red-950/40 border border-red-300/30 text-cyan-200 text-base font-semibold hover:bg-red-950/60 active:scale-95 transition"
          >
            <i className="bi bi-arrow-left"></i>
            {t(lang, "back_to_operator")}
          </button>
          <GuidanceBlock items={techItems} label={t(lang, "tech_support")} lang={lang} />
        </>
      )}
    </article>
  );
}

// Inline 10-key PIN pad that lives inside an ErrorCard. Red-themed so it
// reads as part of the error screen rather than dropping onto a gray
// modal. Cancel returns to operator view; the parent handles success.
function TechPinPad({ pin, err, onDigit, onBackspace, onCancel, lang }: {
  pin:         string;
  err:         boolean;
  onDigit:     (d: string) => void;
  onBackspace: () => void;
  onCancel:    () => void;
  lang:        TabletLang;
}) {
  const dots = [0, 1, 2, 3].map(i => (
    <span
      key={i}
      className={`w-5 h-5 rounded-full border-2 ${
        i < pin.length
          ? "bg-cyan-300 border-cyan-300"
          : err
            ? "border-red-300"
            : "border-red-200/40"
      }`}
    />
  ));
  const digitBtn = "w-20 h-20 rounded-2xl text-3xl font-medium bg-red-950/50 border border-red-300/20 text-red-50 hover:bg-red-950/80 active:scale-95 transition";
  const ghostBtn = "w-20 h-20 rounded-2xl text-xl font-medium bg-transparent border border-red-300/20 text-red-200/70 hover:bg-red-950/40 active:scale-95 transition";
  return (
    <div className="flex flex-col items-center gap-5 py-4">
      <p className="text-cyan-300 text-xs uppercase tracking-[0.25em]">
        {t(lang, "tech_support_pin")}
      </p>
      <div className="flex gap-4">{dots}</div>
      {err && <p className="text-red-200 text-base">{t(lang, "invalid_pin")}</p>}
      <div className="grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => (
          <button key={d} type="button" onClick={() => onDigit(d)} className={digitBtn}>{d}</button>
        ))}
        <button type="button" onClick={onCancel} className={ghostBtn}>{t(lang, "cancel")}</button>
        <button type="button" onClick={() => onDigit("0")} className={digitBtn}>0</button>
        <button type="button" onClick={onBackspace} className={ghostBtn}><i className="bi bi-backspace"></i></button>
      </div>
    </div>
  );
}

// ─── Error screen ──────────────────────────────────────────────────────

function ErrorScreen({
  errors, lookup, lang, onLangChange, cellName, machineLabel,
}: {
  errors: ErrorEvent[];
  lookup: Record<string, PlcErrorCode>;
  lang: TabletLang;
  onLangChange: (l: TabletLang) => void;
  cellName: string | null;
  machineLabel: string;
}) {
  return (
    <div className="fixed inset-0 bg-red-900/95 text-white flex flex-col">
      <div className="flex-1 overflow-y-auto px-8 py-6">
        {errors.length === 0 ? (
          <p className="text-red-200 text-xl text-center mt-20">{t(lang, "no_active_errors")}</p>
        ) : (
          <div className="flex flex-col gap-6">
            {errors.map(ev => (
              <ErrorCard key={ev.id} ev={ev} info={lookup[ev.error_code]} lang={lang} />
            ))}
          </div>
        )}
      </div>
      <BottomBar machineLabel={machineLabel} cellName={cellName} lang={lang} onLangChange={onLangChange} />
    </div>
  );
}
