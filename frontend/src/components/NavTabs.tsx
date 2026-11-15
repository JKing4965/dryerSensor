/**
 * NavTabs.tsx - the Live / Cycles / Lint navigation tabs at the top of every page.
 *
 * What it does:
 *   NavTabs reads the current URL (usePathname) and highlights the matching tab.
 *   NavTabsList draws the tabs for a given active path; layout.tsx shows it with
 *   no highlight as the <Suspense> fallback while the URL isn't known yet
 *   (required by Next.js' cacheComponents mode on pages like /cycles/[id]).
 *
 * Talks to:
 *   - Used by src/app/layout.tsx.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Live" },
  { href: "/cycles", label: "Cycles" },
  { href: "/lint", label: "Lint" },
] as const;

export default function NavTabs() {
  return <NavTabsList pathname={usePathname()} />;
}

export function NavTabsList({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="flex gap-1">
      {TABS.map(({ href, label }) => {
        const active = pathname !== null && (href === "/" ? pathname === "/" : pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex-1 rounded-md px-3 py-2 text-center text-sm font-medium transition-colors sm:flex-none ${
              active ? "bg-accent text-white" : "text-muted hover:bg-border/60 hover:text-foreground"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
