import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { AgentWsServer } from "../../../agent-gateway/agent-ws.server";
import { AuditService } from "../../../audit/audit.service";
import { InstanceSettingsService } from "../../../instance/instance-settings.service";
import { CryptoService } from "../../../crypto/crypto.service";
import { containerName } from "../../../deploy/deploy-script";
import { serviceDataVolumes } from "../../../cutover/cutover.logic";
import { isObjectStoreResult } from "../../../importer/volume-stream/vx-targets";
import { objectStoreKeys, type ObjectsVerification } from "./cutover-holds";
import type { CoolifyProxySnapshot, SwapState } from "./proxy-swap";

/** An app the run's import op created, with the one fact the PONR rule needs: does it carry data to the target at all? */
export interface OpApp {
  appId: string;
  itemRef: string | null;
  /** The app depends on a database or a volume (whether or not their data task already finished): once it serves traffic
   *  on Tugra it takes writes the source does not have. `CutoverDomain.stateful` is only true while that data is NOT yet
   *  moved, so it cannot decide the point of no return after DATA_FINAL (see cutover.handler). */
  hasData: boolean;
  domain: string | null;
  extraDomains: string[];
  /** Compose service domains (`AppServiceDomain`). */
  serviceHosts: string[];
  clusterId: string | null;
  /** `service` for a compose service the import created (a MinIO, a Meilisearch...), `app` (the default) for everything else. */
  kind?: "app" | "service";
  /** The Tugra server the app runs on (the target of ITS source server): hosts flip per server. */
  serverId?: string;
  /** Application status (`RUNNING`, `STOPPED`, ...). */
  status?: string;
  /** The service IS an object store (one of its members is a MinIO). */
  objectStore?: boolean;
}

/** What the repoint guidance of a git webhook needs about an app (never a token, never a credential in a URL). */
export interface GitWebhookApp {
  appId: string;
  name: string;
  /** `github-app`: one webhook on the git source (shared by its apps); `deploy-token`: a webhook per app. */
  kind: "github-app" | "deploy-token";
  /** Repository as `host/owner/repo` (userinfo and `.git` removed); null when the app has no git url. */
  repo: string | null;
  /** The git source id (github-app only): it is the path of the shared webhook. */
  sourceId: string | null;
  autoDeploy: boolean;
}

export interface SwapRow {
  id: string;
  runId: string;
  serverId: string;
  state: SwapState;
  coolifyProxy: CoolifyProxySnapshot;
  tugraProxyBindBefore: string;
  liveAt: Date | null;
}

export interface ServerFacts {
  id: string;
  name: string;
  teamId: string;
  publicIp: string | null;
  proxyBind: string;
}

/**
 * Everything the cutover-side step handlers touch that no existing service exposes: the swap row, the agent shell,
 * a few read-only queries over the op's resources, backups and container events. One small injectable so the handlers'
 * specs replace it with an in-memory fake (see testing/cutover-world.ts) and never need a database or an agent.
 */
