"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps an open workspace page current without a manual reload. The page is re-rendered on the server
 * every interval while its tab is visible, and again the moment the tab is brought back into view.
 *
 * Reading stays on the server, so role scoping and field redaction still decide what comes back — the
 * browser never reads Firestore directly. Refreshing pauses while the tab is hidden, so a page left
 * open overnight does not run up reads, and two refreshes never land within a few seconds of each other.
 */
export function LiveRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  const lastRefresh = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    function refresh() {
      const now = Date.now();
      if (now - lastRefresh.current < 5000) return;
      lastRefresh.current = now;
      router.refresh();
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    }

    function start() {
      stop();
      timer = setInterval(refresh, Math.max(5, seconds) * 1000);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refresh();
        start();
      } else {
        stop();
      }
    }

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, seconds]);

  return null;
}
