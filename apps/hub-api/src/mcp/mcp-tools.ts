import type { Scope } from "../api-tokens/scopes";
import type { ApplicationsService } from "../applications/applications.service";
import type { ServersService } from "../servers/servers.service";
import type { ClustersService } from "../clusters/clusters.service";
import type { SwarmService } from "../clusters/swarm.service";
import type { DatabasesService } from "../databases/databases.service";
import type { BackupsService } from "../backups/backups.service";
import type { MonitorsService } from "../monitors/monitors.service";

/** The domain services an MCP tool may call. Every read tool passes the caller's `userId` straight
 *  through — team scoping is resolved DB-side inside each service (never trusted from the client). */
export interface McpDeps {
  apps: ApplicationsService;
  servers: ServersService;
  clusters: ClustersService;
  swarm: SwarmService;
  databases: DatabasesService;
  backups: BackupsService;
  monitors: MonitorsService;
}

export interface McpTool {
  name: string;
  description: string;
  /** The API-token scope required to see + call this tool (Phase1: all "read"). */
  scope: Scope;
  /** JSON schema advertised to the client. NOTE: only a hint — a client can call `tools/call` with
   *  arbitrary arguments, so every execute() re-validates/clamps its inputs. */
  inputSchema: Record<string, unknown>;
  execute: (deps: McpDeps, userId: string, args: Record<string, unknown>) => Promise<unknown>;
}

// ── input helpers (never trust the advertised schema) ────────────────────────────────────────────
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required argument: ${key}`);
  return v;
}
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function optBool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}
/** Machine-checkable destructive confirm: the caller must echo the resource's EXACT name in `confirmName`.
 *  Stronger than a `confirm:true` rubber-stamp (which an LLM sets with no friction) — it forces the agent to
 *  have actually looked the resource up, and the error names the exact value to pass so it can self-correct. */
function requireConfirmName(args: Record<string, unknown>, actualName: string, what: string): void {
  if (optStr(args, "confirmName") !== actualName) {
    throw new Error(
      `destructive action refused — pass "confirmName" exactly equal to the ${what}'s name ("${actualName}") to confirm this irreversible operation`,
    );
  }
}
function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
/** Like reqStr but for a REQUIRED integer: throws on a missing/non-numeric value (never silently substitutes a
 *  default the way clampInt does), then clamps an in-range-but-out-of-bounds valid number into [min,max]. Use for
 *  a required, state-defining count (e.g. replicas) — clampInt's default-on-garbage is only for optional args. */
function reqInt(args: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`missing or invalid required argument: ${key} (expected an integer ${min}-${max})`);
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

const idSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as const;
const noArgs = { type: "object", properties: {} } as const;

/** Reduce a Deployment row to LLM-safe metadata: drop the raw build `logs` blob AND the `configSnapshot`
 *  (whose `composeFile` stores user compose YAML verbatim — commonly with hard-coded secrets, and gated behind
 *  apps:config everywhere else). Mirrors what `apps.deployments()` / `get_application`'s view already strip, so
 *  a deploy-only caller can't exfiltrate config a read of the app would deny them. Undefined for a null row. */
function stripDeployment(dep: unknown): Record<string, unknown> | undefined {
  if (!dep || typeof dep !== "object") return undefined;
  const { logs: _logs, configSnapshot: _cs, ...rest } = dep as Record<string, unknown>;
  return rest;
}

/** Run a void lifecycle action (stop/start/restart) then read the app back for its new status. The follow-up
 *  read is best-effort: if it throws (e.g. the app was deleted by a concurrent action in the tiny window after
 *  the mutate already took effect + audited), still report the action as done with application:null, rather than
 *  failing the whole call and implying the mutate didn't happen. */
async function lifecycle(deps: McpDeps, userId: string, id: string, action: "stop" | "start" | "restart"): Promise<unknown> {
  await deps.apps[action](userId, id);
  let application: unknown = null;
  try {
    application = await deps.apps.get(userId, id);
  } catch {
    application = null;
  }
  return { ok: true, action, application };
}

