"use client";

import { useEffect, useRef } from "react";

/**
 * Re-masks a revealed secret after it has been shown for 30s, and immediately whenever the tab
 * is hidden — so a revealed value never lingers on screen (shoulder-surfing / screen-share leak).
 *
 * Pass whether anything is currently revealed (`active`) and the callback that re-masks
 * everything. The timer is keyed on `active` alone (the callback is read through a ref), so it
 * does NOT reset on unrelated re-renders, and for a multi-value reveal it counts from the FIRST
 * reveal rather than restarting on each — a deliberate upper bound on how long secrets stay up.
 *
 * Extracted from CopyRow so the env editor's reveal-all + per-row reveals share the exact same
 * safety behaviour instead of re-implementing it.
 */
export function useAutoMask(active: boolean, remask: () => void) {
  const remaskRef = useRef(remask);
  remaskRef.current = remask;
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => remaskRef.current(), 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") remaskRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active]);
}
