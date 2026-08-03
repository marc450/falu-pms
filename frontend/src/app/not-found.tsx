"use client";

import Link from "next/link";

function FaluLogo({ className }: { className?: string }) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`${basePath}/falu-logo.svg`} alt="Logo" className={className} />;
}

// Rendered as 404.html in the static export; Cloudflare Pages serves it for
// any path that doesn't match a page or asset. AuthLayout wraps it like every
// route: visitors without a session get redirected to /login, signed-in users
// see this card.
export default function NotFound() {
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
          <div className="flex flex-col items-center text-center gap-3 py-2">
            <div className="w-12 h-12 rounded-full bg-blue-600/20 flex items-center justify-center">
              <i className="bi bi-signpost-split text-blue-400 text-2xl"></i>
            </div>
            <h2 className="text-white font-semibold text-base">Page not found</h2>
            <p className="text-gray-400 text-sm leading-relaxed">
              This page doesn&apos;t exist or has moved. Check the link, or head back to the dashboard.
            </p>
            <Link
              href="/"
              className="mt-2 w-full bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
            >
              <i className="bi bi-speedometer2"></i>
              Go to dashboard
            </Link>
          </div>
        </div>

      </div>
    </div>
  );
}
