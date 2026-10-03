import { createHash } from "node:crypto";
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
  /** Argument names whose VALUES are secret and must be redacted from the audit-log `meta.args` (e.g. an env
   *  var value the caller is setting). The MCP server nulls these before persisting the audit entry. */
  sensitiveArgs?: string[];
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
/** A required string that MAY be empty (unlike reqStr) — for an env-var VALUE, where "" is legitimate. */
function reqStrAllowEmpty(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`missing required argument: ${key} (expected a string)`);
  return v;
}
/** Standard POSIX-ish env var name — validated because the agent supplies the key (an "A=B"-shaped key would
 *  corrupt the env map). */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Names that would either poke at Object internals or read oddly in an env map — the regex admits them, so
// reject explicitly (defence-in-depth; the merge/delete use own-property semantics so this isn't a live
// pollution vector, but an env var literally named __proto__/constructor/prototype is never legitimate).
const ENV_KEY_DENY = new Set(["__proto__", "constructor", "prototype"]);
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
 * MCP tool catalog. The read tools (below) return metadata only — no decrypted secret VALUES ever (env is
 * key-names only, no credential-bearing URLs). The mutate tools (Phase2a..2e, further down) each carry the
 * scope of the REST route they mirror (`deploy` for lifecycle/swarm ops, `write` for env config, `admin` for
 * irreversible ops) and are thin wrappers over the same team-permission-checked, audited service methods —
 * McpService filters/enforces `scope` on tools/list + tools/call, so a read-only token sees none of them.
 * Still planned: OAuth for third-party clients (Phase3).
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

  // ── mutate: application env config (Phase2c) ─────────────────────────────────────────────────────
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

  // ── mutate: swarm node removal (Phase2c) ─────────────────────────────────────────────────────────
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

  // ── mutate: fleet (Phase2d) ──────────────────────────────────────────────────────────────────────
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
