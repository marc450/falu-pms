"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const { session, loading, signOut, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const isLoginPage = pathname === "/login";

  useEffect(() => {
    if (loading) return;
    if (!session && !isLoginPage) {
      router.replace("/login");
    }
    if (session && isLoginPage) {
      router.replace("/");
    }
  }, [loading, session, isLoginPage, router]);

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

  // Authenticated — full app shell with sidebar
  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
        {/* Brand */}
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">F</span>
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">FALU PMS</h1>
              <p className="text-xs text-gray-500">Production Monitoring</p>
            </div>
          </div>
        </div>

        {/* Nav links */}
        <nav className="flex-1 p-3 space-y-1">
          <NavLink href="/" icon="speedometer2" label="Dashboard" current={pathname} />
          <NavLink href="/analytics" icon="bar-chart-line" label="Analytics" current={pathname} />
          <NavLink href="/settings" icon="gear" label="Settings" current={pathname} />
        </nav>

        {/* User + logout */}
        <div className="p-3 border-t border-gray-800">
          <div className="px-3 py-2 mb-1">
            <p className="text-xs text-gray-500 truncate">{user?.email}</p>
          </div>
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
