"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Keep a scrollable log box pinned to its newest line as content grows — but only while the user is ALREADY
 * near the bottom, so scrolling up to read older output is never yanked back down. Pass the changing content
 * (or its length) as `dep` so it re-pins on each append. Used by the live apt-patch / proxy log <pre>s, which
 * otherwise never follow their tail (plain overflow:auto boxes with no scroll logic).
 *
 * The "am I near the bottom?" decision is tracked from the USER'S scrolls (a ref updated on each scroll), NOT
 * measured inside the content-change effect — by then the new content is already laid out, so a chunk taller
 * than the slack would read as "not at the bottom" and wrongly stop following. Deciding from the pre-append
 * position keeps the tail following no matter how large the next chunk is.
 */
export function useStickToBottom<T extends HTMLElement>(dep: unknown): RefObject<T | null> {
  const ref = useRef<T>(null);
  const stuck = useRef(true); // follow by default until the user scrolls away
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // ~40px slack so a line or two of jitter still counts as "at the bottom".
    const onScroll = () => { stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}
