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
