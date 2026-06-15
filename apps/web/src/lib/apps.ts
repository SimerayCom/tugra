import type { AppStatus, DeploymentStatus } from "./types";

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