@Injectable()
export class CutoverWorld {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly settings: InstanceSettingsService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    /** Optional so existing callers keep working; without it the object-store dependency of an app reads as unknown (no names). */
    @Optional() private readonly crypto?: CryptoService,
  ) {}

  // ── the import op's resources (read-only) ──────────────────────────────────────────────────

  async opApps(opId: string): Promise<OpApp[]> {
    // The import's compose SERVICES are applications too (kind "service"): they serve hostnames and carry data.
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: { in: ["app", "service"] }, status: "DONE", resourceType: "application" }, select: { itemRef: true, kind: true, resourceId: true, dependsOn: true, result: true } });
    const ids = tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
    const apps = await this.prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, domain: true, extraDomains: true, clusterId: true, serverId: true, status: true } });
    const byId = new Map(apps.map((a) => [a.id, a]));
    const svc = await this.prisma.appServiceDomain.findMany({ where: { applicationId: { in: ids } }, select: { applicationId: true, hostname: true } });
    return tasks.flatMap((t) => {
      const a = t.resourceId ? byId.get(t.resourceId) : undefined;
      if (!a) return [];
      const isService = t.kind === "service";
      const hasData = (t.dependsOn ?? []).some((d) => d.startsWith("database:") || d.startsWith("volume:")) || (isService && serviceDataVolumes(t.result) > 0);
      const serviceHosts = svc.filter((x) => x.applicationId === a.id).map((x) => x.hostname.toLowerCase());
      return [{ appId: a.id, itemRef: t.itemRef, hasData, domain: a.domain, extraDomains: a.extraDomains ?? [], serviceHosts, clusterId: a.clusterId, kind: isService ? ("service" as const) : ("app" as const), serverId: a.serverId, status: a.status, objectStore: isService && isMinioResult(t.result) }];
    });
  }

  /**
   * The env var NAMES of each app that point at an object store (see `isObjectStoreKey`), and the apps whose env could NOT be
   * read (no crypto service, a value that does not decrypt, a body that is not JSON). Only names leave this method: the env is
   * decrypted here to list its keys and nothing else is read or kept. An unreadable env is reported, never read as "no keys":
   * the caller treats such an app as a possible dependant and names it, so the object-store default fails closed.
   */
  async appObjectEnv(appIds: readonly string[]): Promise<{ keys: Map<string, string[]>; unreadable: string[] }> {
    const keys = new Map<string, string[]>();
    if (appIds.length === 0) return { keys, unreadable: [] };
    if (!this.crypto) return { keys, unreadable: [...appIds] };
    const unreadable: string[] = [];
    const rows = await this.prisma.application.findMany({ where: { id: { in: [...appIds] } }, select: { id: true, env: true, envEnc: true } });
    for (const r of rows) {
      let names: string[];
      try {
        const env = r.envEnc ? (JSON.parse(this.crypto.decrypt(r.envEnc)) as Record<string, unknown>) : ((r.env ?? {}) as Record<string, unknown>);
        if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env is not an object");
        names = Object.keys(env);
      } catch {
        unreadable.push(r.id);
        continue;
      }
      const hit = objectStoreKeys(names);
      if (hit.length > 0) keys.set(r.id, hit);
    }
    return { keys, unreadable: unreadable.sort() };
  }

  /** The names part of {@link appObjectEnv}. */
  async appObjectKeys(appIds: readonly string[]): Promise<Map<string, string[]>> {
    return (await this.appObjectEnv(appIds)).keys;
  }

  /**
   * What the object migrations attached to the run say, read-only: counts of selected buckets by outcome. Scoped to the run's
   * team, so an id from another team reads as absent. Null when there are no ids (nothing was attached).
   */
  async objectsVerification(teamId: string, migrationIds: readonly string[]): Promise<ObjectsVerification | null> {
    if (migrationIds.length === 0) return null;
    const migrations = await this.prisma.objectMigration.findMany({ where: { id: { in: [...migrationIds] }, teamId }, select: { id: true } });
    if (migrations.length === 0) return { attached: 0, selectedBuckets: 0, verified: 0, problems: 0 };
    const buckets = await this.prisma.objectMigrationBucket.findMany({ where: { migrationId: { in: migrations.map((m) => m.id) }, selected: true }, select: { status: true } });
    return {
      attached: migrations.length,
      selectedBuckets: buckets.length,
      verified: buckets.filter((b) => b.status === "VERIFIED").length,
      problems: buckets.filter((b) => b.status === "DIFFERS" || b.status === "FAILED").length,
    };
  }

  /**
   * Git webhook facts of the given apps for the post-cutover repoint guidance (names, repository and source id only). Only a
   * GitHub-App source has the shared receiver (`/webhooks/github/<sourceId>`, it needs the source's webhook secret); an app
   * on a token provider (gitea, forgejo, codeberg) or without a source has its own per-app deploy webhook.
   */
  async gitWebhookApps(appIds: readonly string[]): Promise<GitWebhookApp[]> {
    if (appIds.length === 0) return [];
    const rows = await this.prisma.application.findMany({ where: { id: { in: [...appIds] }, source: "GIT" }, select: { id: true, name: true, gitUrl: true, gitSourceId: true, autoDeploy: true }, orderBy: { name: "asc" } });
    const sourceIds = [...new Set(rows.map((r) => r.gitSourceId).filter((x): x is string => !!x))];
    const sources = sourceIds.length > 0 ? await this.prisma.gitSource.findMany({ where: { id: { in: sourceIds } }, select: { id: true, provider: true, webhookSecretEnc: true } }) : [];
    const shared = new Map(sources.map((x) => [x.id, { provider: x.provider, receiver: !!x.webhookSecretEnc }]));
    return rows.map((r) => {
      const src = r.gitSourceId ? shared.get(r.gitSourceId) : undefined;
      const github = !!src && src.receiver && src.provider === "github";
      return { appId: r.id, name: r.name, kind: github ? ("github-app" as const) : ("deploy-token" as const), repo: sanitizeRepo(r.gitUrl), sourceId: github ? r.gitSourceId : null, autoDeploy: r.autoDeploy };
    });
  }

  /** The hub's public base URL (no trailing slash) when configured, else null: the webhook guidance names the path only then. */
  hubPublicUrl(): string | null {
    const v = (this.config.get<string>("HUB_PUBLIC_URL") ?? "").trim().replace(/\/+$/, "");
    return /^https?:\/\/[^\s]+$/.test(v) ? v : null;
  }

  async opDatabaseIds(opId: string): Promise<string[]> {
    const tasks = await this.prisma.bulkTask.findMany({ where: { opId, kind: "database", status: "DONE", resourceType: "database" }, select: { resourceId: true } });
    return tasks.map((t) => t.resourceId).filter((x): x is string => !!x);
  }

  /** Container names of the op's apps and databases on the target (the OBSERVE crash watch). */
  async opContainerNames(opId: string): Promise<string[]> {
    const apps = await this.opApps(opId);
    const dbs = await this.opDatabaseIds(opId);
    return [...apps.map((a) => containerName({ id: a.appId })), ...dbs.map((d) => `tugra_db_${d}`)];
  }

  // ── servers and the agent shell ────────────────────────────────────────────────────────────

  async serverFacts(serverId: string): Promise<ServerFacts | null> {
    const s = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, name: true, teamId: true, publicIp: true, proxyBind: true } });
    return s ? { id: s.id, name: s.name, teamId: s.teamId, publicIp: s.publicIp ?? null, proxyBind: s.proxyBind } : null;
  }

  async setProxyBind(serverId: string, bind: "public" | "loopback" | "none"): Promise<void> {
    await this.prisma.server.update({ where: { id: serverId }, data: { proxyBind: bind } });
  }

  /** Run a hub-built script on the host through the agent (`deploy` capability, like every proxy script). */
  async exec(serverId: string, script: string, timeoutMs = 60_000): Promise<{ exitCode: number; output: string }> {
    return this.agentWs.sendCommand(serverId, script, "deploy", timeoutMs);
  }

  /** Other RUNNING apps on the server that this op did not create: restarting the proxy would drop their ingress. */
  async otherLiveApps(serverId: string, excludeAppIds: string[]): Promise<number> {
    return this.prisma.application.count({ where: { serverId, status: "RUNNING", id: { notIn: excludeAppIds } } });
  }

  /** Does the instance already have an ACME account email (env or owner value)? */
  async acmeEmailKnown(): Promise<boolean> {
    return !!(await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL")));
  }

  /** Is this user the instance owner (the only one who may change instance-wide settings)? Fail-closed. */
  async isInstanceOwner(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    return u?.isInstanceOwner === true;
  }

  /**
   * Apply the run's ACME email ONLY when the instance has none (an env or owner value is never overwritten) AND the run's
   * actor is the instance owner: the ACME contact is instance-wide (every team's certificates), which `PATCH /instance/settings`
   * reserves to the owner. The write is audited like that route's. Returns false when nothing was written.
   */
  async applyAcmeEmailIfMissing(email: string, actorUserId: string): Promise<boolean> {
    const existing = await this.settings.acmeEmailFor(this.config.get<string>("ACME_EMAIL"));
    if (existing) return false;
    if (!(await this.isInstanceOwner(actorUserId))) return false;
    await this.settings.update({ acmeEmail: email });
    await this.audit.log({ actor: actorUserId, action: "instance_settings.update", target: "singleton", meta: { by: "migration-run", fields: ["acmeEmail"] } }).catch(() => undefined);
    return true;
  }

  // ── the op's migration token ───────────────────────────────────────────────────────────────

  async migrationTokenActive(opId: string): Promise<boolean> {
    const op = await this.prisma.bulkOperation.findUnique({ where: { id: opId }, select: { migrationTokenHash: true } });
    return !!op?.migrationTokenHash;
  }

  /** Kill the op's live migration token (the same single-row update `MigrationTokenService.revoke` does). Idempotent. */
  async revokeMigrationToken(opId: string, actor: string): Promise<boolean> {
    const res = await this.prisma.bulkOperation.updateMany({ where: { id: opId, migrationTokenHash: { not: null } }, data: { migrationTokenHash: null, migrationTokenExpiresAt: null } });
    if (res.count > 0) await this.audit.log({ actor, action: "import.migration_token.revoke", target: opId, meta: { by: "migration-run" } }).catch(() => undefined);
    return res.count > 0;
  }

  // ── the swap row ───────────────────────────────────────────────────────────────────────────

  private toSwap(r: { id: string; runId: string; serverId: string; state: string; coolifyProxy: Prisma.JsonValue; tugraProxyBindBefore: string; liveAt: Date | null }): SwapRow {
    return { id: r.id, runId: r.runId, serverId: r.serverId, state: r.state as SwapState, coolifyProxy: r.coolifyProxy as unknown as CoolifyProxySnapshot, tugraProxyBindBefore: r.tugraProxyBindBefore, liveAt: r.liveAt };
  }

  async getSwap(runId: string, serverId: string): Promise<SwapRow | null> {
    const r = await this.prisma.migrationRunSwap.findUnique({ where: { runId_serverId: { runId, serverId } } });
    return r ? this.toSwap(r) : null;
  }

  /** Create the PLANNED row (idempotent: a second call returns the existing row, never overwrites its snapshot). */
  async createSwap(runId: string, serverId: string, snapshot: CoolifyProxySnapshot, bindBefore: string): Promise<SwapRow> {
    const existing = await this.getSwap(runId, serverId);
    if (existing) return existing;
    try {
      const r = await this.prisma.migrationRunSwap.create({ data: { runId, serverId, state: "PLANNED", coolifyProxy: snapshot as unknown as Prisma.InputJsonValue, tugraProxyBindBefore: bindBefore } });
      return this.toSwap(r);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const again = await this.getSwap(runId, serverId);
        if (again) return again;
      }
      throw e;
    }
  }

  /** Compare-and-set the swap state; returns false when the row was not in one of `from`. */
  async setSwapState(runId: string, serverId: string, from: readonly SwapState[], to: SwapState): Promise<boolean> {
    const at = new Date();
    const data: Prisma.MigrationRunSwapUpdateManyMutationInput = { state: to };
    if (to === "STARTING_TARGET_PROXY") data.stoppedAt = at;
    if (to === "LIVE") data.liveAt = at;
    if (to === "REVERSED") data.reversedAt = at;
    const r = await this.prisma.migrationRunSwap.updateMany({ where: { runId, serverId, state: { in: [...from] } }, data });
    return r.count === 1;
  }

  // ── observation queries ────────────────────────────────────────────────────────────────────

  /**
   * Crash/OOM episodes since `since` of the given containers. Each name matches the container itself AND its compose
   * services (`<name>-<service>-<n>`, the project name is `tugra_<appId>`), which are the containers a compose app runs as.
   */
  async crashEventsSince(serverId: string, containerNames: readonly string[], since: Date): Promise<number> {
    if (containerNames.length === 0) return 0;
    const names = [...containerNames];
    return this.prisma.containerEvent.count({ where: { serverId, ts: { gte: since }, OR: [{ containerName: { in: names } }, ...names.map((n) => ({ containerName: { startsWith: `${n}-` } }))] } });
  }

  /**
   * The OTHER real runs of the same source, for the "Coolify host goes last" rule (R67/R70): `live` still move production or can
   * (anything not settled, a FAILED run included, since a retry resumes it); `undecommissioned` finished as takeovers whose own
   * source hosts have not been stopped yet. Counts only: another team's run is never named.
   *
   * "The same source" is not only the typed host string: the same Coolify can be entered as a name in one run and as an address in
   * another, so two runs also belong together when they share a source server uuid (a `serverMap` key) or a source resource ref
   * of the health baseline; those uuids are unique to one instance. A run that offers none of the three cannot be matched to
   * anything: that reads as `null` (unknown), never as "no other run".
   *
   * Only runs the operator could see themselves are counted: those of the run's own team and those created by the same actor
   * (a fleet run team by team from one account). A typed host string such as `localhost` or a private address can be the same text
   * in two unrelated tenants of one hub, so another tenant's run never blocks a decommission and its count is never shown.
   */
  async siblingRuns(run: { id: string; teamId: string; actorId: string; sourceKind: string; sourceHost: string | null; serverMap?: Readonly<Record<string, string>> | null; sourceBaseline?: { entries: ReadonlyArray<{ ref: string }> } | null }): Promise<{ live: number; undecommissioned: number } | null> {
    const mine = sourceIdentityOf(run);
    if (!mine) return null;
    const rows = await this.prisma.migrationRun.findMany({
      where: { id: { not: run.id }, OR: [{ teamId: run.teamId }, { actorId: run.actorId }], sourceKind: run.sourceKind, dryRun: false, status: { notIn: ["ABORTED", "ROLLED_BACK", "REVERSED", "DRY_RUN_DONE"] } },
      select: { status: true, mode: true, sourceHost: true, serverMap: true, sourceBaseline: true, steps: { where: { key: "DECOMMISSION" }, select: { status: true } } },
    });
    let live = 0;
    let undecommissioned = 0;
    for (const r of rows) {
      if (!sameSource(mine, sourceIdentityOf({ sourceHost: r.sourceHost, serverMap: asServerMap(r.serverMap), sourceBaseline: asBaseline(r.sourceBaseline) }))) continue;
      if (r.status !== "COMPLETED") live += 1;
      else if (r.mode === "takeover" && !r.steps.some((s) => s.status === "PASSED" || s.status === "SKIPPED")) undecommissioned += 1;
    }
    return { live, undecommissioned };
  }

  /** For each database: has Tugra taken at least one SUCCESSFUL backup of it? (the DECOMMISSION precondition) */
  async backupCoverage(databaseIds: readonly string[]): Promise<Array<{ databaseId: string; hasSuccess: boolean }>> {
    if (databaseIds.length === 0) return [];
    const rows = await this.prisma.backup.findMany({ where: { databaseId: { in: [...databaseIds] }, status: "SUCCESS" }, select: { databaseId: true }, distinct: ["databaseId"] });
    const ok = new Set(rows.map((r) => r.databaseId));
    return databaseIds.map((databaseId) => ({ databaseId, hasSuccess: ok.has(databaseId) }));
  }
}

