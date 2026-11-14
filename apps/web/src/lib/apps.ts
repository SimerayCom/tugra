import type { AppContainerHealth, AppStatus, DeploymentStatus, PrProvider } from "./types";
import { hubPublicUrl } from "./api";

export function appColor(s: AppStatus): string {
  if (s === "RUNNING") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  if (s === "STOPPED") return "var(--c-am)";
  return "var(--c-tx3)";
}

/** What to show for an app's status: the raw lifecycle status, refined by Docker container health when the app
 *  is RUNNING. Returns a `common.status.*` key (render it with statusLabel) and a colour. Missing or `unknown`
 *  health never alarms; an HTTP/CMD check with no Docker HEALTHCHECK is deploy-gated, so it reads plain Running. */
export function appStatusDisplay(app: { status: AppStatus; containerHealth: AppContainerHealth; source: "IMAGE" | "GIT" | "COMPOSE" }): { key: string; color: string } {
  if (app.status !== "RUNNING") return { key: app.status, color: appColor(app.status) };
  const h = app.containerHealth;
  if (h.state === "unhealthy") return { key: "RUNNING_UNHEALTHY", color: "var(--c-r)" };
  if (h.state === "starting") return { key: "STARTING", color: "var(--c-am)" };
  if (h.state === "none" && (app.source === "COMPOSE" || h.checkType === "NONE")) return { key: "RUNNING_NO_HEALTHCHECK", color: "var(--c-g)" };
  return { key: "RUNNING", color: "var(--c-g)" };
}

/** Which extra cleanup opt-ins the delete dialog offers for an app. `networks` are its own custom networks (the
 *  shared tugra-apps bridge is never listed) and only for a classic non-compose app; `buildCache` only for an app
 *  that builds, on a single server. Mirrors the hub's refusals, so the dialog never offers what it would 400. */
export function deleteCleanupOptions(app: { source: "IMAGE" | "GIT" | "COMPOSE"; clusterId: string | null; networks?: string[] | null }): { networks: string[]; buildCache: boolean } {
  const classic = !app.clusterId;
  return {
    networks: app.source !== "COMPOSE" && classic ? (app.networks ?? []).filter((n) => n !== "tugra-apps") : [],
    buildCache: app.source !== "IMAGE" && classic,
  };
}

export function deploymentColor(s: DeploymentStatus): string {
  if (s === "SUCCESS") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  if (s === "CANCELLED") return "var(--c-tx3)"; // muted — the deploy never ran / was dropped
  return "var(--c-am)"; // RUNNING / QUEUED — in progress / waiting to start
}

export function appUrl(app: { domain: string | null; https: boolean }): string | null {
  return app.domain ? `${app.https ? "https" : "http"}://${app.domain}` : null;
}

/** Short source label for lists: image ref or git:branch. */
export function appSourceSummary(app: {
  source: "IMAGE" | "GIT" | "COMPOSE";
  image: string | null;
  gitBranch: string | null;
}): string {
  if (app.source === "COMPOSE") return "compose";
  return app.source === "GIT" ? `git:${app.gitBranch ?? "main"}` : (app.image ?? "");
}

/** Short display form of a pinned image digest ref (`nginx@sha256:abc123…`) → `sha256:abc123def4…`. */
export function shortDigest(ref: string): string {
  const hex = ref.split("@sha256:")[1] ?? "";
  return hex ? `sha256:${hex.slice(0, 10)}…` : ref;
}

/** The public webhook URL a user pastes into GitHub/GitLab for auto-deploy. This is called by an
 *  external service directly against the hub, so it must be the hub's absolute public URL — not the
 *  SPA's same-origin "/api" proxy path. */
export function webhookUrl(token: string): string {
  return `${hubPublicUrl()}/webhooks/deploy/${token}`;
}

/** i18n keys for how a preview's pull / merge request is named: GitLab calls them merge requests ("MR !n"), every
 *  other host (and a legacy row with no provider) says "PR #n". */
export function previewRefLabelKey(provider: PrProvider | null | undefined): "apps.previewItemMr" | "apps.previewItemPr" {
  return provider === "gitlab" ? "apps.previewItemMr" : "apps.previewItemPr";
}

/** Same split for the page-header badge of a preview app. */
export function previewBadgeKey(provider: PrProvider | null | undefined): "apps.previewBadgeMr" | "apps.previewBadge" {
  return provider === "gitlab" ? "apps.previewBadgeMr" : "apps.previewBadge";
}