/**
 * Phase1 MCP tool catalog — read-only. Every tool requires the `read` scope (implied by any non-empty
 * token scope set) and returns metadata only: no decrypted secret VALUES ever (env is key-names only,
 * no credential-bearing URLs). Mutate / migrate tools arrive in Phase2/3.
 */
export const MCP_TOOLS: McpTool[] = [
  // ── applications ──
  {
    name: "list_applications",
    description: "List all applications across the teams the caller belongs to (id, name, status, server, domain).",
    scope: "read",
    inputSchema: noArgs,
    execute: (d, userId) => d.apps.list(userId),
  },
  {
    name: "get_application",
    description: "Get one application's full configuration + status by id.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.apps.get(userId, reqStr(a, "id")),
  },
  {
    name: "list_deployments",
    description: "List the deployment history (status, image, timestamps, config changes) of an application.",
    scope: "read",
    inputSchema: idSchema,
    // Strip the raw build `logs` blob — deployment logs can hold secrets and must never reach the LLM
    // context; the metadata (status/image/timestamps/configChanges/rollbackable) is what a list needs.
    execute: async (d, userId, a) => {
      const rows = (await d.apps.deployments(userId, reqStr(a, "id"))) as Array<Record<string, unknown>>;
      return rows.map(({ logs: _logs, ...rest }) => rest);
    },
  },
  {
    name: "get_app_logs",
    description: "Tail the running application's aggregated container logs. Requires write access + read:secrets (logs may contain secrets).",
    scope: "read:secrets",
    inputSchema: { type: "object", properties: { id: { type: "string" }, tail: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["id"] },
    execute: (d, userId, a) => d.apps.appLogs(userId, reqStr(a, "id"), clampInt(a.tail, 1, 1000, 200)),
  },
  {
    name: "list_containers",
    description: "List an application's running containers/tasks (name, state). Requires write access to the app.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.apps.listContainers(userId, reqStr(a, "id")),
  },
  {
    name: "get_app_env_keys",
    description: "List the NAMES of an application's environment variables (values are never returned).",
    scope: "read",
    inputSchema: idSchema,
    execute: async (d, userId, a) => ({ keys: Object.keys(await d.apps.getEnv(userId, reqStr(a, "id"))) }),
  },
  // ── servers ──
  {
    name: "list_servers",
    description: "List the servers (nodes) the caller can access, optionally filtered by status (ONLINE/OFFLINE/PENDING).",
    scope: "read",
    inputSchema: { type: "object", properties: { status: { type: "string" } } },
    execute: (d, userId, a) => {
      const status = optStr(a, "status");
      return d.servers.listForUser(userId, status ? { status: status as never } : undefined);
    },
  },
  {
    name: "get_server",
    description: "Get one server's details (status, IPs, hostname, resources) by id.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.servers.getForUser(userId, reqStr(a, "id")),
  },
  {
    name: "get_server_capabilities",
    description: "List the capabilities granted to a server (deploy, terminal, swarm, …).",
    scope: "read",
    inputSchema: idSchema,
    // #7: grantedCapabilities(serverId) has NO auth check — verify access first via getForUser (throws 403/404).
    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      await d.servers.getForUser(userId, id);
      return { capabilities: await d.servers.grantedCapabilities(id) };
    },
  },
  // ── clusters / swarm ──
  {
    name: "list_clusters",
    description: "List the clusters (server groups) in the caller's teams, optionally filtered by teamId.",
    scope: "read",
    inputSchema: { type: "object", properties: { teamId: { type: "string" } } },
    execute: (d, userId, a) => d.clusters.list(userId, optStr(a, "teamId")),
  },
  {
    name: "get_cluster",
    description: "Get one cluster's detail (members, health rollup, swarm status) by id.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.clusters.get(userId, reqStr(a, "id")),
  },
  {
    name: "get_cluster_status",
    description: "Get the live Docker Swarm status (nodes, reconciliation) of a cluster by id.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.swarm.status(userId, reqStr(a, "id")),
  },
  // ── databases ──
  {
    name: "list_databases",
    description: "List managed databases across the caller's teams (engine, status, server).",
    scope: "read",
    inputSchema: noArgs,
    execute: (d, userId) => d.databases.list(userId),
  },
  {
    name: "get_database",
    description: "Get one managed database's details by id (secret connection values are never returned).",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.databases.get(userId, reqStr(a, "id")),
  },
  {
    name: "list_backups",
    description: "List a database's backups by databaseId (status, size, timestamps).",
    scope: "read",
    inputSchema: { type: "object", properties: { databaseId: { type: "string" } }, required: ["databaseId"] },
    execute: (d, userId, a) => d.backups.list(userId, reqStr(a, "databaseId")),
  },
  // ── monitors ──
  {
    name: "list_monitors",
    description: "List the uptime monitors across the caller's teams (target, state, last check).",
    scope: "read",
    inputSchema: noArgs,
    execute: (d, userId) => d.monitors.list(userId),
  },
  {
    name: "get_monitor",
    description: "Get one uptime monitor's details by id.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.monitors.get(userId, reqStr(a, "id")),
  },

  // ── mutate: application lifecycle (Phase2a) ──────────────────────────────────────────────────────
  // Each is a thin pass-through to the SAME ApplicationsService method the REST route calls — which itself
  // enforces the caller's 'apps:deploy' team permission (requireWrite) and audits 'app.<verb>'. The 'deploy'
  // PAT scope (mirroring the routes' @RequireScopes("deploy")) is filtered + enforced by McpService, so a
  // read-only token can neither see nor call these. All five are reversible / idempotent (single-resource).
  {
    name: "deploy_application",
    description: "Redeploy an application using its currently-stored config (image/git ref). Blocks until the deploy finishes; returns the deployment metadata (build logs + config snapshot are stripped). Does not take a new image/version.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: async (d, userId, a) => ({ ok: true, action: "deploy", deployment: stripDeployment(await d.apps.deploy(userId, reqStr(a, "id"))) }),
  },
  {
    name: "restart_application",
    description: "Request a restart of an application (rolling recreate on swarm, restart on a single server). Returns the app's recorded status after the request (the underlying container action is dispatched best-effort).",
    scope: "deploy",
    inputSchema: idSchema,
    execute: (d, userId, a) => lifecycle(d, userId, reqStr(a, "id"), "restart"),
  },
  {
    name: "stop_application",
    description: "Request an application stop (scale to 0 on swarm, stop on a single server). Returns the app's recorded status after the request.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: (d, userId, a) => lifecycle(d, userId, reqStr(a, "id"), "stop"),
  },
  {
    name: "start_application",
    description: "Request a start of a stopped application (scale back to its replica count on swarm, start on a single server). Returns the app's recorded status after the request.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: (d, userId, a) => lifecycle(d, userId, reqStr(a, "id"), "start"),
  },
  {
    name: "rollback_application",
    description: "Roll an application back to a prior deployment (redeploys that deployment's retained image/artifact — the 'undo a bad deploy' action). Blocks until it finishes; returns the new deployment metadata (build logs + config snapshot stripped).",
    scope: "deploy",
    inputSchema: { type: "object", properties: { id: { type: "string" }, deploymentId: { type: "string" } }, required: ["id", "deploymentId"] },
    execute: async (d, userId, a) => ({
      ok: true,
      action: "rollback",
      deployment: stripDeployment(await d.apps.rollback(userId, reqStr(a, "id"), reqStr(a, "deploymentId"))),
    }),
  },

  // ── mutate: cluster / swarm operation (Phase2b) ──────────────────────────────────────────────────
  // Thin pass-throughs to the SwarmService methods the REST routes call — each self-enforces the
  // 'servers:manage' team permission. Scope mirrors the route: formation/growth/config = 'deploy'
  // (@RequireScopes("deploy")); the destructive dissolve = 'admin' (DELETE default) + an echo-name confirm.
  {
    name: "form_swarm",
    description: "Form a Docker Swarm from a cluster's members: the chosen manager inits the swarm, every other online member joins as a worker. Idempotent (safe to re-run to reconcile a DEGRADED cluster).",
    scope: "deploy",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, managerServerId: { type: "string" }, advertiseAddr: { type: "string" } }, required: ["clusterId", "managerServerId"] },
    execute: async (d, userId, a) => ({ ok: true, action: "form_swarm", swarm: await d.swarm.form(userId, reqStr(a, "clusterId"), { managerServerId: reqStr(a, "managerServerId"), advertiseAddr: optStr(a, "advertiseAddr") }) }),
  },
  {
    name: "join_swarm_node",
    description: "Add one more online cluster member into an already-ACTIVE swarm as a worker, without dissolving the rest. Idempotent (an already-joined server is a no-op).",
    scope: "deploy",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, serverId: { type: "string" }, advertiseAddr: { type: "string" } }, required: ["clusterId", "serverId"] },
    execute: async (d, userId, a) => ({ ok: true, action: "join_swarm_node", swarm: await d.swarm.joinNode(userId, reqStr(a, "clusterId"), { serverId: reqStr(a, "serverId"), advertiseAddr: optStr(a, "advertiseAddr") }) }),
  },
  {
    name: "add_swarm_manager",
    description: "Promote an existing worker (or join a fresh member) as an additional swarm MANAGER for Raft HA. Idempotent. Refuses an even resulting manager count unless acknowledgeEvenQuorum=true (even counts add no extra fault tolerance).",
    scope: "deploy",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, serverId: { type: "string" }, acknowledgeEvenQuorum: { type: "boolean" } }, required: ["clusterId", "serverId"] },
    execute: async (d, userId, a) => ({ ok: true, action: "add_swarm_manager", swarm: await d.swarm.addManager(userId, reqStr(a, "clusterId"), { serverId: reqStr(a, "serverId"), acknowledgeEvenQuorum: optBool(a, "acknowledgeEvenQuorum") }) }),
  },
  {
    name: "set_ingress_replicas",
    description: "Set the swarm-ingress (Traefik) replica count for HA (1-3; 2+ requires DNS-01 / le-dns on the manager). Returns the resolved ingress pool (node names + IPs to point DNS at).",
    scope: "deploy",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, replicas: { type: "integer", minimum: 1, maximum: 3 } }, required: ["clusterId", "replicas"] },
    execute: async (d, userId, a) => ({ ok: true, action: "set_ingress_replicas", ingress: await d.swarm.setIngressReplicas(userId, reqStr(a, "clusterId"), reqInt(a, "replicas", 1, 3)) }),
  },
  {
    name: "dissolve_swarm",
    description: "DESTRUCTIVE + IRREVERSIBLE: tear down a cluster's entire Docker Swarm (every node leaves; the swarm-ingress is removed). Refuses unless every app has been moved off the cluster first. Requires confirmName to equal the cluster's exact name.",
    scope: "admin",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, confirmName: { type: "string" } }, required: ["clusterId", "confirmName"] },
    execute: async (d, userId, a) => {
      const clusterId = reqStr(a, "clusterId");
      const cluster = (await d.clusters.get(userId, clusterId)) as { name: string }; // read-gated; yields the name to confirm
      requireConfirmName(a, cluster.name, "cluster");
      return { ok: true, action: "dissolve_swarm", swarm: await d.swarm.dissolve(userId, clusterId) };
    },
  },

  // ── mutate: application removal (Phase2b, destructive) ────────────────────────────────────────────
  {
    name: "remove_application",
    description: "DESTRUCTIVE + IRREVERSIBLE: delete an application (tears down its containers/service and volumes, removes its monitor). Requires confirmName to equal the application's exact name.",
    scope: "admin",
    inputSchema: { type: "object", properties: { id: { type: "string" }, confirmName: { type: "string" } }, required: ["id", "confirmName"] },
    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      const app = (await d.apps.get(userId, id)) as { name: string }; // read-gated; yields the name to confirm
      requireConfirmName(a, app.name, "application");
      await d.apps.remove(userId, id);
      return { ok: true, action: "remove_application", id };
    },
  },
];
