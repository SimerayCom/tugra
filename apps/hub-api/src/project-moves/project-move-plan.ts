import { PROJECT_MOVE_BLOCKERS, PROJECT_MOVE_WARNINGS, type ProjectMoveBlockerCode, type ProjectMoveItemKind, type ProjectMoveWarningCode } from "@tugra/shared";

/**
 * Planning a project move (lane H), pure: which of a project's items move, in what order, and what stops the move. The service loads the
 * facts, this decides. Names, ids and fixed codes only; no value of any variable or credential.
 *
 * What moves: every application (a compose "service" is an application here), every database, with their volumes and domains. An app's
 * own move (volumes, domains, the safety copy) is the existing app move; a database's data moves by a backup restored into a copy on the
 * target (the platform has no volume transfer for a database), so a database needs a backup destination both servers can reach.
 */

export { PROJECT_MOVE_BLOCKERS, PROJECT_MOVE_WARNINGS };

export interface PlanBlocker {
  code: ProjectMoveBlockerCode;
  /** The item (name) or server the blocker is about. */
  ref?: string;
  /** For `app_preflight_failed`: the app move preflight's own blocker codes. */
  codes?: string[];
}

export interface PlanApp {
  id: string;
  name: string;
  serverId: string;
  status: string;
  /** Managed databases linked to this app (links are per server, so the move unlinks and relinks them). */
  linkedDbIds: string[];
}
export interface PlanDb {
  id: string;
  name: string;
  engine: string;
  serverId: string;
  status: string;
  backupDestinationId: string | null;
  extraVolumes: number;
  pitrEnabled: boolean;
  /** Ids of apps outside this project that are linked to it. */
  outsideLinkedApps: string[];
}

export interface PlanInput {
  sourceServerId: string | null;
  targetServerId: string;
  apps: PlanApp[];
  dbs: PlanDb[];
  agentOnline: { source: boolean; target: boolean };
  serversReady: { source: boolean; target: boolean };
  /** Engines whose data can be dumped and restored (the backup pipeline). */
  backupEngines: ReadonlySet<string>;
  activeProjectMove: boolean;
  /** Per app id: the app move preflight's blockers (codes only), already filtered of the ones the project move resolves itself. */
  appPreflight: Record<string, string[]>;
  appsWithActiveMove: ReadonlySet<string>;
}

export interface PlannedItem {
  kind: ProjectMoveItemKind;
  refId: string;
  name: string;
  /** Databases first: the apps that use them follow once the data is there. */
  order: number;
  /** A NEW (never deployed) database has no data: only its configuration moves. */
  configOnly: boolean;
}

export interface Plan {
  sourceServerId: string | null;
  items: PlannedItem[];
  blockers: PlanBlocker[];
  warnings: Array<{ code: ProjectMoveWarningCode; ref?: string }>;
}

/** The preflight blockers the project move clears itself (it unlinks the app's databases and switches the database network off first). */
export const SELF_RESOLVED_APP_BLOCKERS: readonly string[] = ["db_links_exist", "db_network"];

/** The server that is the move's source: the one named, else the only one the project's items sit on. */
export function resolveSource(requested: string | undefined, apps: readonly { serverId: string }[], dbs: readonly { serverId: string }[]): { serverId: string | null; several: boolean } {
  if (requested) return { serverId: requested, several: false };
  const servers = new Set([...apps.map((a) => a.serverId), ...dbs.map((d) => d.serverId)]);
  if (servers.size === 1) return { serverId: [...servers][0], several: false };
  return { serverId: null, several: servers.size > 1 };
}

export function planProjectMove(input: PlanInput): Plan {
  const blockers: PlanBlocker[] = [];
  const warnings: Plan["warnings"] = [];
  const block = (b: PlanBlocker) => blockers.push(b);
  const src = input.sourceServerId;

  const apps = input.apps.filter((a) => a.serverId === src);
  const dbs = input.dbs.filter((d) => d.serverId === src);
  const behind = input.apps.length - apps.length + (input.dbs.length - dbs.length);

  if (!src) block({ code: "items_on_several_servers" });
  if (src && src === input.targetServerId) block({ code: "same_server" });
  if (src && apps.length + dbs.length === 0) block({ code: "empty_project" });
  if (input.activeProjectMove) block({ code: "project_move_active" });
  if (!input.agentOnline.source) block({ code: "agent_offline_source", ref: src ?? undefined });
  if (!input.agentOnline.target) block({ code: "agent_offline_target", ref: input.targetServerId });
  if (!input.serversReady.source || !input.serversReady.target) block({ code: "server_not_ready" });
  if (behind > 0) warnings.push({ code: "items_left_behind" });

  const inProject = new Set([...apps.map((a) => a.id)]);
  for (const d of dbs) {
    const configOnly = d.status === "NEW";
    if (!configOnly && d.status !== "RUNNING") block({ code: "db_not_ready", ref: d.name });
    if (configOnly) {
      warnings.push({ code: "db_config_only", ref: d.name });
      continue;
    }
    if (!input.backupEngines.has(d.engine)) block({ code: "db_engine_unsupported", ref: d.name });
    if (!d.backupDestinationId) block({ code: "db_needs_s3_destination", ref: d.name });
    // the extra volumes travel with the database: copied volume by volume while it is stopped, after its data was restored
    if (d.extraVolumes > 0) warnings.push({ code: "db_extra_volumes_carried", ref: d.name });
    if (d.outsideLinkedApps.some((id) => !inProject.has(id))) block({ code: "db_linked_outside", ref: d.name });
    if (d.pitrEnabled) warnings.push({ code: "pitr_not_carried", ref: d.name });
  }

  for (const a of apps) {
    if (input.appsWithActiveMove.has(a.id)) block({ code: "app_move_active", ref: a.name });
    const codes = (input.appPreflight[a.id] ?? []).filter((c) => !SELF_RESOLVED_APP_BLOCKERS.includes(c));
    if (codes.length) block({ code: "app_preflight_failed", ref: a.name, codes });
    if (a.linkedDbIds.length) warnings.push({ code: "app_redeploy_after_relink", ref: a.name });
  }

  const items: PlannedItem[] = [
    ...dbs.map((d, i) => ({ kind: "database" as const, refId: d.id, name: d.name, order: i, configOnly: d.status === "NEW" })),
    ...apps.map((a, i) => ({ kind: "application" as const, refId: a.id, name: a.name, order: dbs.length + i, configOnly: false })),
  ];
  return { sourceServerId: src, items, blockers, warnings };
}

/** Pure ordering helper: apps that use no database first would shorten nothing here; keep input order, databases before apps. */
export const isTerminalPhase = (p: string): boolean => p === "COMPLETED" || p === "ROLLED_BACK" || p === "FAILED";
