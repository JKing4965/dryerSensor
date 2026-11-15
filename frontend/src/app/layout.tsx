/**
 * layout.tsx - the frame around every page: app title, navigation tabs, page width.
 *
 * What it does:
 *   Sets the page title, fonts and colors (globals.css), and renders the header
 *   with NavTabs above whichever page is open. Mobile first: tabs fill the width
 *   on a phone and sit next to the title on wider screens.
 *
 * Talks to:
 *   - src/components/NavTabs.tsx, src/app/globals.css
 *   - Wraps src/app/page.tsx (Live), cycles/page.tsx and lint/page.tsx.
 */
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";

import NavTabs, { NavTabsList } from "@/components/NavTabs";

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
            <h1 className="text-base font-semibold">Dryer Lint Monitor</h1>
            <Suspense fallback={<NavTabsList pathname={null} />}>
              <NavTabs />
            </Suspense>
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
