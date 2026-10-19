import type { Application } from "./types";

/** What the app-store knows about a template that is already deployed on this instance. */
export interface InstalledInfo {
  count: number; // how many apps were installed from this template
  running: boolean; // at least one of them is RUNNING
  firstId: string; // id of the first install (for a deep-link to manage it)
  url: string | null; // a reachable URL to "Open" — only ever from a RUNNING install that has one
}

/**
 * Index the user's installed apps by the catalog template they came from, so the store can show an
 * "Installed / Running" badge and an Open shortcut instead of letting the user deploy a duplicate by accident.
 * Apps created manually (no templateSlug) are ignored. The Open URL is taken only from a RUNNING install that
 * has a URL — a stopped app's URL would not actually open.
 */
export function installedBySlug(apps: Application[]): Map<string, InstalledInfo> {
  const map = new Map<string, InstalledInfo>();
  for (const a of apps) {
    if (!a.templateSlug) continue;
    const running = a.status === "RUNNING";
    const prev = map.get(a.templateSlug);
    if (!prev) {
      map.set(a.templateSlug, { count: 1, running, firstId: a.id, url: running ? a.url : null });
    } else {
      prev.count += 1;
      if (running) {
        prev.running = true;
        if (!prev.url && a.url) prev.url = a.url; // prefer a running install's URL for Open
      }
    }
  }
  return map;
}
