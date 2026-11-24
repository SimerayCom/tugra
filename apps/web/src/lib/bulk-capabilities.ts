import type { ServerView } from "./types";

/** The opt-in capabilities the bulk dialog can grant or revoke. Order = display order; `files_write` builds on `files`. */
export const BULK_CAPABILITIES = ["terminal", "files", "files_write", "swarm"] as const;
export type BulkCapability = (typeof BULK_CAPABILITIES)[number];
export type BulkMode = "grant" | "revoke";

/** What applying `mode` + `caps` would do to one server: the capabilities it gains/loses, and why it is skipped. */
export interface BulkCapPlanRow {
  id: string;
  name: string;
  changes: string[]; // capabilities actually added (grant) or removed (revoke), incl. files_write dropped with files
  blocked: "readonly" | "files_write_requires_files" | null;
}

/**
 * Preview exactly what a bulk grant/revoke does, mirroring the hub's rules, so the confirmation dialog can list it:
 * a read-only server is skipped, `files_write` needs `files` (granted together or already present), and revoking
 * `files` also revokes `files_write`. The hub re-checks all of it; this is for the preview only.
 */
export function planBulkCapabilities(servers: readonly ServerView[], selectedIds: ReadonlySet<string>, mode: BulkMode, caps: readonly string[]): BulkCapPlanRow[] {
  const picked = new Set(caps);
  return servers
    .filter((s) => selectedIds.has(s.id))
    .map((s): BulkCapPlanRow => {
      if (!s.canWrite) return { id: s.id, name: s.name, changes: [], blocked: "readonly" };
      const have = new Set(s.capabilities);
      if (mode === "grant") {
        if (picked.has("files_write") && !picked.has("files") && !have.has("files")) {
          return { id: s.id, name: s.name, changes: [], blocked: "files_write_requires_files" };
        }
        return { id: s.id, name: s.name, changes: BULK_CAPABILITIES.filter((c) => picked.has(c) && !have.has(c)), blocked: null };
      }
      const drop = new Set(picked);
      if (picked.has("files")) drop.add("files_write");
      return { id: s.id, name: s.name, changes: BULK_CAPABILITIES.filter((c) => drop.has(c) && have.has(c)), blocked: null };
    });
}

/** Toggle one capability in the dialog's pick list. Granting `files_write` also picks `files`; unpicking `files` unpicks `files_write` when granting. */
export function togglePick(prev: readonly string[], cap: string, mode: BulkMode): string[] {
  const next = new Set(prev);
  if (next.has(cap)) {
    next.delete(cap);
    if (cap === "files" && mode === "grant") next.delete("files_write");
  } else {
    next.add(cap);
    if (cap === "files_write" && mode === "grant") next.add("files");
  }
  return BULK_CAPABILITIES.filter((c) => next.has(c));
}
