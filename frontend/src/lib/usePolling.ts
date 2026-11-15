/**
 * usePolling.ts - React hook that fetches a JSON URL every few seconds.
 *
 * What it does:
 *   Fetches `url` right away, then again `intervalMs` after each response finishes
 *   (so slow responses never pile up). It pauses while the browser tab is hidden
 *   and refreshes as soon as it becomes visible again.
 *   Returns { data, error, loading, refresh }. On an error the last good data is
 *   kept, so charts don't flash empty during a brief hiccup.
 *   refresh() refetches this one now; refreshAll() refetches every polling component
 *   on the page (used after pressing "Filter cleaned").
 *
 * Talks to:
 *   - The API routes in src/app/api/. Used by browser components such as LiveView.tsx.
 */
"use client";

import { useEffect, useState } from "react";

interface PollState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Fire this anywhere (e.g. after "Filter cleaned") to make every usePolling refetch now. */
export const REFRESH_EVENT = "dryer:refresh";

export function refreshAll(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

export function usePolling<T>(url: string, intervalMs = 2000): PollState<T> & { refresh: () => void } {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const refresh = () => setNonce((n) => n + 1);

  useEffect(() => {
    const onRefresh = () => setNonce((n) => n + 1);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(REFRESH_EVENT, onRefresh);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let stopped = false;

    async function tick() {
      if (stopped) return;
      if (document.visibilityState === "hidden") return; // resumed by onVisible
      controller = new AbortController();
      try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        const body = await res.json();
        if (!res.ok) throw new Error(body?.detail ? `${body.error}: ${body.detail}` : body?.error ?? res.statusText);
        setState({ data: body as T, error: null, loading: false });
      } catch (e) {
        if (stopped || (e instanceof DOMException && e.name === "AbortError")) return;
        setState((prev) => ({ ...prev, error: e instanceof Error ? e.message : String(e), loading: false }));
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    }

    tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, intervalMs, nonce]); // a new nonce restarts polling = fetch right away

  return { ...state, refresh };
}
