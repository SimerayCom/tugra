/** Breakpoint helpers for the responsive shell (mobile-first). */

export const MOBILE_MAX = 767;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX}px)`;

/** True when a viewport width should use the mobile (off-canvas drawer) layout. */
export function isMobileWidth(width: number): boolean {
  return width <= MOBILE_MAX;
}
