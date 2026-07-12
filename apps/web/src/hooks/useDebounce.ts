"use client";

import { useEffect, useState } from "react";

/** Returns `value` delayed by `ms` — the returned value only updates after `ms` of no changes.
 *  Used to debounce the log-search box so each keystroke doesn't restart the SSE stream. */
export function useDebounce<T>(value: T, ms = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
