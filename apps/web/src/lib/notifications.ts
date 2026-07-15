import type { DeliveryStatus } from "./types";

/** Status → CSS color for a delivery row (mirrors lib/backups.ts:backupColor). */
export function deliveryColor(s: DeliveryStatus): string {
  if (s === "SENT") return "var(--c-g)";
  if (s === "FAILED" || s === "DEAD") return "var(--c-r)";
  return "var(--c-am)"; // PENDING
}
