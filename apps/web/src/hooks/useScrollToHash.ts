"use client";

import { useEffect } from "react";

/**
 * Deep-link scrolling for in-page anchors such as `#env-<id>`. When `location.hash` is
 * `#<prefix><id>`, wait (a few animation frames) for the element with that id to exist,
 * scroll it into view, then drop the hash so a later re-render does not re-scroll.
 * `ready` gates the lookup until the page content has rendered; it re-runs when it flips
 * and on same-page `hashchange`.
 */
export function useScrollToHash(prefix: string, ready: boolean): void {
  useEffect(() => {
    if (!ready || typeof window === "undefined") return;
    const pattern = new RegExp(`^#${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Za-z0-9_-]+$`);
    let raf = 0;
    const scrollToHash = () => {
      const hash = window.location.hash;
      if (!pattern.test(hash)) return;
      const id = hash.slice(1);
      let tries = 0;
      const tick = () => {
        const node = document.getElementById(id);
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "start" });
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
          return;
        }
        if (tries++ < 40) raf = window.requestAnimationFrame(tick);
      };
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(tick);
    };
    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);
    return () => {
      window.removeEventListener("hashchange", scrollToHash);
      window.cancelAnimationFrame(raf);
    };
  }, [prefix, ready]);
}
