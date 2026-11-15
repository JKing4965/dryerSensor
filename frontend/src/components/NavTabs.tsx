/**
 * NavTabs.tsx - the Live / Cycles / Lint navigation tabs at the top of every page.
 *
 * What it does:
 *   Renders the three links and highlights the one for the current page.
 *   A browser component because it reads the current URL (usePathname).
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
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex gap-1">
      {TABS.map(({ href, label }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
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
