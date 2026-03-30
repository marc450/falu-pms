"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { updateUserProfile, changePassword } from "@/lib/supabase";

// Inline SVG so it works regardless of basePath / CDN configuration
function FaluLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="100" height="100" fill="#FF0000"/>
      <text x="5" y="88" fontFamily="Arial, Helvetica, sans-serif" fontWeight="900" fontSize="42" fill="#FFFFFF" letterSpacing="-1">FALU</text>
      <circle cx="88" cy="12" r="7" fill="none" stroke="#FFFFFF" strokeWidth="1.5"/>
      <text x="85" y="15.5" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="10" fill="#FFFFFF">R</text>
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// My Account modal
// ─────────────────────────────────────────────────────────────
function MyAccountModal({ onClose }: { onClose: () => void }) {
  const { user, profile, refreshProfile } = useAuth();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Sync form fields when profile becomes available
  useEffect(() => {
    if (profile && !profileLoaded) {
      setFirstName(profile.first_name ?? "");
      setLastName(profile.last_name ?? "");
      setPhone(profile.whatsapp_phone ?? "");
      setProfileLoaded(true);
    }
  }, [profile, profileLoaded]);

  const handleSaveProfile = async () => {
    if (!user || !firstName || !lastName) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await updateUserProfile(user.id, {
        first_name: firstName,
        last_name: lastName,
        whatsapp_phone: phone || null,
      });
      await refreshProfile();
      setSuccess("Profile updated");
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  };

  const handleChangePassword = async () => {
    if (!newPassword) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await changePassword(newPassword);
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Password changed");
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h3 className="text-white font-semibold">
            <i className="bi bi-person-circle mr-2"></i>My Account
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <i className="bi bi-x-lg"></i>
          </button>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="px-4 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
              {error}
            </div>
          )}
          {success && (
            <div className="px-4 py-2.5 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400">
              {success}
            </div>
          )}

          {/* Profile section */}
          <div>
            <h4 className="text-sm font-medium text-gray-300 mb-3">Profile</h4>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">First Name</label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Last Name</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">WhatsApp Phone</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 234 567 8900"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Email</label>
                <input
                  type="email"
                  value={user?.email ?? ""}
                  disabled
                  className="w-full px-3 py-2 bg-gray-900/50 border border-gray-700 rounded-lg text-sm text-gray-500 cursor-not-allowed"
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSaveProfile}
                  disabled={saving || !firstName || !lastName}
                  className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg transition-colors"
                >
                  {saving ? "Saving..." : "Save Profile"}
                </button>
              </div>
            </div>
          </div>

          {/* Password section */}
          <div className="border-t border-gray-700 pt-6">
            <h4 className="text-sm font-medium text-gray-300 mb-3">Change Password</h4>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Min. 6 characters"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Confirm Password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleChangePassword}
                  disabled={saving || !newPassword || !confirmPassword}
                  className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 rounded-lg transition-colors"
                >
                  {saving ? "Changing..." : "Change Password"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main layout
// ─────────────────────────────────────────────────────────────
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, signOut, user, profile, isAdmin } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [showAccount, setShowAccount] = useState(false);

  const isLoginPage       = pathname === "/login";
  const isLeaderboardPage = pathname === "/leaderboard";
  const isSettingsPage    = pathname === "/settings";

  useEffect(() => {
    if (loading) return;
    if (!session && !isLoginPage) {
      router.replace("/login");
    }
    if (session && isLoginPage) {
      router.replace("/");
    }
    // Viewers cannot access settings
    if (session && isSettingsPage && !isAdmin) {
      router.replace("/");
    }
  }, [loading, session, isLoginPage, isSettingsPage, isAdmin, router]);

  // While checking auth state, show a minimal spinner
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <span className="inline-block w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></span>
      </div>
    );
  }

  // Login page — render without sidebar/chrome
  if (isLoginPage) {
    return <>{children}</>;
  }

  // Not authenticated — render nothing while redirect fires
  if (!session) {
    return null;
  }

  // Leaderboard — full-screen, no sidebar, no padding (designed for TV display)
  if (isLeaderboardPage) {
    return <>{children}</>;
  }

  const displayName = profile?.first_name && profile?.last_name
    ? `${profile.first_name} ${profile.last_name}`
    : user?.email;

  // Authenticated — full app shell with sidebar
  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        {/* Brand */}
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <FaluLogo className="w-9 h-9 shrink-0 rounded" />
            <div>
              <h1 className="text-sm font-bold text-white leading-tight">FALU</h1>
              <p className="text-xs text-gray-500 mt-0.5">Production Monitoring</p>
            </div>
          </div>
        </div>

        {/* Nav links */}
        <nav className="flex-1 p-3 space-y-1">
          <NavLink href="/" icon="speedometer2" label="Dashboard" current={pathname} />
          <NavLink href="/analytics" icon="bar-chart-line" label="Analytics" current={pathname} />
          {isAdmin && <NavLink href="/settings" icon="gear" label="Settings" current={pathname} />}
          <div className="mt-3 pt-3 border-t border-gray-800">
            <NavLink href="/leaderboard" icon="trophy-fill" label="Leaderboard" current={pathname} />
          </div>
        </nav>

        {/* User + account + logout */}
        <div className="p-3 border-t border-gray-800">
          <div className="px-3 py-2 mb-1">
            <p className="text-xs text-white truncate">{displayName}</p>
            <p className="text-[10px] text-gray-500 truncate">{user?.email}</p>
            {isAdmin && (
              <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] font-medium bg-blue-600/20 text-blue-400 rounded">
                Admin
              </span>
            )}
          </div>
          <button
            onClick={() => setShowAccount(true)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
          >
            <i className="bi bi-person-circle"></i>
            My Account
          </button>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors"
          >
            <i className="bi bi-box-arrow-right"></i>
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6">{children}</div>
      </main>

      {/* My Account modal */}
      {showAccount && <MyAccountModal onClose={() => setShowAccount(false)} />}
    </div>
  );
}

function NavLink({
  href,
  icon,
  label,
  current,
}: {
  href: string;
  icon: string;
  label: string;
  current: string | null;
}) {
  const isActive = current === href;
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
        isActive
          ? "bg-blue-600/20 text-blue-400"
          : "text-gray-300 hover:text-white hover:bg-gray-800"
      }`}
    >
      <i className={`bi bi-${icon}`}></i>
      {label}
    </Link>
  );
}
