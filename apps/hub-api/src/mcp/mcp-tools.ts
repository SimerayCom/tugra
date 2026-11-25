import { createHash } from "node:crypto";
import type { z } from "zod";
import { normalizeTags } from "../common/tags";
import { ENV_KEY_RE, ENV_KEY_DENY } from "../common/env-key";
import type { Scope } from "../api-tokens/scopes";
import type { ApplicationsService } from "../applications/applications.service";
import type { AppDatabaseLinksService } from "../applications/app-database-links.service";
import type { ServersService } from "../servers/servers.service";
import type { ClustersService } from "../clusters/clusters.service";
import type { SwarmService } from "../clusters/swarm.service";
import type { DatabasesService } from "../databases/databases.service";
import type { BackupsService } from "../backups/backups.service";
import type { MonitorsService } from "../monitors/monitors.service";
import type { ImporterService } from "../importer/importer.service";
import type { ImportExecutorService } from "../importer/import-executor.service";
import { REMOTE_SOURCE_KINDS, ServiceChoicesSchema, ImportAckSchema, ImportDbDataModesSchema, isRemoteSourceKind, ImportMappingResolveSchema, ImportMappingPutSchema } from "../importer/dto";
import { ImportMappingDocSchema } from "../importer/import-mapping";
import type { RebootService } from "../server-ops/reboot.service";
import { RebootRequestSchema } from "../server-ops/dto";
import type { OobService } from "../cloud/oob.service";
import { OobPowerSchema, OOB_DESTRUCTIVE_POWER_ACTIONS } from "../cloud/oob.dto";
import type { LicenseService } from "../license/license.service";
import type { MetricsService } from "../metrics/metrics.service";
import { rangeToMs, type AppContainerMetrics } from "../metrics/container-metrics.service";
import { summarizeContainer, summarizeHost } from "../metrics/metrics-summary";
import type { SecretProvidersService } from "../secret-providers/secret-providers.service";
import type { DnsCredentialsService } from "../dns/dns-credentials.service";
import type { TunnelService } from "../tunnel/tunnel.service";
import type { CoolifyMoveService } from "../coolify-move/coolify-move.service";
import type { MigrationRunsFacade, RunActor } from "../migration-runs/core/run-contract";
import {
  AbortRunSchema,
  CleanupRunSchema,
  CreateMigrationRunSchema,
  ListMigrationRunsQuerySchema,
  ReverseRunSchema,
  RunEventsQuerySchema,
  SetRunInputsSchema,
  StartRunSchema,
  StepApproveSchema,
  StepKeySchema,
  StepRetrySchema,
} from "../migration-runs/core/dto";

/** The domain services an MCP tool may call. Every read tool passes the caller's `userId` straight
 *  through — team scoping is resolved DB-side inside each service (never trusted from the client). */
export interface McpDeps {
  apps: ApplicationsService;
  dbLinks: AppDatabaseLinksService;
  servers: ServersService;
  serverReboot: RebootService;
  oob: OobService;
  clusters: ClustersService;
  swarm: SwarmService;
  databases: DatabasesService;
  backups: BackupsService;
  monitors: MonitorsService;
  importer: ImporterService;
  executor: ImportExecutorService;
  license: LicenseService;
  metrics: MetricsService;
  secretProviders: SecretProvidersService;
  dnsCredentials: DnsCredentialsService;
  tunnel: TunnelService;
  migrationRuns: MigrationRunsFacade;
  coolifyMove: CoolifyMoveService;
}

/** What the MCP server knows about the call beyond the user id: the token's granted scopes. The migration-run
 *  facade re-checks its own per-route scopes (`deploy` + `read:secrets`, `admin`) against them, so a tool whose
 *  single advertised `scope` is weaker than a route's needs still fails closed. */
export interface McpCallCtx {
  scopes: readonly string[];
}

export interface McpTool {
  name: string;
  description: string;
  /** The API-token scope required to see + call this tool (all "read" at present). */
  scope: Scope;
  /** JSON schema advertised to the client. NOTE: only a hint — a client can call `tools/call` with
   *  arbitrary arguments, so every execute() re-validates/clamps its inputs. */
  inputSchema: Record<string, unknown>;
  /** Argument names whose VALUES are secret and must be redacted from the audit-log `meta.args` (e.g. an env
   *  var value the caller is setting). The MCP server nulls these before persisting the audit entry. */
  sensitiveArgs?: string[];
  execute: (deps: McpDeps, userId: string, args: Record<string, unknown>, ctx?: McpCallCtx) => Promise<unknown>;
}

