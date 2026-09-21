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
function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

const idSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as const;
const noArgs = { type: "object", properties: {} } as const;

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
];
