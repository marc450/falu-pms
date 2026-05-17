"use client";

import { useState } from "react";
import Link from "next/link";
import { sendPasswordReset } from "@/lib/supabase";

function FaluLogo({ className }: { className?: string }) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`${basePath}/falu-logo.svg`} alt="Logo" className={className} />;
}

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState("");
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      // Redirect URL must be in Supabase's Auth → URL Configuration →
      // Redirect URLs allowlist. Using window.location.origin works for
      // any deploy environment without an extra env var.
      const redirectTo = `${window.location.origin}/reset-password`;
      await sendPasswordReset(email, redirectTo);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reset email. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Brand */}
        <div className="text-center mb-8">
          <FaluLogo className="w-16 h-16 mx-auto mb-4 rounded-lg" />
          <h1 className="text-white text-2xl font-bold tracking-tight">FALU</h1>
          <p className="text-gray-500 text-sm mt-1">Production Monitoring</p>
        </div>

        {/* Card */}
        <div className="bg-gray-800/60 border border-gray-700/80 rounded-2xl p-6 shadow-xl">
          {sent ? (
            <>
              <div className="flex flex-col items-center text-center gap-3 py-2">
                <div className="w-12 h-12 rounded-full bg-blue-600/20 flex items-center justify-center">
                  <i className="bi bi-envelope-check text-blue-400 text-2xl"></i>
                </div>
                <h2 className="text-white font-semibold text-base">Check your email</h2>
                <p className="text-gray-400 text-sm leading-relaxed">
                  If an account exists for <span className="text-gray-200">{email}</span>, you&apos;ll receive a link to reset your password. The link expires in 1 hour.
                </p>
                <p className="text-gray-500 text-xs mt-2">
                  Didn&apos;t get it? Check your spam folder or try again with a different address.
                </p>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-white font-semibold text-base mb-2">Reset your password</h2>
              <p className="text-gray-400 text-sm mb-5">Enter your email and we&apos;ll send you a link to choose a new one.</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1.5">
                    Email address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 transition-colors"
                    placeholder="you@example.com"
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
                      Sending...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-envelope"></i>
                      Send reset link
                    </>
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-gray-600 mt-5">
          <Link href="/login" className="text-gray-500 hover:text-gray-300 transition-colors">
            <i className="bi bi-arrow-left mr-1"></i>
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
