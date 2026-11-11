import { Clock, Globe, Hammer, HardDrive, HeartPulse, type LucideIcon, ShieldAlert, SlidersHorizontal, Variable } from "lucide-react";
import { type BuildType } from "../../../../lib/types";

// Icon per Configuration sub-nav group. Kept here (not in config-groups.ts) so that pure, tested file
// stays presentation-free.
export const CONFIG_GROUP_ICONS: Record<string, LucideIcon> = {
  general: SlidersHorizontal, build: Hammer, environment: Variable, domains: Globe,
  storage: HardDrive, "health-resources": HeartPulse, automation: Clock, danger: ShieldAlert,
};

// Post-deploy rollout states the agent reports via the TUGRA_ROLLOUT marker, mapped to a chip colour.
// `healthy`/`converged` are good outcomes; `rolled_back` is a caution; anything else (rollback_failed,
// failed, unexpected) is an error. Known states get a translated label; an unknown one shows verbatim.
export const ROLLOUT_KNOWN = new Set(["healthy", "converged", "rolled_back", "rollback_failed", "failed"]);

export function rolloutColor(state: string): string {
  if (state === "healthy" || state === "converged") return "var(--c-g)";
  if (state === "rolled_back") return "var(--c-am)";
  return "var(--c-r)";
}

// Deployment origins (Deployment.trigger) that have a translated label; an unknown one shows verbatim, and a
// null trigger (legacy rows) falls back to the kind label.
export const TRIGGER_KNOWN = new Set(["manual", "webhook", "preview", "rollback"]);

/** Human-readable wall-clock duration from a millisecond count (e.g. 1500 → "2s", 83000 → "1m 23s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

/** App-header action clusters: tight gap inside a group. */
export const actionGroup: React.CSSProperties = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" };

/** Groups 2 and 3 carry their own left separator, so a wrap can never strand a free-floating divider. */
export const actionGroupSep: React.CSSProperties = { ...actionGroup, borderLeft: "1px solid var(--c-bd)", paddingLeft: 10, marginLeft: 4 };

export const envField: React.CSSProperties = {
  padding: "6px 9px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "var(--font-mono, monospace)",
};

// Build-pack enum -> existing apps.* label key (reused from the create wizard).
export const BUILD_TYPE_LABEL: Record<BuildType, string> = {
  NIXPACKS: "nixpacks",
  DOCKERFILE: "dockerfile",
  STATIC: "static",
  RAILPACK: "railpack",
  HEROKU: "heroku",
};

// Edit HOW a Git app is built, after create: the build pack and the fields that apply to it. Changing the
// pack clears the other packs' fields server-side. Applies on the next deploy.
// Monorepo base directory: trim, strip a leading "./" or "/" and a trailing "/", and map "", "." and "/"
// to null (repo root). The server stays strict; this just lets a user type a Coolify-style "/apps/api".
export function normalizeBaseDir(s: string): string | null {
  let v = s.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (v === "" || v === ".") v = "";
  return v || null;
}

export function taskRunColor(status: string): string {
  if (status === "SUCCESS") return "var(--c-g)";
  if (status === "FAILED") return "var(--c-r)";
  return "var(--c-am)"; // RUNNING
}

export const volField: React.CSSProperties = {
  width: 64,
  padding: "5px 8px",
  background: "var(--c-el)",
  border: "1px solid var(--c-bd)",
  borderRadius: "var(--r1)",
  color: "var(--c-tx)",
  fontSize: 12,
  fontFamily: "inherit",
};
