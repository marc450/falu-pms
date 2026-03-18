import type { Metadata } from "next";
import "./globals.css";
import AuthLayout from "@/components/AuthLayout";

export const metadata: Metadata = {
  title: "U.S. COTTON - Production Monitoring",
  description: "U.S. Cotton production monitoring system",
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
        <AuthLayout>{children}</AuthLayout>
      </body>
    </html>
  );
}