/** A compose service is an object store when one of its kept members is a MinIO (the importer stores the member names in the task result). */
export const isMinioResult = isObjectStoreResult;

/** `https://user:token@host/owner/repo.git` -> `host/owner/repo`. Anything that is not a plain git url reads as null (never echo a credential). */
export function sanitizeRepo(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^(?:https?:\/\/|ssh:\/\/|git:\/\/)(?:[^@/\s]*@)?([A-Za-z0-9.-]+)(?::\d+)?\/([^\s?#]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (m) return `${m[1].toLowerCase()}/${m[2]}`;
  const scp = /^(?:[^@\s]+@)?([A-Za-z0-9.-]+):([^\s?#:][^\s?#]*?)(?:\.git)?\/?$/.exec(url.trim());
  return scp ? `${scp[1].toLowerCase()}/${scp[2]}` : null;
}

interface SourceIdentity {
  host: string | null;
  serverRefs: ReadonlySet<string>;
  resourceRefs: ReadonlySet<string>;
}

/** What identifies a run's source instance: its typed host, its source server uuids and its source resource refs; null when it has none of them. */
function sourceIdentityOf(run: { sourceHost: string | null; serverMap?: Readonly<Record<string, string>> | null; sourceBaseline?: { entries: ReadonlyArray<{ ref: string }> } | null }): SourceIdentity | null {
  const serverRefs = new Set(Object.keys(run.serverMap ?? {}));
  const resourceRefs = new Set((run.sourceBaseline?.entries ?? []).map((e) => e.ref));
  if (!run.sourceHost && serverRefs.size === 0 && resourceRefs.size === 0) return null;
  return { host: run.sourceHost, serverRefs, resourceRefs };
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (big.has(v)) return true;
  return false;
};

function sameSource(a: SourceIdentity, b: SourceIdentity | null): boolean {
  if (!b) return false;
  return (!!a.host && a.host === b.host) || intersects(a.serverRefs, b.serverRefs) || intersects(a.resourceRefs, b.resourceRefs);
}

/** A stored JSON column read defensively: anything that is not the expected shape reads as absent. */
function asServerMap(v: unknown): Record<string, string> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : null;
}
function asBaseline(v: unknown): { entries: Array<{ ref: string }> } | null {
  const entries = v && typeof v === "object" ? (v as { entries?: unknown }).entries : undefined;
  return Array.isArray(entries) ? { entries: entries.filter((e): e is { ref: string } => !!e && typeof (e as { ref?: unknown }).ref === "string") } : null;
}
