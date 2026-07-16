/**
 * Product editions for the open-core boundary — a low (community) to high (cloud) ordering. Pure and
 * dependency-free (no `process`, no @types/node) so it is safe to transpile into BOTH the node hub and
 * the web bundle. The hub's `requireEdition` gate and any web edition display share this one source.
 *
 * community — the fully-featured self-hosted OSS product (everything shipped today).
 * pro       — self-hosted, licensed add-ons (SSO, audit export/retention, custom roles, whitelabel, …).
 * cloud     — the hosted multi-tenant SaaS control plane.
 */
export const EDITIONS = ["community", "pro", "cloud"] as const;
export type Edition = (typeof EDITIONS)[number];

/** Coerce an arbitrary/env value to a known edition, defaulting to "community" (fail-safe: an unknown
 *  or unset value never accidentally unlocks a higher tier). */
export function normalizeEdition(value?: string | null): Edition {
  return (EDITIONS as readonly string[]).includes(value ?? "") ? (value as Edition) : "community";
}

/** Whether `current` is at least the `required` edition in the community < pro < cloud ordering. */
export function editionAtLeast(current: Edition, required: Edition): boolean {
  return EDITIONS.indexOf(current) >= EDITIONS.indexOf(required);
}
