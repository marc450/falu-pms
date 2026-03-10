import type { Metadata } from "next";
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
      <body className="antialiased">
        {/* Navigation Header */}
        <header className="bg-white border-b border-slate-200 sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                  <span className="text-white font-bold text-sm">F</span>
                </div>
                <div>
                  <h1 className="text-sm font-bold text-slate-900">
                    FALU PMS
                  </h1>
                  <p className="text-xs text-slate-400">
                    Production Monitoring
                  </p>
                </div>
              </div>
              <nav className="flex items-center gap-6">
                <a
                  href="/"
                  className="text-sm font-medium text-blue-600 hover:text-blue-800"
                >
                  Dashboard
                </a>
                <a
                  href="/machines"
                  className="text-sm font-medium text-slate-500 hover:text-slate-800"
                >
                  Machines
                </a>
                <a
                  href="/history"
                  className="text-sm font-medium text-slate-500 hover:text-slate-800"
                >
                  History
                </a>
              </nav>
            </div>
          </div>
        </header>

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
