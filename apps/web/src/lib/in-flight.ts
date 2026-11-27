import type { InFlightItem, InFlightKind } from "./types";

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** The four words an update summary uses. */
export type InFlightGroup = "migration" | "deployment" | "backup" | "operation";

const GROUP: Record<InFlightKind, InFlightGroup> = {
  "migration-run": "migration",
  takeover: "migration",
  cutover: "migration",
  "project-move": "migration",
  "app-move": "migration",
  "volume-transfer": "migration",
  "object-migration": "migration",
  cleanup: "migration",
  import: "migration",
  deployment: "deployment",
  rollout: "deployment",
  backup: "backup",
  restore: "backup",
  "pitr-restore": "backup",
  "restore-verify": "backup",
  "agent-update": "operation",
  swarm: "operation",
  patch: "operation",
  reboot: "operation",
  "bulk-command": "operation",
};
const ORDER: InFlightGroup[] = ["migration", "deployment", "backup", "operation"];

/** "2 migrations, 1 backup": the counts per group, `inFlight.group_<g>_one` / `_other` keys. */
export function inFlightCounts(t: Tr, items: readonly InFlightItem[]): string {
  const n = new Map<InFlightGroup, number>();
  for (const i of items) n.set(GROUP[i.kind], (n.get(GROUP[i.kind]) ?? 0) + 1);
  return ORDER.filter((g) => n.has(g))
    .map((g) => t(`inFlight.group_${g}_${n.get(g) === 1 ? "one" : "other"}`, { n: n.get(g)! }))
    .join(", ");
}

/** "Held: 2 migrations in progress" */
export function heldSummary(t: Tr, items: readonly InFlightItem[]): string {
  return t("inFlight.held", { what: inFlightCounts(t, items) });
}

const SERVER_PAGE: ReadonlySet<InFlightKind> = new Set(["takeover", "cleanup", "reboot", "patch", "agent-update"]);

/** Where the work can be looked at, for the kinds that have a page of their own; null for the rest. */
export function inFlightHref(i: InFlightItem): string | null {
  switch (i.kind) {
    case "migration-run":
      return `/import/runs/${i.id}`;
    case "object-migration":
      return `/migrations/objects/${i.id}`;
    case "rollout":
      return `/rollouts/${i.id}`;
    case "swarm":
      return `/clusters/${i.id}`;
    default:
      return SERVER_PAGE.has(i.kind) && i.serverIds[0] ? `/servers/${i.serverIds[0]}` : null;
  }
}

/** One plain line per item, for places that only take text (a confirm dialog body, a toast). */
export function inFlightLines(t: Tr, items: readonly InFlightItem[], max = 5): string {
  const shown = items.slice(0, max).map((i) => `${t(`inFlight.kind.${i.kind}`)}: ${i.label}`);
  if (items.length > max) shown.push(t("inFlight.more", { n: items.length - max }));
  return shown.join("\n");
}

/** The held items out of a 409 `migration-active` ApiError body (`inFlight`), or null when it is some other error. */
export function heldFromError(e: unknown): InFlightItem[] | null {
  const err = e as { status?: number; code?: string; data?: Record<string, unknown> } | null;
  if (!err || err.status !== 409 || err.code !== "migration-active") return null;
  const list = err.data?.inFlight;
  return Array.isArray(list) ? (list as InFlightItem[]) : [];
}
