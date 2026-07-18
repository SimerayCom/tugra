import type { AppStatus, DeploymentStatus } from "./types";
import { hubPublicUrl } from "./api";

export function appColor(s: AppStatus): string {
  if (s === "RUNNING") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  if (s === "STOPPED") return "var(--c-am)";
  return "var(--c-tx3)";
}

export function deploymentColor(s: DeploymentStatus): string {
  if (s === "SUCCESS") return "var(--c-g)";
  if (s === "FAILED") return "var(--c-r)";
  return "var(--c-am)";
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

/** The public webhook URL a user pastes into GitHub/GitLab for auto-deploy. This is called by an
 *  external service directly against the hub, so it must be the hub's absolute public URL — not the
 *  SPA's same-origin "/api" proxy path. */
export function webhookUrl(token: string): string {
  return `${hubPublicUrl()}/webhooks/deploy/${token}`;
}
