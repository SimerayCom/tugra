// Pure derivation of the status badges a container deserves from its last-known runtime state.
// Lives outside JSX so it's unit-testable without a DOM. Labels are resolved in the component via i18n
// (`apps.crash.badge_<key>`); the `vars` go straight into the {interpolation} of that key.
//
// Guardrails (see container-health runner): ContainerState.exitCode defaults to 0 and a *running*
// container still carries its last exit code — so the "exit" badge only fires when the container is not
// currently running, otherwise we'd paint a false "Exit 0". A restart count > 0 is surfaced on its own
// because a crash-looping container is often "running" again by the time we poll it.

export type ContainerBadgeKey = "restarts" | "exit" | "oom" | "unhealthy";

export interface ContainerBadge {
  key: ContainerBadgeKey;
  tone: "danger" | "warn";
  vars?: Record<string, string | number>;
}

export interface BadgeableContainer {
  status?: string;
  restartCount?: number;
  exitCode?: number;
  oomKilled?: boolean;
  health?: string | null;
}

export function containerBadges(c: BadgeableContainer): ContainerBadge[] {
  const badges: ContainerBadge[] = [];
  const restarts = c.restartCount ?? 0;
  const running = (c.status ?? "").toLowerCase() === "running";

  if (restarts > 0) badges.push({ key: "restarts", tone: "warn", vars: { n: restarts } });
  if (c.oomKilled) badges.push({ key: "oom", tone: "danger" });
  if ((c.exitCode ?? 0) !== 0 && !running) badges.push({ key: "exit", tone: "danger", vars: { code: c.exitCode ?? 0 } });
  if ((c.health ?? "").toLowerCase() === "unhealthy") badges.push({ key: "unhealthy", tone: "warn" });

  return badges;
}
