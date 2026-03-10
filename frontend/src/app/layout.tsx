import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "FALU PMS - Production Monitoring",
  description: "Cotton swab production monitoring system",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"
        />
      </head>
      <body className="antialiased min-h-screen">
        {/* Sidebar */}
        <div className="flex min-h-screen">
          <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
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
            <nav className="flex-1 p-3 space-y-1">
              <Link
                href="/"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              >
                <i className="bi bi-speedometer2"></i>
                Dashboard
              </Link>
              <Link
                href="/settings"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              >
                <i className="bi bi-gear"></i>
                Settings
              </Link>
              <Link
                href="/downloads"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              >
                <i className="bi bi-download"></i>
                Logfiles
              </Link>
              <Link
                href="/debug"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              >
                <i className="bi bi-bug"></i>
                Debug
              </Link>
            </nav>
          </aside>

          {/* Main content */}
          <main className="flex-1 overflow-auto">
            <div className="p-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
