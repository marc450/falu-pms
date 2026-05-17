"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { changePassword, getSupabase } from "@/lib/supabase";

function FaluLogo({ className }: { className?: string }) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`${basePath}/falu-logo.svg`} alt="Logo" className={className} />;
}

const MIN_PASSWORD_LENGTH = 6;

type Phase = "checking" | "ready" | "invalid" | "done";

export default function ResetPasswordPage() {
  const [phase, setPhase]               = useState<Phase>("checking");
  const [password, setPassword]         = useState("");
  const [confirmPassword, setConfirm]   = useState("");
  const [error, setError]               = useState("");
  const [loading, setLoading]           = useState(false);
  const router = useRouter();

  // When the user arrives via the email link, Supabase puts a recovery
  // token in the URL fragment. The JS client picks it up automatically
  // (detectSessionInUrl) and fires an auth state change with event
  // "PASSWORD_RECOVERY". We wait for either that or for an existing
  // session — both are valid states for showing the new-password form.
  useEffect(() => {
    const sb = getSupabase();
    let cancelled = false;

    // Check if we already have a session (already arrived + token parsed,
    // or user is in an active session and chose to reset)
    sb.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) setPhase("ready");
    });

    const { data: { subscription } } = sb.auth.onAuthStateChange((event) => {
      if (cancelled) return;
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        setPhase("ready");
      }
    });

    // If neither a session nor a recovery event materializes within 2.5 s,
    // the link was probably opened without a valid token. Show an
    // explanatory state instead of leaving the form gated forever.
    const timer = window.setTimeout(() => {
      if (!cancelled) {
        setPhase((p) => p === "checking" ? "invalid" : p);
      }
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    try {
      await changePassword(password);
      // Sign out the recovery session so the next sign-in uses the
      // new password rather than carrying the recovery context forward.
      await getSupabase().auth.signOut();
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update password. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Brand */}
        <div className="text-center mb-8">
          <FaluLogo className="w-16 h-16 mx-auto mb-4" />
          <p className="text-gray-500 text-sm">Production Monitoring &amp; Operator Guidance</p>
        </div>

        {/* Card */}
        <div className="bg-gray-800/60 border border-gray-700/80 rounded-2xl p-6 shadow-xl">

          {phase === "checking" && (
            <div className="flex flex-col items-center text-center gap-3 py-4">
              <span className="inline-block w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></span>
              <p className="text-gray-400 text-sm">Verifying reset link…</p>
            </div>
          )}

          {phase === "invalid" && (
            <div className="flex flex-col items-center text-center gap-3 py-2">
              <div className="w-12 h-12 rounded-full bg-red-600/20 flex items-center justify-center">
                <i className="bi bi-exclamation-triangle text-red-400 text-2xl"></i>
              </div>
              <h2 className="text-white font-semibold text-base">Link expired or invalid</h2>
              <p className="text-gray-400 text-sm leading-relaxed">
                Open this page from the most recent reset email — links expire after 1 hour and can only be used once.
              </p>
              <Link
                href="/forgot-password"
                className="mt-2 w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
              >
                <i className="bi bi-arrow-clockwise"></i>
                Request a new link
              </Link>
            </div>
          )}

          {phase === "ready" && (
            <>
              <h2 className="text-white font-semibold text-base mb-2">Choose a new password</h2>
              <p className="text-gray-400 text-sm mb-5">
                Pick something at least {MIN_PASSWORD_LENGTH} characters long.
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">
                    New password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    autoFocus
                    minLength={MIN_PASSWORD_LENGTH}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                    placeholder="••••••••"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">
                    Confirm new password
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                    placeholder="••••••••"
                  />
                </div>

                {error && (
                  <div className="bg-red-900/30 border border-red-700/50 text-red-400 text-sm rounded-lg px-3 py-2.5 flex items-center gap-2">
                    <i className="bi bi-exclamation-circle shrink-0"></i>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg py-2.5 text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-1"
                >
                  {loading ? (
                    <>
                      <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
                      Updating...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-check2"></i>
                      Update password
                    </>
                  )}
                </button>
              </form>
            </>
          )}

          {phase === "done" && (
            <div className="flex flex-col items-center text-center gap-3 py-2">
              <div className="w-12 h-12 rounded-full bg-green-600/20 flex items-center justify-center">
                <i className="bi bi-check2-circle text-green-400 text-2xl"></i>
              </div>
              <h2 className="text-white font-semibold text-base">Password updated</h2>
              <p className="text-gray-400 text-sm leading-relaxed">
                You can now sign in with your new password.
              </p>
              <button
                onClick={() => router.replace("/login")}
                className="mt-2 w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
              >
                <i className="bi bi-box-arrow-in-right"></i>
                Sign in
              </button>
            </div>
          )}

        </div>

        {phase !== "done" && (
          <p className="text-center text-xs text-gray-600 mt-5">
            <Link href="/login" className="text-gray-500 hover:text-gray-300 transition-colors">
              <i className="bi bi-arrow-left mr-1"></i>
              Back to sign in
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
