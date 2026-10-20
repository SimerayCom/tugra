import type { MouseEvent } from "react";

/**
 * True when a click landed on (or inside) an interactive element — a link, button, input,
 * select, textarea, label, or anything with role="button". Row-level navigation uses this to
 * defer to the thing the user actually clicked (an action button, a checkbox, the name link)
 * instead of hijacking it, so whole-row clicks navigate while nested controls keep working.
 */
export function clickedInteractive(e: MouseEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el?.closest("a, button, input, select, textarea, label, [role='button']");
}
