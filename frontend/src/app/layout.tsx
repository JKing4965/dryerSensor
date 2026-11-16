/**
 * layout.tsx - the frame around every page: app title, navigation tabs, page width.
 *
 * What it does:
 *   Sets the page title, fonts and colors (globals.css), and renders the header
 *   with NavTabs above whichever page is open, plus the lint reminder banner
 *   (shown on every page while the lint screen needs cleaning), and a "Log out"
 *   link when login is on (DASHBOARD_PASSWORD set; read when the app is built).
 *   Mobile first: tabs fill the width on a phone and sit next to the title on wider screens.
 *
 * Talks to:
 *   - src/components/NavTabs.tsx, LintReminder.tsx, LogoutButton.tsx, src/lib/auth.ts,
 *     src/app/globals.css
 *   - Wraps src/app/page.tsx (Live), cycles/page.tsx and lint/page.tsx.
 */
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";

import LintReminder from "@/components/LintReminder";
import LogoutButton from "@/components/LogoutButton";
import NavTabs, { NavTabsList } from "@/components/NavTabs";
import { authEnabled } from "@/lib/auth";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dryer Lint Monitor",
  description: "Live dryer sensor data, cycle history and lint status",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <header className="sticky top-0 z-10 border-b border-border bg-card/90 backdrop-blur">
          <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-base font-semibold">Dryer Lint Monitor</h1>
              {authEnabled() && <LogoutButton />}
            </div>
            <Suspense fallback={<NavTabsList pathname={null} />}>
              <NavTabs />
            </Suspense>
          </div>
        </header>
        <LintReminder />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
