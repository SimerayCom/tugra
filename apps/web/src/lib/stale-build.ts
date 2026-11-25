/**
 * After a hub update, a tab that stayed open still runs the previous build. Its next client-side navigation asks for
 * code chunks that the new web image no longer serves, and the page fails with a chunk-load error ("Something went
 * wrong"; a manual refresh fixes it). These helpers recognise that case so the error screen can reload once by itself.
 */
const STALE_PATTERNS = [
  /ChunkLoadError/i,
  /Loading (CSS )?chunk [^ ]+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

export function isStaleBuildError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; message?: unknown };
  const text = `${typeof e.name === "string" ? e.name : ""} ${typeof e.message === "string" ? e.message : ""}`;
  return STALE_PATTERNS.some((re) => re.test(text));
}

const KEY = "tg_stale_reload_at";
/** Reload at most once a minute, so a genuinely broken chunk can't put the tab in a reload loop. */
const WINDOW_MS = 60_000;

/** Reload the page to pick up the new build. Returns false when a reload already happened within the last minute. */
export function reloadForNewBuild(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (now - last < WINDOW_MS) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // storage blocked: still reload once; the next failure shows the error screen
  }
  window.location.reload();
  return true;
}
