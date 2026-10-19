import type { AppStatus } from "./types";

/** The install flow's view of an app coming up after a one-click deploy. AppStatus is coarse (no explicit
 *  "deploying"), so anything not yet RUNNING/FAILED reads as "installing" — a spinner, not a fake step. */
export type InstallPhase = "installing" | "running" | "failed";

export function installPhase(status: AppStatus | null | undefined): InstallPhase {
  if (status === "RUNNING") return "running";
  if (status === "FAILED") return "failed";
  return "installing"; // NEW / STOPPED / unknown → still coming up
}
