"use client";

import { useEffect, useState } from "react";
import { MOBILE_QUERY } from "../lib/responsive";

/**
 * True on mobile-width viewports. SSR-safe: defaults to false (desktop) and
 * switches after mount, so there's no hydration mismatch.
 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mobile;
}