// ── input helpers (never trust the advertised schema) ────────────────────────────────────────────
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required argument: ${key}`);
  return v;
}
/** An id argument: a non-empty string of at most 64 characters (the ids of this hub are cuids). */
function reqId(args: Record<string, unknown>, key: string): string {
  const v = reqStr(args, key);
  if (v.length > 64) throw new Error(`invalid argument: ${key}`);
  return v;
}
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
/** Shared description of the `dbDataModes` input (import_plan / import_apply / import_mapping_resolve). */
const DB_DATA_MODES_DESC =
  'Coolify/Dokploy only: per-database data mode, keyed by the database plan itemRef ("database:<serverRef>:<sourceRef>") with the only value "volume" (a physical copy of a PostgreSQL data directory; any other engine is a plan blocker). Absent = the default logical dump. It is part of the planHash, so import_apply (and import_mapping_resolve) must send EXACTLY the dbDataModes the plan was made with, or the apply is refused with 409. Not accepted for local-docker.';
/** local-docker adopts in place (no data copy), so a data mode has nothing to act on: refuse it loudly rather than
 *  silently dropping a choice the caller believes is in effect. */
function rejectLocalDockerDbDataModes(args: Record<string, unknown>): void {
  if (args.dbDataModes !== undefined) throw new Error("dbDataModes is only for a Coolify/Dokploy source; local-docker adopts containers in place and copies no data");
}
/** Parse tool input with a zod schema and surface the issues as a readable message (never a JSON dump). */
function parseWith<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new Error(`invalid arguments: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
}
function optBool(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}
/** A required string that MAY be empty (unlike reqStr) — for an env-var VALUE, where "" is legitimate. */
function reqStrAllowEmpty(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing required argument: ${key} (expected a string)`);
  return v;
}
/** Standard POSIX-ish env var name — validated because the agent supplies the key (an "A=B"-shaped key would
 *  corrupt the env map). */
// ENV_KEY_RE + ENV_KEY_DENY live in common/env-key (single source, shared with database links).
function reqEnvKey(args: Record<string, unknown>): string {
  const k = reqStr(args, "key");
  if (!ENV_KEY_RE.test(k) || ENV_KEY_DENY.has(k)) throw new Error(`invalid env var name: ${JSON.stringify(k)} (must match ${ENV_KEY_RE} and not be a reserved name)`);
  return k;
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


/** The facade actor of an MCP call. Channel `mcp` is what makes the facade refuse the point-of-no-return approval
 *  (403 `human-confirmation-required`); a call without a ctx carries no scopes, so the facade refuses it too. */
function mcpActor(userId: string, ctx: McpCallCtx | undefined): RunActor {
  return { userId, scopes: ctx?.scopes ?? [], channel: "mcp" };
}
/** The run id every `migration_run_*` tool takes. */
const runIdSchema = { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } as const;
function reqRunId(args: Record<string, unknown>): string {
  return reqStr(args, "runId");
}

const idSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as const;
const noArgs = { type: "object", properties: {} } as const;

/** The allowlist of REVERSIBLE lifecycle actions the fleet tool may fan across a cluster's apps — never an
 *  arbitrary/destructive verb. Each maps 1:1 to an ApplicationsService method taking (userId, id). */
const FLEET_ACTIONS = new Set(["restart", "stop", "start"]);
/** Hard ceiling on how many apps one fleet call may touch — bounds blast radius + worst-case latency; above it
 *  the operator must narrow scope. And the per-wave concurrency (don't hammer a swarm manager, but don't run
 *  strictly serial either — cuts wall-time for a many-app cluster). */
const MAX_FLEET_TARGETS = 25;
const FLEET_CONCURRENCY = 5;
/** A confirmation token that binds the exact ACTION + cluster + target-id SET (not just the count): if the
 *  agent previews `restart` and then tries to confirm `stop`, or the cluster's app set changed since the
 *  preview, the recomputed token won't match the echoed one and the execute is refused. */
function fleetToken(action: string, clusterId: string, ids: string[]): string {
  return createHash("sha256").update(`${action}|${clusterId}|${[...ids].sort().join(",")}`).digest("hex").slice(0, 16);
}

/** Cap on the apps returned by the fleet_list_apps overview — bounds the payload; `truncated` flags above it. */
const MAX_FLEET_LIST = 200;
/** Valid Application statuses (mirrors the Prisma AppStatus enum) — fleet_list_apps validates its status filter. */
const APP_STATUSES = new Set(["NEW", "RUNNING", "STOPPED", "FAILED"]);

/** Reduce a Deployment row to LLM-safe metadata: drop the raw build `logs` blob AND the `configSnapshot`
 *  (whose `composeFile` stores user compose YAML verbatim — commonly with hard-coded secrets, and gated behind
 *  apps:config everywhere else). Mirrors what `apps.deployments()` / `get_application`'s view already strip, so
 *  a deploy-only caller can't exfiltrate config a read of the app would deny them. Undefined for a null row. */
function stripDeployment(dep: unknown): Record<string, unknown> | undefined {
  if (!dep || typeof dep !== "object") return undefined;
  // Also drop commitMessage: it is the deployed repo's commit subject — third-party-controlled free text,
  // so keep it out of LLM context (prompt-injection surface). commitSha stays (hex provenance).
  const { logs: _logs, configSnapshot: _cs, commitMessage: _cm, ...rest } = dep as Record<string, unknown>;
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
 * MCP tool catalog. The read tools (below) return metadata only — no decrypted secret VALUES ever (env is
 * key-names only, no credential-bearing URLs). The mutate tools (further down) each carry the
 * scope of the REST route they mirror (`deploy` for lifecycle/swarm ops, `write` for env config, `admin` for
 * irreversible ops) and are thin wrappers over the same team-permission-checked, audited service methods —
 * McpService filters/enforces `scope` on tools/list + tools/call, so a read-only token sees none of them.
 * Still planned: OAuth for third-party clients.
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
      // Drop the raw `logs` blob (may hold secrets) and commitMessage (third-party commit subject → prompt
      // injection); commitSha/trigger/durationMs are safe metadata.
      return rows.map(({ logs: _logs, commitMessage: _cm, ...rest }) => rest);
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
  {
    name: "get_server_reboot_status",
    description: "A server's reboot state: the live reboot (scheduled, rebooting, waiting for the agent or verifying) and the last finished one with its per-container / per-domain verification report. Read-only.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.serverReboot.status(userId, reqStr(a, "id")),
  },
  {
    name: "get_server_metrics",
    description:
      "Compact resource summary for one server over a range (1h|6h|24h|7d|30d, default 1h): current, average and peak CPU %, memory % and disk % plus the sample window. Read-only; any team member may read it. Args: id (server), range (optional).",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d"] } },
      required: ["id"],
    },
    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      await d.servers.getForUser(userId, id); // authz: membership check (history() performs none)
      const { range } = rangeToMs(optStr(a, "range")); // unknown token -> 1h, never an arbitrary window
      return { serverId: id, ...summarizeHost(range, await d.metrics.history(id, range)) };
    },
  },
  {
    name: "get_container_metrics",
    description:
      "Compact per-container resource summary for an application (or a managed database with kind=database) over a range (1h|6h|24h|7d|30d, default 1h): current, average and peak CPU %, memory % and average network rates for each of its containers. Read-only; any team member may read it. Args: id, kind (app|database, default app), range (optional).",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["app", "database"] },
        range: { type: "string", enum: ["1h", "6h", "24h", "7d", "30d"] },
      },
      required: ["id"],
    },
    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      const { range } = rangeToMs(optStr(a, "range"));
      const kind = optStr(a, "kind") === "database" ? "database" : "app";
      const data: AppContainerMetrics = kind === "database" ? await d.databases.containerMetrics(userId, id, range) : await d.apps.containerMetrics(userId, id, range);
      return { id, kind, range, containers: data.containers.map((c) => summarizeContainer(c.name, c.samples)) };
    },
  },
  // ── integrations (DNS / secret managers / tunnels) — read-only, metadata only (never a token) ──
  {
    name: "list_dns_credentials",
    description: "List the team's connected DNS-provider credentials (id, name, provider). Metadata only — the API token is never returned. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    execute: async (d, userId) => ({ dnsCredentials: await d.dnsCredentials.list(userId) }),
  },
  {
    name: "list_secret_providers",
    description: "List the team's connected external secret managers (id, name, kind, address). Metadata only — no secret values. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    execute: async (d, userId) => ({ secretProviders: await d.secretProviders.list(userId) }),
  },
  {
    name: "get_tunnel_status",
    description: "Cloudflare Tunnel status for one server (connected state + wildcard domain). Metadata only — no tunnel secret. Read-only. Args: id (server).",
    scope: "read",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: async (d, userId, a) => d.tunnel.status(userId, reqStr(a, "id")),
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

  // ── mutate: application lifecycle ──────────────────────────────────────────────────────
  // Each is a thin pass-through to the SAME ApplicationsService method the REST route calls — which itself
  // enforces the caller's 'apps:deploy' team permission (requireWrite) and audits 'app.<verb>'. The 'deploy'
  // PAT scope (mirroring the routes' @RequireScopes("deploy")) is filtered + enforced by McpService, so a
  // read-only token can neither see nor call these. All five are reversible / idempotent (single-resource).
  {
    name: "deploy_application",
    description: "Redeploy an application using its currently-stored config (image/git ref). If the app is idle this blocks until the deploy finishes; if a deploy is already running the new one is QUEUED and this returns immediately with status 'QUEUED'. Returns the deployment metadata (build logs + config snapshot are stripped). Does not take a new image/version.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: async (d, userId, a) => ({ ok: true, action: "deploy", deployment: stripDeployment(await d.apps.deploy(userId, reqStr(a, "id"))) }),
  },
  {
    name: "cancel_deployment",
    description: "Cancel a QUEUED deployment of an application (one that has not started yet). A deployment that is already RUNNING cannot be cancelled. Returns the cancelled deployment metadata.",
    scope: "deploy",
    inputSchema: { type: "object", properties: { id: { type: "string" }, deploymentId: { type: "string" } }, required: ["id", "deploymentId"] },
    execute: async (d, userId, a) => ({ ok: true, action: "cancel_deployment", deployment: stripDeployment(await d.apps.cancelDeployment(userId, reqStr(a, "id"), reqStr(a, "deploymentId"))) }),
  },
  {
    name: "restart_application",
    description: "Restart an application (rolling recreate on swarm, restart on a single server). Errors if the server's agent is offline or the restart command fails, so a success response means the transition was confirmed; returns the app's new recorded status.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: (d, userId, a) => lifecycle(d, userId, reqStr(a, "id"), "restart"),
  },
  {
    name: "stop_application",
    description: "Stop an application (scale to 0 on swarm, stop on a single server). Errors if the server's agent is offline or the stop command fails, so a success response means the transition was confirmed; returns the app's new recorded status.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: (d, userId, a) => lifecycle(d, userId, reqStr(a, "id"), "stop"),
  },
  {
    name: "start_application",
    description: "Start a stopped application (scale back to its replica count on swarm, start on a single server). Errors if the server's agent is offline or the start command fails, so a success response means the transition was confirmed; returns the app's new recorded status.",
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
  {
    name: "reboot_server",
    description:
      "REBOOT a server (every container and routed domain on it is down for a minute or more; if it hosts the Tugra hub, the panel goes away too). Refused unless `confirmName` equals the server's EXACT name (read it with get_server first; never guess it) and refused (409) while an OS update or a deploy runs on the server. mode \"now\" (the host reboots about 15 seconds later) or \"scheduled\" with `at`, an ISO date-time between 1 minute and 7 days ahead. After the server is back the hub verifies, within 10 minutes, that every container with a restart policy runs again (healthy where it has a healthcheck), every routed domain answers through the local proxy and the reboot-required flag cleared; read the outcome with get_server_reboot_status. Needs the deploy scope.",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        confirmName: { type: "string", description: "the server's exact name (typed confirmation)" },
        mode: { type: "string", enum: ["now", "scheduled"] },
        at: { type: "string", description: "ISO date-time, required for mode=scheduled" },
      },
      required: ["id", "confirmName", "mode"],
    },
    execute: async (d, userId, a) => {
      const body = parseWith(RebootRequestSchema, { mode: a.mode, at: a.at, confirmName: a.confirmName });
      return { ok: true, action: "reboot_server", reboot: await d.serverReboot.request(userId, reqStr(a, "id"), body) };
    },
  },
  {
    name: "cancel_server_reboot",
    description: "Cancel a SCHEDULED reboot that has not started yet. A reboot that already started cannot be cancelled.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: async (d, userId, a) => ({ ok: true, action: "cancel_server_reboot", reboot: await d.serverReboot.cancel(userId, reqStr(a, "id")) }),
  },
  {
    name: "get_server_oob",
    description:
      "A server's out-of-band (cloud provider) link and live provider state: whether it is linked to a cloud server (Hetzner), its power status (running, off, ...), whether rescue mode is armed and whether the provider has it locked. Works while the server's agent is offline. Read-only. The rescue root password and the provider console are NOT available through MCP (their one-time secrets must not enter a model's context): use the panel or `tugra servers oob-rescue` / `oob-console`.",
    scope: "read",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.oob.status(userId, reqStr(a, "id")),
  },
  {
    name: "server_power",
    description:
      "Power a cloud-linked server at the PROVIDER, even when its agent is offline: power_on; power_off (cuts power, like pulling the cord: data loss possible); reboot (HARD reset: power cut and started again); shutdown (graceful ACPI stop). Everything on the server goes down for power_off, reboot and shutdown, so those three are refused unless `confirmName` equals the server's EXACT name (read it with get_server first; never guess it). Needs the deploy scope and the servers:ops permission. Check the result with get_server_oob.",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        action: { type: "string", enum: ["power_on", "power_off", "reboot", "shutdown"] },
        confirmName: { type: "string", description: "the server's exact name; required for power_off, reboot and shutdown" },
      },
      required: ["id", "action"],
    },
    execute: async (d, userId, a) => {
      const body = parseWith(OobPowerSchema, { action: a.action, confirmName: optStr(a, "confirmName") });
      if ((OOB_DESTRUCTIVE_POWER_ACTIONS as readonly string[]).includes(body.action) && !body.confirmName) {
        throw new Error(`${body.action} refused — pass "confirmName" exactly equal to the server's name to confirm; this takes everything on the server down`);
      }
      return d.oob.power(userId, reqStr(a, "id"), body);
    },
  },
  {
    name: "disable_server_rescue",
    description: "Disable the provider's rescue mode on a cloud-linked server (it then boots from its own disk on the next boot). Does not reboot it. Needs the deploy scope and the servers:ops permission.",
    scope: "deploy",
    inputSchema: idSchema,
    execute: (d, userId, a) => d.oob.disableRescue(userId, reqStr(a, "id")),
  },
  {
    name: "scale_application",
    description: "Live-scale a cluster-deployed application to N replicas NOW — persists the count AND applies it to the running swarm service (polls to convergence). Swarm apps only; a stateful (named-volume) app is capped at 1 replica. Returns the app's fresh status.",
    scope: "deploy",
    inputSchema: { type: "object", properties: { id: { type: "string" }, replicas: { type: "integer", minimum: 1, maximum: 20 } }, required: ["id", "replicas"] },
    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      const replicas = reqInt(a, "replicas", 1, 20);
      await d.apps.scaleNow(userId, id, replicas);
      let application: unknown = null;
      try {
        application = await d.apps.get(userId, id);
      } catch {
        application = null;
      }
      return { ok: true, action: "scale", replicas, application };
    },
  },

  // ── mutate + diagnostic: custom-domain DNS auto-setup (Cloudflare) ────────────────────────────────
  // setup_app_domain fans the one-click flow (DNS records + app-domain wiring) out to agents; verify_app_domain
  // is a read-only propagation check. Both pass through ApplicationsService, which enforces the team permission.
  {
    name: "setup_app_domain",
    description:
      "One-click custom-domain DNS setup for an application via Cloudflare: create the apex A (+AAAA) and optional www CNAME records (DNS-only) and wire the app's domain over HTTPS. Set dryRun:true to PREVIEW the plan without writing. A record that already points elsewhere is a conflict only replaced when overwrite:true. Needs a team Cloudflare DNS credential (credentialId optional when the team has exactly one).",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        domain: { type: "string" },
        credentialId: { type: "string" },
        includeWww: { type: "boolean" },
        overwrite: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      required: ["id", "domain"],
    },
    execute: async (d, userId, a) =>
      d.apps.autoSetupDomain(userId, reqStr(a, "id"), {
        domain: reqStr(a, "domain"),
        credentialId: optStr(a, "credentialId"),
        // tri-state: omitted/non-boolean → undefined (backend default true); only an explicit boolean overrides.
        includeWww: typeof a.includeWww === "boolean" ? a.includeWww : undefined,
        overwrite: optBool(a, "overwrite"),
        dryRun: optBool(a, "dryRun"),
      }),
  },
  {
    name: "verify_app_domain",
    description:
      "Check an application's auto-setup custom domain actually resolves to the app (real public-DNS lookup) and refresh its status (active | pending | error). Optionally pass a specific hostname.",
    scope: "read",
    inputSchema: { type: "object", properties: { id: { type: "string" }, hostname: { type: "string" } }, required: ["id"] },
    execute: async (d, userId, a) => d.apps.verifyDomain(userId, reqStr(a, "id"), optStr(a, "hostname")),
  },

  // ── mutate: cluster / swarm operation ──────────────────────────────────────────────────
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

  // ── mutate: application env config ─────────────────────────────────────────────────────
  // Safe single-key MERGE: read the current env (apps.getEnv, apps:config-gated), change ONE key, write back
  // via apps.setEnv — so the agent can't blow away the whole env map the way a raw full-replace would, and the
  // decrypted values it reads to merge are NEVER returned (only the key name is echoed back). Scope "write"
  // mirrors the REST PUT :id/env default. Note: read-modify-write is not atomic across concurrent calls.
  {
    name: "set_env_var",
    description: "Set (create or update) a SINGLE environment variable on an application, merging it into the existing env (other vars are preserved). Values are write-only here — never returned. Takes effect on the next deploy/restart.",
    scope: "write",
    inputSchema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["id", "key", "value"] },
    sensitiveArgs: ["value"], // the value is a secret the caller supplies — never persist it to the audit log

    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      const key = reqEnvKey(a);
      const value = reqStrAllowEmpty(a, "value");
      const env = await d.apps.getEnv(userId, id);
      await d.apps.setEnv(userId, id, { ...env, [key]: value });
      return { ok: true, action: "set_env_var", key }; // never echo the value
    },
  },
  {
    name: "delete_env_var",
    description: "Remove a SINGLE environment variable from an application (other vars are preserved). Takes effect on the next deploy/restart.",
    scope: "write",
    inputSchema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" } }, required: ["id", "key"] },
    execute: async (d, userId, a) => {
      const id = reqStr(a, "id");
      const key = reqEnvKey(a);
      const env = await d.apps.getEnv(userId, id);
      // OWN-property check (not `in`, which walks the prototype chain — a key like "toString"/"__proto__" would
      // otherwise falsely report removed:true and trigger a spurious re-encrypt+write of an unchanged env).
      if (!Object.prototype.hasOwnProperty.call(env, key)) return { ok: true, action: "delete_env_var", key, removed: false };
      const { [key]: _drop, ...rest } = env;
      await d.apps.setEnv(userId, id, rest);
      return { ok: true, action: "delete_env_var", key, removed: true };
    },
  },

  // ── mutate: swarm node removal ─────────────────────────────────────────────────────────
  // Reversible (a demoted manager / removed worker can be re-added), so admin scope (DELETE default) is the
  // gate — no echo-name confirm (that tier is reserved for irreversible dissolve/remove). Pure pass-throughs.
  {
    name: "remove_swarm_manager",
    description: "Demote a swarm MANAGER back to a worker (shrinks the Raft quorum). Refuses to demote the primary/ingress manager or the last manager. Idempotent. Refuses an even resulting count unless acknowledgeEvenQuorum=true.",
    scope: "admin",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, serverId: { type: "string" }, acknowledgeEvenQuorum: { type: "boolean" } }, required: ["clusterId", "serverId"] },
    execute: async (d, userId, a) => ({ ok: true, action: "remove_swarm_manager", swarm: await d.swarm.removeManager(userId, reqStr(a, "clusterId"), { serverId: reqStr(a, "serverId"), acknowledgeEvenQuorum: optBool(a, "acknowledgeEvenQuorum") }) }),
  },
  {
    name: "leave_swarm_node",
    description: "Remove a WORKER node from a cluster's swarm (drains its tasks, then it leaves the swarm and the cluster). A MANAGER must be demoted first. Reversible by re-joining.",
    scope: "admin",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, serverId: { type: "string" } }, required: ["clusterId", "serverId"] },
    execute: async (d, userId, a) => ({ ok: true, action: "leave_swarm_node", swarm: await d.swarm.leaveNode(userId, reqStr(a, "clusterId"), reqStr(a, "serverId")) }),
  },

  // ── mutate: fleet ──────────────────────────────────────────────────────────────────────
  // The agent-native FLEET wedge: fan ONE allowlisted, reversible lifecycle action across every app deployed
  // to a cluster — reusing the per-app ApplicationsService methods (each self-enforces apps:deploy + audits),
  // never the raw /bulk shell-RCE path. Preview-then-confirm: called WITHOUT confirmCount it only PREVIEWS the
  // targets (no action); to execute, the caller must pass confirmCount equal to the live target count — which
  // forces it to have seen the preview AND guards against the fleet changing between preview and execute (TOCTOU).
  {
    name: "fleet_app_action",
    description: "Fleet op: apply one lifecycle action (restart | stop | start) to EVERY application deployed to a cluster. Call without confirmToken to PREVIEW the affected apps (no change) — the preview returns a confirmToken; re-call with that exact confirmToken to execute. The token binds the action AND the target set, so a changed action/fleet forces a fresh preview. Reversible per app; per-app failures are reported, not fatal. Capped at " + String(MAX_FLEET_TARGETS) + " apps per call.",
    scope: "deploy",
    inputSchema: { type: "object", properties: { clusterId: { type: "string" }, action: { type: "string", enum: ["restart", "stop", "start"] }, confirmToken: { type: "string" } }, required: ["clusterId", "action"] },
    execute: async (d, userId, a) => {
      const clusterId = reqStr(a, "clusterId");
      const action = reqStr(a, "action");
      if (!FLEET_ACTIONS.has(action)) throw new Error(`action must be one of: ${[...FLEET_ACTIONS].join(", ")}`);
      const act = action as "restart" | "stop" | "start";
      const targets = (await d.apps.list(userId))
        .filter((app) => (app as { clusterId: string | null }).clusterId === clusterId)
        .map((app) => ({ id: (app as { id: string }).id, name: (app as { name: string }).name, status: (app as { status: string }).status }));
      // Token binds action + cluster + the exact (sorted) target-id set — recomputed fresh here so a stale
      // preview (different action or a membership change since) can never be confirmed.
      const token = fleetToken(act, clusterId, targets.map((t) => t.id));
      const provided = optStr(a, "confirmToken");

      if (!provided) {
        // PREVIEW: no change. Hand back the token the caller must echo to execute.
        return {
          ok: true, preview: true, action: act, clusterId, count: targets.length, targets,
          tooMany: targets.length > MAX_FLEET_TARGETS,
          confirmToken: token,
          confirmHint: targets.length > MAX_FLEET_TARGETS
            ? `too many apps (${targets.length} > ${MAX_FLEET_TARGETS}) to act on in one call — narrow the scope`
            : `re-call with confirmToken="${token}" to apply "${act}" to these ${targets.length} app(s)`,
        };
      }
      if (provided !== token) {
        throw new Error(`stale or mismatched confirmation — the action or the cluster's app set changed since the preview; re-run without confirmToken to preview the current set, then confirm`);
      }
      if (targets.length > MAX_FLEET_TARGETS) {
        throw new Error(`too many target apps (${targets.length} > ${MAX_FLEET_TARGETS}) for a single fleet action — narrow the scope`);
      }
      // Bounded-concurrency waves: cut wall-time vs strictly serial, without hammering the swarm manager. A
      // per-app failure is captured, never aborts the rest.
      const results: Array<{ id: string; name: string; ok: boolean; error?: string }> = [];
      for (let i = 0; i < targets.length; i += FLEET_CONCURRENCY) {
        const wave = await Promise.all(
          targets.slice(i, i + FLEET_CONCURRENCY).map(async (t) => {
            try {
              await d.apps[act](userId, t.id);
              return { id: t.id, name: t.name, ok: true };
            } catch (e) {
              return { id: t.id, name: t.name, ok: false, error: e instanceof Error ? e.message : "action failed" };
            }
          }),
        );
        results.push(...wave);
      }
      return { ok: true, preview: false, action: act, clusterId, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    },
  },

  // ── mutate: application removal (destructive) ────────────────────────────────────────────
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

  // ── mutate: fleet import (Coolify / Dokploy + local-docker) ──────────────────────────────────
  {
    name: "import_connect",
    description:
      "Connect an external source PaaS (Coolify or Dokploy) to import from: verifies the instance is reachable with the given API token/key and stores a short-lived ENCRYPTED session. Returns a sessionId for import_plan/import_apply. The token is never returned or logged.",
    scope: "write",
    inputSchema: {
      type: "object",
      properties: { sourceKind: { type: "string", enum: [...REMOTE_SOURCE_KINDS] }, teamId: { type: "string" }, baseUrl: { type: "string" }, token: { type: "string" }, scopeLabel: { type: "string", description: "optional label for the source team/token; keys the saved import mapping" } },
      required: ["sourceKind", "teamId", "baseUrl", "token"],
    },
    sensitiveArgs: ["token"], // redacted from the audit log's meta.args
    execute: async (d, userId, a) => {
      const k = optStr(a, "sourceKind");
      if (!isRemoteSourceKind(k)) throw new Error(`sourceKind must be one of: ${REMOTE_SOURCE_KINDS.join(", ")}`);
      const scopeLabel = optStr(a, "scopeLabel");
      return d.importer.connect(userId, { sourceKind: k, teamId: reqStr(a, "teamId"), baseUrl: reqStr(a, "baseUrl"), token: reqStr(a, "token"), ...(scopeLabel ? { scopeLabel } : {}) });
    },
  },
  {
    name: "import_plan",
    description:
      "Dry-run preview of what an import would create in Tugra, with per-item risks. Pass a local-docker serverId (adopt the host's standalone containers) or a Coolify/Dokploy sessionId. Returns a secret-free plan incl. a planHash to pass to import_apply. Optional dbDataModes (Coolify/Dokploy) opts a PostgreSQL database into a physical volume copy; send the same dbDataModes to import_apply. Reveals env KEYS → read:secrets.",
    scope: "read:secrets",
    inputSchema: {
      type: "object",
      properties: {
        sourceKind: { type: "string", enum: ["local-docker", ...REMOTE_SOURCE_KINDS] },
        serverId: { type: "string" },
        sessionId: { type: "string" },
        dbDataModes: { type: "object", description: DB_DATA_MODES_DESC, additionalProperties: { type: "string", enum: ["volume"] } },
      },
      required: ["sourceKind"],
    },
    execute: async (d, userId, a) => {
      const k = optStr(a, "sourceKind");
      if (k === "local-docker") {
        rejectLocalDockerDbDataModes(a);
        return d.importer.plan(userId, { sourceKind: "local-docker", serverId: reqStr(a, "serverId") });
      }
      if (isRemoteSourceKind(k)) {
        return d.importer.plan(userId, { sourceKind: k, sessionId: reqStr(a, "sessionId"), ...(a.dbDataModes !== undefined ? { dbDataModes: ImportDbDataModesSchema.parse(a.dbDataModes) } : {}) });
      }
      throw new Error(`sourceKind must be "local-docker" or one of: ${REMOTE_SOURCE_KINDS.join(", ")}`);
    },
  },
  {
    name: "import_apply",
    description:
      "Apply a reviewed import plan. Pass the planHash from import_plan (the apply is refused if the source changed since). local-docker adopts the host's containers in place; a remote source (Coolify/Dokploy) COPIES each app onto targetServerId. Optional mapping (+ the mappingHash from import_mapping_resolve) renames and re-places items; if a saved mapping exists for the source the apply is refused (409) unless you send the mapping or ignoreStoredMapping. Blocked env rows (app.env.unresolved / app.env.key.invalid) are skipped unless acknowledged via acks. dbDataModes (Coolify/Dokploy) must be EXACTLY what import_plan was called with (it is part of the planHash; a mismatch is a 409). Returns an opId to poll with import_status.",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        sourceKind: { type: "string", enum: ["local-docker", ...REMOTE_SOURCE_KINDS] },
        serverId: { type: "string" },
        sessionId: { type: "string" },
        targetServerId: { type: "string" },
        environmentId: { type: "string" },
        planHash: { type: "string" },
        acks: {
          type: "array",
          description:
            "Coolify only: acknowledge ACKABLE env blockers from import_plan so the app is created WITHOUT those variables. Each item: { code: \"app.env.unresolved\" | \"app.env.key.invalid\", itemRef?: string } - omit itemRef to acknowledge every item carrying that code. app.env.tokenReadOnly and every other blocker cannot be acknowledged.",
          items: { type: "object", properties: { code: { type: "string", enum: ["app.env.unresolved", "app.env.key.invalid"] }, itemRef: { type: "string" } }, required: ["code"] },
        },
        serviceChoices: {
          type: "object",
          description:
            "Coolify services only: per-service choices keyed by the plan item's itemRef (skip, name, environmentId, targetServerId, serviceDomains, hostnameMap, volumes {policy copy|empty|skip}, dropMembers, pinImages, pins, privateNetwork, hold). A choice can only narrow or rename what the importer does.",
        },
        mapping: { type: "object", description: "the mapping document (version 1) — names and placement only" },
        mappingHash: { type: "string", description: "the hash import_mapping_resolve returned for exactly this mapping" },
        reconcile: { type: "boolean" },
        ignoreStoredMapping: { type: "boolean" },
        saveMapping: { type: "boolean" },
        dbDataModes: { type: "object", description: DB_DATA_MODES_DESC, additionalProperties: { type: "string", enum: ["volume"] } },
      },
      required: ["sourceKind", "planHash"],
    },
    execute: async (d, userId, a) => {
      const k = optStr(a, "sourceKind");
      const planHash = reqStr(a, "planHash");
      if (k === "local-docker") {
        rejectLocalDockerDbDataModes(a);
        return d.executor.apply(userId, { sourceKind: "local-docker", serverId: reqStr(a, "serverId"), planHash });
      }
      if (isRemoteSourceKind(k)) {
        const mapping = a.mapping === undefined ? undefined : ImportMappingDocSchema.parse(a.mapping);
        const mappingHash = optStr(a, "mappingHash");
        if ((mapping !== undefined) !== (mappingHash !== undefined)) throw new Error("mapping and mappingHash must be sent together");
        return d.executor.apply(userId, {
          sourceKind: k,
          sessionId: reqStr(a, "sessionId"),
          targetServerId: reqStr(a, "targetServerId"),
          environmentId: optStr(a, "environmentId"),
          planHash,
          ...(a.serviceChoices !== undefined ? { serviceChoices: ServiceChoicesSchema.parse(a.serviceChoices) } : {}),
          ...(a.acks !== undefined ? { acks: ImportAckSchema.array().max(2000).parse(a.acks) } : {}),
          ...(mapping !== undefined ? { mapping, mappingHash } : {}),
          ...(a.reconcile === true ? { reconcile: true } : {}),
          ...(a.ignoreStoredMapping === true ? { ignoreStoredMapping: true } : {}),
          ...(a.saveMapping === false ? { saveMapping: false } : {}),
          ...(a.dbDataModes !== undefined ? { dbDataModes: ImportDbDataModesSchema.parse(a.dbDataModes) } : {}),
        });
      }
      throw new Error(`sourceKind must be "local-docker" or one of: ${REMOTE_SOURCE_KINDS.join(", ")}`);
    },
  },
  {
    name: "import_mapping_resolve",
    description:
      "Preview an import mapping (renames, project/environment placement, container aliases) against a fresh plan and a target server: returns the effective item names/placement, every conflict (errors, needs-acknowledgement, warnings) and the mappingHash to pass to import_apply. Read-only. Names and placement only — never secrets.",
    scope: "read:secrets",
    inputSchema: {
      type: "object",
      properties: {
        sourceKind: { type: "string", enum: [...REMOTE_SOURCE_KINDS] },
        sessionId: { type: "string" },
        planHash: { type: "string" },
        targetServerId: { type: "string" },
        environmentId: { type: "string" },
        reconcile: { type: "boolean" },
        acks: { type: "array", description: "the same acks you will send to import_apply: an acked blocker item previews as runnable and binds into the mappingHash", items: { type: "object" } },
        dbDataModes: { type: "object", description: "the same dbDataModes import_plan was called with (the resolve re-plans with them so the planHash matches; a plan made with modes is refused with 409 without them)", additionalProperties: { type: "string", enum: ["volume"] } },
        mapping: { type: "object" },
      },
      required: ["sourceKind", "sessionId", "planHash", "targetServerId", "mapping"],
    },
    execute: async (d, userId, a) => d.importer.resolveMapping(userId, ImportMappingResolveSchema.parse(a)),
  },
  {
    name: "import_mapping_get",
    description: "Read the saved import mapping profile for a connected source session's scope (doc is null when none is saved). Read-only.",
    scope: "read:secrets",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    execute: async (d, userId, a) => d.importer.getMapping(userId, reqStr(a, "sessionId")),
  },
  {
    name: "import_mapping_put",
    description:
      "Save the import mapping profile for a connected source session's scope (shape-validated only). expectedVersion guards against overwriting a newer save (409 on a stale version). Saving does not apply anything.",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, mapping: { type: "object" }, label: { type: "string" }, expectedVersion: { type: "number" } },
      required: ["sessionId", "mapping"],
    },
    execute: async (d, userId, a) => d.importer.putMapping(userId, reqStr(a, "sessionId"), ImportMappingPutSchema.parse({ mapping: a.mapping, label: a.label, expectedVersion: a.expectedVersion })),
  },
  {
    name: "import_status",
    description: "Poll an import operation by opId: per-item status (done/failed/skipped/rolled-back), created resource ids, and any unresolved-env count. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { opId: { type: "string" } }, required: ["opId"] },
    execute: async (d, userId, a) => d.executor.status(userId, reqStr(a, "opId")),
  },
  {
    name: "import_rollback",
    description:
      "DESTRUCTIVE: undo an import operation's completed work (a remote-source copy removes the created apps; local-docker un-adopts the containers). Skips any app you have (re)deployed since import. Requires confirmName to equal the opId.",
    scope: "admin",
    inputSchema: { type: "object", properties: { opId: { type: "string" }, confirmName: { type: "string" } }, required: ["opId", "confirmName"] },
    execute: async (d, userId, a) => {
      const opId = reqStr(a, "opId");
      requireConfirmName(a, opId, "import operation"); // echo the opId to confirm the irreversible undo
      return d.executor.rollback(userId, opId);
    },
  },

  // ── guided migration runs (P7): one resumable, abortable Coolify/Dokploy -> Tugra run ─────────────────────
  // Every tool delegates to the migration-run facade (the same service the REST routes call), which re-checks
  // creator-only ownership, team permissions and its per-route scopes against the token's scopes. Views and the
  // report are secret-free and carry codes + params only. Deliberately NOT exposed over MCP: the source-host
  // command and the host-loop / inventory scripts (they carry a live migrator token), operator attestations
  // (a human vouches for the source host), the image-digest and job-runner facts (`image-pins`, `worker-marks`:
  // only someone who can see the source host can vouch for them), the source-token re-entry, and DECOMMISSION. The point-of-no-return approval is refused by the facade with 403
  // `human-confirmation-required`: an agent prepares and observes, a human crosses the point of no return.
  {
    name: "migration_run_list",
    description:
      "List your guided migration runs (newest first), optionally filtered by teamId, status, campaign (the exact label a run was created with) or active=true (live runs only). Each row has the status, current step, point-of-no-return time, steps passed/total, how many target servers the run places resources on, the source version, the campaign and what the run is waiting for. Read-only.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        teamId: { type: "string" },
        status: { type: "string" },
        campaign: { type: "string", description: "only the runs of this campaign label (exact match)" },
        active: { type: "boolean", description: "true = only live runs" },
        limit: { type: "number" },
      },
    },
    execute: async (d, userId, a, ctx) => {
      const query = parseWith(ListMigrationRunsQuerySchema, {
        ...(optStr(a, "teamId") ? { teamId: optStr(a, "teamId") } : {}),
        ...(optStr(a, "status") ? { status: optStr(a, "status") } : {}),
        ...(optStr(a, "campaign") ? { campaign: optStr(a, "campaign") } : {}),
        ...(a.active === true ? { active: "true" } : a.active === false ? { active: "false" } : {}),
        ...(a.limit !== undefined ? { limit: clampInt(a.limit, 1, 200, 50) } : {}),
      });
      return { runs: await d.migrationRuns.list(mcpActor(userId, ctx), query) };
    },
  },
  {
    name: "migration_run_create",
    description:
      "Create a guided Coolify/Dokploy -> Tugra migration run bound to a reviewed import plan (import_connect, then import_plan; pass the same sessionId, planHash and mapping/acks/dbDataModes you will apply). DEFAULTS TO dryRun=true: the run only projects what each step would do, writes nothing outside its own run rows and ends DRY_RUN_DONE; call migration_run_start on it to promote it into a real run. Pass dryRun=false only when the human asked for a real run. mode: copy (default) | takeover; topology: two-box (default) | swap-proxy; options and inputs are optional with safe, fail-closed defaults. A project that spans several source servers is ONE run: pass serverMap (source server = the Coolify server uuid in the plan's item refs, to a Tugra server id of the same team; targetServerId stays the default) and list EVERY source server in it, because a source server missing from a non-empty map stops the run instead of landing on the default server. campaign groups the runs of one migration campaign. sourceRunner coolify-host-loop prints one script for the Coolify host (a human runs it) that loops over the source hosts. Needs deploy AND read:secrets scopes. Returns the run view.",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        sourceKind: { type: "string", enum: [...REMOTE_SOURCE_KINDS] },
        targetServerId: { type: "string" },
        environmentId: { type: "string" },
        planHash: { type: "string", description: "the planHash from import_plan (mode/topology are not part of it)" },
        mode: { type: "string", enum: ["copy", "takeover"] },
        topology: { type: "string", enum: ["two-box", "swap-proxy"] },
        dryRun: { type: "boolean", description: "default TRUE for agents" },
        serverMap: { type: "object", description: "multi-host placement: { <source server uuid>: <Tugra server id> }, at most 64 entries, every source server listed; targetServerId is the default for none", additionalProperties: { type: "string" } },
        campaign: { type: "string", description: "a label (1-80 printable characters) that groups the runs of one campaign" },
        scope: {
          type: "object",
          description:
            "move only part of the source: sourceServers (source server uuids from the plan's item refs) and/or projects (source project refs from the plan's preflight.projects) bring their items; include adds item refs on top, exclude leaves item refs out and always wins (item refs are app:/database:/service: refs from the plan). The hub leaves everything else out of the run, so it moves exactly the chosen items; a ref the plan does not have, or a scope that keeps nothing, is refused. Do not combine with mapping. Absent = the whole source.",
          properties: {
            sourceServers: { type: "array", items: { type: "string" } },
            projects: { type: "array", items: { type: "string" } },
            include: { type: "array", items: { type: "string" } },
            exclude: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        options: {
          type: "object",
          description:
            "run options (ttlPolicy, deployWaves single|earlyStateless|earlyBuild, deployConcurrency 1-8 builds per target server, warmDbSeed, stopSource, sourceRunner operator|agent|coolify-host-loop, hostLoop {keyDir, parallel, connectTimeoutSec, retries} (only the key DIRECTORY on the Coolify host, never a key), largeDbMode stream-logical (default, no size limit)|refuse, certs, acceptHttp01Gap, freezeAt, observeMinutes, manualFinalize, batchSize, intervalSec, dnsCredentialId, healthPath, rowCountMode, decommissionMinAgeHours, stuckOperatorMinutes)",
        },
        inputs: {
          type: "object",
          description:
            'owner inputs, each may be "unknown" (the safe default then applies): acmeEmail, allowBind, allowLiveShapeProbe, sourceController (manual|api|agent), minioPolicy (hold|mirror|external: hosts that use the source\'s object storage; default hold), workerPolicy (hold-dark|start-dark|exclude: apps without a domain; default hold-dark), unlistedDbPolicy (block|carry|skip: database containers the source API does not list; default block), orphanVolumePolicy (block|skip; default block)',
        },
        acks: { type: "array", items: { type: "object" } },
        serviceChoices: { type: "object" },
        mapping: { type: "object" },
        mappingHash: { type: "string" },
        reconcile: { type: "boolean" },
        ignoreStoredMapping: { type: "boolean" },
        saveMapping: { type: "boolean" },
        dbDataModes: { type: "object", description: DB_DATA_MODES_DESC, additionalProperties: { type: "string", enum: ["volume"] } },
      },
      required: ["sessionId", "sourceKind", "targetServerId", "planHash"],
    },
    execute: async (d, userId, a, ctx) => {
      // Unknown argument names are refused by the strict schema (a typo never silently drops a safety input).
      const body = parseWith(CreateMigrationRunSchema, { ...a, dryRun: a.dryRun !== false });
      return d.migrationRuns.create(mcpActor(userId, ctx), body);
    },
  },
  {
    name: "migration_run_status",
    description:
      "The full run view: every step with its status, gate checks (with evidence kind: hub-verified, migrator-reported, source-api-reported, host-loop-reported or operator-attested), progress and attempts; the single nextAction naming exactly what the run is waiting for (an operator command, an approval with its hash binding, a timer, a gate, a re-entered source session); the placement (serverMap and targetServers, the default first); the source version with its verdict (supported | newer | too-old | unknown | unchecked), the campaign and when the source health baseline was recorded; the window estimate vs measured downtime; ponrAt; and which actions are allowed now. Secret-free, codes + params only. Read-only.",
    scope: "read",
    inputSchema: runIdSchema,
    execute: async (d, userId, a, ctx) => d.migrationRuns.get(mcpActor(userId, ctx), reqRunId(a)),
  },
  {
    name: "migration_run_events",
    description: "Poll a run's append-only event log. Pass afterSeq = the last seq you saw (0 = from the start); the page carries the next cursor. Codes + params only. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, afterSeq: { type: "number" }, limit: { type: "number" } }, required: ["runId"] },
    execute: async (d, userId, a, ctx) => {
      const query = parseWith(RunEventsQuerySchema, {
        ...(a.afterSeq !== undefined ? { afterSeq: clampInt(a.afterSeq, 0, Number.MAX_SAFE_INTEGER, 0) } : {}),
        ...(a.limit !== undefined ? { limit: clampInt(a.limit, 1, 500, 200) } : {}),
      });
      return d.migrationRuns.events(mcpActor(userId, ctx), reqRunId(a), query);
    },
  },
  {
    name: "migration_run_report",
    description: "The run's secret-free report: what moved, what did not (reason codes), the source version, every target server and the campaign, the evidence kinds the run relied on (hub-verified, migrator-reported, source-api-reported, host-loop-reported, operator-attested), the estimated vs measured downtime window and the manual actions still required. Built on demand for an unfinished run. Read-only.",
    scope: "read",
    inputSchema: runIdSchema,
    execute: async (d, userId, a, ctx) => d.migrationRuns.report(mcpActor(userId, ctx), reqRunId(a)),
  },
  {
    name: "migration_run_start",
    description:
      "Start a QUEUED run, or PROMOTE a DRY_RUN_DONE run: promotion creates a NEW real run (frozen inputs copied, planHash re-validated) and returns THAT run, whose id differs from the one you passed. sessionId is only needed when the dry run's source session expired. Promotion is refused with 409 dry-run-warnings-open (and the list of warning keys) while the dry run still has warnings that a person has neither accepted nor fixed on its result screen: an agent cannot accept them, tell the human. The run then drives itself and stops at every step that needs an operator, an approval or a timer: read migration_run_status.nextAction.",
    scope: "deploy",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, sessionId: { type: "string" } }, required: ["runId"] },
    execute: async (d, userId, a, ctx) => d.migrationRuns.start(mcpActor(userId, ctx), reqRunId(a), parseWith(StartRunSchema, optStr(a, "sessionId") ? { sessionId: optStr(a, "sessionId") } : {})),
  },
  {
    name: "migration_run_set_inputs",
    description:
      'Answer or change owner inputs on a run: acmeEmail (blocks only TLS and CUTOVER while unknown), allowBind (bind-mount apps; default refuse), allowLiveShapeProbe (consent for the read-only live probe; default off), sourceController (manual | api | agent; default manual), and the fleet policies, all fail-closed: minioPolicy (hold | mirror | external; hosts that use the source\'s object storage stay on the source by default), workerPolicy (hold-dark | start-dark | exclude; apps without a domain stay stopped until after the cutover by default), unlistedDbPolicy (block | carry | skip; default block) and orphanVolumePolicy (block | skip; default block). Each value may be "unknown", which keeps the safe default. Unblocks the step that needed it.',
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        acmeEmail: { type: "string" },
        allowBind: { type: "boolean" },
        allowLiveShapeProbe: { type: "boolean" },
        sourceController: { type: "string", enum: ["manual", "api", "agent"] },
        minioPolicy: { type: "string", enum: ["hold", "mirror", "external"] },
        workerPolicy: { type: "string", enum: ["hold-dark", "start-dark", "exclude"] },
        unlistedDbPolicy: { type: "string", enum: ["block", "carry", "skip"] },
        orphanVolumePolicy: { type: "string", enum: ["block", "skip"] },
      },
      required: ["runId"],
    },
    execute: async (d, userId, a, ctx) => {
      const { runId, ...inputs } = a;
      void runId;
      return d.migrationRuns.setInputs(mcpActor(userId, ctx), reqRunId(a), parseWith(SetRunInputsSchema, inputs));
    },
  },
  {
    name: "migration_run_approve",
    description:
      "Approve a step that is WAITING_APPROVAL. boundHash MUST equal the hash in migration_run_status.nextAction.approval (a stale hash is refused with 409 approval-stale and the human must review again); acks and confirmName come from that same binding (on a multi-host run a typed confirmation names EVERY target server: the distinct names sorted by code point, joined with a comma and a space, then the source host for the +source-host kinds). The POINT-OF-NO-RETURN approval (the VERIFY step that leads to the CUTOVER) and the decommission approval are REFUSED here with 403 human-confirmation-required: tell the human to approve it in the panel or with `tugra import run approve`.",
    scope: "deploy",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        stepKey: { type: "string" },
        boundHash: { type: "string" },
        acks: { type: "array", items: { type: "string" } },
        confirmName: { type: "string" },
        acceptDataRisk: { type: "boolean" },
      },
      required: ["runId", "stepKey", "boundHash"],
    },
    execute: async (d, userId, a, ctx) => {
      const key = parseWith(StepKeySchema, a.stepKey);
      const { runId, stepKey, ...body } = a;
      void runId;
      void stepKey;
      return d.migrationRuns.approve(mcpActor(userId, ctx), reqRunId(a), key, parseWith(StepApproveSchema, body));
    },
  },
  {
    name: "migration_run_retry",
    description: "Re-enter a FAILED or waiting step. Retrying IMPORT is a rollback of the failed op plus a re-apply on a fresh op (at most 2 attempts). Nothing is retried automatically.",
    scope: "deploy",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, stepKey: { type: "string" } }, required: ["runId", "stepKey"] },
    execute: async (d, userId, a, ctx) => d.migrationRuns.retry(mcpActor(userId, ctx), reqRunId(a), parseWith(StepKeySchema, a.stepKey), parseWith(StepRetrySchema, {})),
  },
  {
    name: "migration_run_pause",
    description: "Stop a run's forward progress. Nothing is undone and the source is not touched; resume with migration_run_resume.",
    scope: "deploy",
    inputSchema: runIdSchema,
    execute: async (d, userId, a, ctx) => d.migrationRuns.pause(mcpActor(userId, ctx), reqRunId(a)),
  },
  {
    name: "migration_run_resume",
    description: "Resume a paused run.",
    scope: "deploy",
    inputSchema: runIdSchema,
    execute: async (d, userId, a, ctx) => d.migrationRuns.resume(mcpActor(userId, ctx), reqRunId(a)),
  },
  {
    name: "migration_run_abort",
    description:
      "Abort a run BEFORE its point of no return (409 run-past-ponr afterwards): makes the source authoritative again (cancels in-flight copies, revokes the migrator token, restarts the recorded frozen source containers or reports them for a manual restart, restores DNS TTLs, stops the Tugra copies, undoes the env remap). Never deletes data. Requires confirmName to equal the runId.",
    scope: "deploy",
    inputSchema: { type: "object", properties: { runId: { type: "string" }, confirmName: { type: "string" } }, required: ["runId", "confirmName"] },
    execute: async (d, userId, a, ctx) => {
      const runId = reqRunId(a);
      requireConfirmName(a, runId, "migration run"); // echo the run id to confirm
      return d.migrationRuns.abort(mcpActor(userId, ctx), runId, parseWith(AbortRunSchema, { confirmName: runId }));
    },
  },
  {
    name: "migration_run_cleanup",
    description:
      "DESTRUCTIVE: after an ABORTED run, remove the Tugra-side resources the run created. Data-bearing resources (databases, volumes) are only removed with includeData=true AND each resource's exact name in dataConfirmNames. Requires confirmName to equal the runId and the admin scope.",
    scope: "admin",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        confirmName: { type: "string" },
        includeData: { type: "boolean" },
        dataConfirmNames: { type: "array", items: { type: "string" } },
      },
      required: ["runId", "confirmName"],
    },
    execute: async (d, userId, a, ctx) => {
      const runId = reqRunId(a);
      requireConfirmName(a, runId, "migration run");
      return d.migrationRuns.cleanup(
        mcpActor(userId, ctx),
        runId,
        parseWith(CleanupRunSchema, { confirmName: runId, includeData: a.includeData === true, dataConfirmNames: a.dataConfirmNames ?? [] }),
      );
    },
  },
  {
    name: "migration_run_reverse",
    description:
      "DESTRUCTIVE, LOSSY: after the point of no return, restore DNS from the cutover ledger (or reverse the proxy swap) so traffic returns to the source. Data Tugra wrote after the cutover is NOT restored and nothing syncs backwards. Requires confirmName equal to the runId, acknowledgeDataLoss=true and the admin scope.",
    scope: "admin",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" }, confirmName: { type: "string" }, acknowledgeDataLoss: { type: "boolean" } },
      required: ["runId", "confirmName", "acknowledgeDataLoss"],
    },
    execute: async (d, userId, a, ctx) => {
      const runId = reqRunId(a);
      requireConfirmName(a, runId, "migration run");
      if (a.acknowledgeDataLoss !== true) throw new Error("reverse refused — pass acknowledgeDataLoss=true: data Tugra wrote after the cutover is not restored on the source");
      return d.migrationRuns.reverse(mcpActor(userId, ctx), runId, parseWith(ReverseRunSchema, { confirmName: runId, acknowledgeDataLoss: true }));
    },
  },

  // ── read: the move off Coolify (takeover, cleanup, campaigns, SSH agent install, project moves) ──────────────
  // Status only, all scope:"read". They call the same hub services as the REST routes, which check the team role again
  // (owner/admin) and return names, counts, statuses and fixed codes: never a secret value, a key, a token or an address.
  // Acting (taking over, cleaning up, installing, moving) stays in the panel: those steps need the owner's typed consent.
  {
    name: "coolify_move_status",
    description:
      "Progress of the whole move off Coolify for a team, in ONE call: per server (agent online, takeover status, cleanup status and the stage it needs next: agent | takeover | cleanup | done | hub | not_coolify), the Coolify host (last read, whether the consent to read Coolify's secrets is active, the newest agent install over SSH as counts), the campaigns, the project moves, and the four steps (takeover, cleanup, consolidate, shutdown) with done/total. Team owner or admin. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { teamId: { type: "string" } }, required: ["teamId"] },
    execute: async (d, userId, a) => d.coolifyMove.status(userId, reqId(a, "teamId")),
  },
  {
    name: "coolify_takeover_status",
    description:
      "Take-over status of one server: the Coolify inventory read on it (counts only, no inventory body), the consent to read Coolify's secrets (classes, window, status; never a value or key) and the in-place takeovers with their status, tested domains and certificate state. Args: serverId (the Tugra server). Team owner or admin. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { serverId: { type: "string" } }, required: ["serverId"] },
    execute: async (d, userId, a) => d.coolifyMove.takeoverStatus(userId, reqId(a, "serverId")),
  },
  {
    name: "migration_campaign_status",
    description:
      "Status of the migration campaigns (a mixed placement becomes one guided run per source server, in waves): pass teamId to list them, or teamId and id for one (its runs and where each stands come from migration_run_list with campaign=<label>). Team owner or admin. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { teamId: { type: "string" }, id: { type: "string" } }, required: ["teamId"] },
    execute: async (d, userId, a) => d.coolifyMove.campaignStatus(userId, reqId(a, "teamId"), a.id === undefined ? undefined : reqId(a, "id")),
  },
  {
    name: "coolify_cleanup_status",
    description:
      "The newest Coolify cleanup checklist of one server (null when none was made): Coolify's items compared one by one with their Tugra counterparts (missing refs, unreadable rows), the leftovers found (names and sizes, with why one is kept), and whether the checklist is complete. Never a value or key. Args: serverId. Team owner or admin. Read-only; it does not check the server, to check or remove use the panel.",
    scope: "read",
    inputSchema: { type: "object", properties: { serverId: { type: "string" } }, required: ["serverId"] },
    execute: async (d, userId, a) => d.coolifyMove.cleanupStatus(userId, reqId(a, "serverId")),
  },
  {
    name: "coolify_ssh_install_status",
    description:
      "Status of installing the Tugra agent on the servers Coolify knows, over Coolify's own SSH keys: for the newest run (or runId) every server with its state (planned, probing, ready, installing, online, failed, skipped, ...), the fixed failure code, whether a manual install command is offered and whether the agent can be removed again. No key, token, command or address. Args: serverId (the Coolify host's Tugra server), runId (optional). Team owner or admin. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { serverId: { type: "string" }, runId: { type: "string" } }, required: ["serverId"] },
    execute: async (d, userId, a) => d.coolifyMove.sshInstallStatus(userId, reqId(a, "serverId"), a.runId === undefined ? undefined : reqId(a, "runId")),
  },
  {
    name: "project_move_status",
    description:
      "Status of moving a whole project (apps, databases, services, volumes, domains) from one Tugra server to another: pass projectId for its newest moves, or projectId and moveId for one move with its items, verification report, DNS steps to do and the safety-copy deadline. Read-only; starting or cancelling a move stays in the panel.",
    scope: "read",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, moveId: { type: "string" } }, required: ["projectId"] },
    execute: async (d, userId, a) => d.coolifyMove.projectMoveStatus(userId, reqId(a, "projectId"), a.moveId === undefined ? undefined : reqId(a, "moveId")),
  },

  // ── read: fleet aggregators (agent-native fleet-first) ────────────────────────────────────────────
  // One-call fleet views so an agent doesn't have to loop list_applications + per-cluster calls itself.
  // All scope:"read" and pass userId straight through — every result is already scoped DB-side to what the
  // caller can see (apps.list / clusters.list resolve team + per-resource access), so filtering their
  // output here can never widen visibility.
  {
    name: "fleet_list_apps",
    description:
      "Fleet overview: list applications across the caller's teams in ONE call, with optional filters — clusterId, serverId, status (NEW|RUNNING|STOPPED|FAILED), tag. Returns slim records (id, name, status, clusterId, serverId, domain, tags). Read-only; already scoped to apps the caller can access. Capped at " +
      String(MAX_FLEET_LIST) +
      " (the `truncated` flag is set above that).",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        clusterId: { type: "string" },
        serverId: { type: "string" },
        status: { type: "string", enum: ["NEW", "RUNNING", "STOPPED", "FAILED"] },
        tag: { type: "string" },
      },
    },
    execute: async (d, userId, a) => {
      const clusterId = optStr(a, "clusterId");
      const serverId = optStr(a, "serverId");
      // Stored tags are canonicalized (normalizeTags: lowercase/trim/[a-z0-9-]); normalize the filter the
      // same way so "Prod" matches "prod" (mirrors the case-insensitive status filter). A tag that
      // normalizes to nothing stays a defined "" so the filter still applies and matches nothing.
      const rawTag = optStr(a, "tag");
      const tag = rawTag === undefined ? undefined : (normalizeTags([rawTag])[0] ?? "");
      let status = optStr(a, "status");
      if (status) {
        status = status.toUpperCase();
        if (!APP_STATUSES.has(status)) throw new Error(`invalid status: must be one of ${[...APP_STATUSES].join(", ")}`);
      }
      const all = (await d.apps.list(userId)) as Array<{
        id: string;
        name: string;
        status: string;
        clusterId: string | null;
        serverId: string;
        domain: string | null;
        tags?: string[];
      }>;
      const matched = all.filter(
        (app) =>
          (!clusterId || app.clusterId === clusterId) &&
          (!serverId || app.serverId === serverId) &&
          (!status || app.status === status) &&
          (tag === undefined || (app.tags ?? []).includes(tag)),
      );
      const apps = matched.slice(0, MAX_FLEET_LIST).map((app) => ({
        id: app.id,
        name: app.name,
        status: app.status,
        clusterId: app.clusterId,
        serverId: app.serverId,
        domain: app.domain ?? null,
        tags: app.tags ?? [],
      }));
      return { ok: true, total: matched.length, count: apps.length, truncated: matched.length > apps.length, apps };
    },
  },
  {
    name: "fleet_health_rollup",
    description:
      "Fleet health: per-cluster node + app health (online/offline/pending nodes; running/stopped/failed/new apps) plus fleet-wide totals, in ONE call. Optional teamId filter. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { teamId: { type: "string" } } },
    execute: async (d, userId, a) => {
      const teamId = optStr(a, "teamId");
      const clusters = (await d.clusters.list(userId, teamId)) as Array<{ id: string; name: string; swarmStatus: string }>;
      const rollups = await Promise.all(
        clusters.map(async (c) => {
          try {
            const detail = (await d.clusters.get(userId, c.id)) as {
              health?: { nodes: Record<string, number>; apps: Record<string, number> };
            };
            return { id: c.id, name: c.name, swarmStatus: c.swarmStatus, health: detail.health ?? null };
          } catch (e) {
            // One cluster's health failing (e.g. a transient race) must not sink the whole rollup.
            return { id: c.id, name: c.name, swarmStatus: c.swarmStatus, health: null, error: e instanceof Error ? e.message : "health unavailable" };
          }
        }),
      );
      const totals = {
        nodes: { online: 0, offline: 0, pending: 0, total: 0 },
        apps: { running: 0, stopped: 0, failed: 0, new: 0, total: 0 },
      };
      for (const r of rollups) {
        if (!r.health) continue;
        for (const k of Object.keys(totals.nodes) as Array<keyof typeof totals.nodes>) totals.nodes[k] += Number(r.health.nodes?.[k] ?? 0);
        for (const k of Object.keys(totals.apps) as Array<keyof typeof totals.apps>) totals.apps[k] += Number(r.health.apps?.[k] ?? 0);
      }
      return { ok: true, clusterCount: clusters.length, clusters: rollups, totals };
    },
  },
  {
    name: "fleet_status",
    description:
      "Fleet summary: total clusters/servers/apps, the app-status breakdown (running/stopped/failed/new), and cluster/server status tallies, in ONE call. Optional teamId narrows the summary to one team. Read-only.",
    scope: "read",
    inputSchema: { type: "object", properties: { teamId: { type: "string" } } },
    execute: async (d, userId, a) => {
      const teamId = optStr(a, "teamId");
      const [clusters, apps, servers] = (await Promise.all([
        d.clusters.list(userId, teamId),
        d.apps.list(userId),
        // clusters.list + servers.listForUser both take the teamId filter (still perm-checked server-side,
        // so it can't widen); apps.list isn't team-parameterised, so narrow apps by teamId in-memory below.
        d.servers.listForUser(userId, teamId ? { teamId } : undefined),
      ])) as [Array<{ swarmStatus: string }>, Array<{ status: string; teamId: string }>, Array<{ status: string }>];
      const teamApps = teamId ? apps.filter((x) => x.teamId === teamId) : apps;
      const appStatus: Record<string, number> = { RUNNING: 0, STOPPED: 0, FAILED: 0, NEW: 0 };
      for (const x of teamApps) if (x.status in appStatus) appStatus[x.status] += 1;
      const bySwarmStatus: Record<string, number> = {};
      for (const c of clusters) bySwarmStatus[c.swarmStatus] = (bySwarmStatus[c.swarmStatus] ?? 0) + 1;
      const byServerStatus: Record<string, number> = {};
      for (const s of servers) byServerStatus[s.status] = (byServerStatus[s.status] ?? 0) + 1;
      return {
        ok: true,
        clusters: { total: clusters.length, bySwarmStatus },
        servers: { total: servers.length, byStatus: byServerStatus },
        apps: { total: teamApps.length, running: appStatus.RUNNING, stopped: appStatus.STOPPED, failed: appStatus.FAILED, new: appStatus.NEW },
      };
    },
  },

  // ── read: files (ties the sandboxed file browser into the agent surface) ──────────────
  {
    name: "list_files",
    description:
      "List files/directories inside one of an application's DECLARED volumes — metadata only (name, type file|dir|symlink, size, mode, mtime), NEVER file contents, and symlinks are reported not followed. Args: id (application), volume (a declared volume name), path (optional, volume-relative; omitted = volume root). The agent runs the listing in a sandboxed read-only helper on the server. Read-only.",
    // read:secrets like get_app_logs: a file listing can expose sensitive application structure, and the
    // hub's listFiles additionally enforces WRITE permission on the app, so this is double-gated.
    scope: "read:secrets",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, volume: { type: "string" }, path: { type: "string" } },
      required: ["id", "volume"],
    },
    execute: (d, userId, a) => d.apps.listFiles(userId, reqStr(a, "id"), reqStr(a, "volume"), optStr(a, "path") ?? ""),
  },

  // ── read: an app's database links (agent sees what DBs feed an app, without any credential) ────────
  {
    name: "list_database_links",
    description:
      "List the managed databases linked to an application and the env var each one's connection URI is injected under at deploy. Metadata only — NEVER the connection string, host, username or password; a database the caller can't access is returned as a restricted placeholder. Args: id (application). Read-only.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    execute: (d, userId, a) => d.dbLinks.list(userId, reqStr(a, "id")),
  },

  // ── read: instance edition / license status (agent-visible monetization state) ────────────────────
  {
    name: "get_license_status",
    description:
      "The instance's edition + license status: plan (community | pro | …), whether a paid license is currently valid, its ISO expiry (or null), and the source. Instance-wide, read-only, contains no secret (never the license token or signing key).",
    scope: "read",
    inputSchema: noArgs,
    execute: async (d) => d.license.status(),
  },
];
