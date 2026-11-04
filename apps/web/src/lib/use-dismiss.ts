import { useEffect, useRef, type RefObject } from "react";

/**
 * Close a popover/menu when, while `active`, the user points down outside `ref` or presses Escape. Attach
 * `ref` to the element that wraps BOTH the trigger and the popover, so clicking the trigger (which toggles)
 * counts as "inside" and never races the toggle. `onClose` is read through a ref, so callers can pass an
 * inline closure without memoising it (the listeners don't re-subscribe every render).
 */
export function useDismiss(active: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cb.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, ref]);
}
