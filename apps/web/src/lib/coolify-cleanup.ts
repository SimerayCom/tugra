import type { CleanupRemnant, CleanupView, CompletenessRow } from "@tugra/shared";
import { ApiError } from "./api";

/** The i18n key of a failed cleanup call: the hub's stable code when it has a line, else a status-based one. */
export function cleanupErrorKey(e: unknown): string {
  if (e instanceof ApiError) {
    const known = ["incomplete", "list_changed", "not_ready", "cleanup_active", "control_plane", "no_coolify_link", "read_stale", "confirm_name_mismatch"];
    if (e.code && known.includes(e.code)) return `coolifyCleanup.error.${e.code}`;
    if (e.status === 403) return "coolifyCleanup.error.forbidden";
    if (e.status === 503) return "coolifyCleanup.error.offline";
  }
  return "coolifyCleanup.error.generic";
}

/** The i18n key of a stored failure code. */
export function cleanupFailureKey(code: string | null): string | null {
  if (!code) return null;
  return `coolifyCleanup.failure.${code}`;
}

export function splitRemnants(remnants: readonly CleanupRemnant[]): { removable: CleanupRemnant[]; kept: CleanupRemnant[] } {
  return { removable: remnants.filter((r) => !r.keep), kept: remnants.filter((r) => r.keep) };
}

/** A row the owner has to act on: something missing, or a side that could not be read. */
export const rowNeedsAttention = (r: CompletenessRow): boolean => r.missing.length > 0 || !!r.unreadable || r.tugra < r.coolify;

/** Whether the confirm button may be offered at all: the checklist is complete, the state is READY and there is a list to quote. */
export function canOfferConfirm(v: CleanupView | null | undefined): v is CleanupView & { listHash: string } {
  return !!v && v.status === "READY" && v.complete && !!v.listHash && splitRemnants(v.remnants).removable.length > 0;
}

/** Docker's sizes are bytes here; one short unit. */
export function sizeText(n: number | null): string {
  if (n === null || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
