import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Role } from "@prisma/client";
import {
  AGENT_FEATURE_COOLIFY_SECRETS,
  COOLIFY_SECRET_CLASSES,
  COOLIFY_SECRET_TIER,
  COOLIFY_SECRETS_GRANT_DEFAULT_HOURS,
  COOLIFY_SECRETS_GRANT_MAX_HOURS,
  type CoolifyGrantKind,
  type CoolifyGrantRequest,
  type CoolifyGrantStatus,
  type CoolifyHostGrantView,
  type CoolifySecretClass,
} from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ServersService } from "../servers/servers.service";
import { SealedChannelService } from "./sealed-channel.service";
import { renewImportSession, sessionHardEnd } from "../importer/session-renewal";

const OWNER_ONLY: Role[] = [Role.OWNER];
const READERS: Role[] = [Role.OWNER, Role.ADMIN];
const SWEEP_MS = 60_000;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A consent given without an import session gets a run id that starts like this; every other run id is an import session id. */
const RUNLESS_PREFIX = "cfy-";

const CAPABILITY: Record<CoolifyGrantKind, string> = { secrets: "coolify_secrets", ssh: "coolify_ssh" };

interface GrantRow {
  id: string;
  teamId: string;
  serverId: string;
  kind: string;
  classes: string[];
  grantedById: string;
  runId: string | null;
  recipientPublicKey: string | null;
  recipientKeyEnc: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/** What lane code gets for an active secrets grant: the run, the public half to send to the agent and the wrapped private half to open with. */
export interface ActiveSecretsGrant {
  id: string;
  teamId: string;
  serverId: string;
  runId: string;
  classes: CoolifySecretClass[];
  recipientPublicKey: string;
  recipientKeyEnc: string;
  expiresAt: Date;
}

function statusOf(row: Pick<GrantRow, "revokedAt" | "expiresAt">, now: Date): CoolifyGrantStatus {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

/**
 * Consent grants on a Coolify host (Coolify hub takeover, lane B; the "ssh" kind is used by lane C): create, expire and revoke a
 * `CoolifyHostGrant`, and turn the matching agent capability on and off with it.
 *
 * Rules that hold for every path in here:
 *  - creating a grant is TEAM OWNER only and needs the typed Coolify host name (the owner reads what they are consenting to),
 *  - a grant is time limited (secrets: default 24 h, at most 7 days) and revocable at any moment,
 *  - the agent capability exists only while a grant is active: when the last active grant of that kind on the server ends, the capability
 *    is dropped (the generic capability endpoints cannot add it, see ServersService.setCapabilities),
 *  - when a grant ends its per-run private key is destroyed (set NULL), so envelopes captured later stay shut,
 *  - every step is audited with counts, classes and codes only: never a key, a value or an envelope.
 */
@Injectable()
export class CoolifyHostGrantService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoolifyHostGrantService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly servers: ServersService,
    private readonly sealed: SealedChannelService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep().catch((e) => this.logger.warn(`coolify grant sweep failed: ${e instanceof Error ? e.constructor.name : "error"}`)), SWEEP_MS);
    this.timer.unref?.();
    void this.sweep().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------------

  async list(userId: string, teamId: string): Promise<CoolifyHostGrantView[]> {
    await this.access.requireRole(userId, teamId, READERS);
    const rows = await this.prisma.coolifyHostGrant.findMany({ where: { teamId }, orderBy: { createdAt: "desc" }, take: 100 });
    const now = new Date();
    return rows.map((r) => this.view(r as GrantRow, now));
  }

  /**
   * The active secrets grant of a server, or null. Expiry is enforced HERE as well as by the sweep, so a lapsed grant never serves a read
   * between two sweeps. Lane code (the secrets reader) calls this before every request.
   */
  async activeSecretsGrant(serverId: string): Promise<ActiveSecretsGrant | null> {
    const now = new Date();
    const r = await this.prisma.coolifyHostGrant.findFirst({
      where: { serverId, kind: "secrets", revokedAt: null, expiresAt: { gt: now }, recipientKeyEnc: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    if (!r || !r.recipientKeyEnc || !r.recipientPublicKey || !r.runId) return null;
    return {
      id: r.id, teamId: r.teamId, serverId: r.serverId, runId: r.runId, classes: r.classes as CoolifySecretClass[],
      recipientPublicKey: r.recipientPublicKey, recipientKeyEnc: r.recipientKeyEnc, expiresAt: r.expiresAt,
    };
  }

  // ---- create ---------------------------------------------------------------------------------------------------------------

  /**
   * Consent to the sealed secret read on ONE Coolify host. Team OWNER only. `confirm` must be the server's name, typed. Tier-2 classes
   * (notification tokens, Git App keys, deploy keys) are only ever included when the owner lists them. Idempotent for the same classes:
   * a second call while a grant is active returns it (two admins clicking at once get one run).
   */
  async createSecretsGrant(userId: string, input: Omit<CoolifyGrantRequest, "kind"> & { runId?: string; importSessionId?: string }): Promise<CoolifyHostGrantView> {
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId }, select: { id: true, teamId: true, name: true } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requireRole(userId, server.teamId, OWNER_ONLY);
    if (input.confirm !== server.name) throw new BadRequestException("type the Coolify host's name to confirm");

    const classes = this.resolveClasses(input.classes);
    const hours = this.resolveHours(input.hours);
    // The consent of an import belongs to ITS session: the run id is the session id, and the session must be the granting owner's own,
    // still active, and connected through the agent of this very server.
    let runIdWanted = input.runId;
    // The consent of an import has its own window (`hours`) and never outlives the session's hard end (the session is what the owner connected
    // for, and it now lives on while it is used); the orphan sweep ends it earlier when the session itself ends. A run-less consent has its own window.
    let sessionEnd: number | null = null;
    if (input.importSessionId !== undefined) {
      const session = await this.prisma.importSession.findUnique({ where: { id: input.importSessionId }, select: { id: true, actorId: true, status: true, expiresAt: true, createdAt: true, transport: true, agentServerId: true, teamId: true } });
      if (!session || session.actorId !== userId || session.teamId !== server.teamId || session.transport !== "agent" || session.agentServerId !== server.id) throw new NotFoundException("import session not found");
      if (session.status !== "active" || session.expiresAt.getTime() <= Date.now()) throw new BadRequestException("import session expired or revoked - reconnect");
      runIdWanted = session.id;
      sessionEnd = sessionHardEnd(session.createdAt);
      await renewImportSession(this.prisma, session); // giving the consent is an action on the session
    }
    if (runIdWanted !== undefined && !RUN_ID_RE.test(runIdWanted)) throw new BadRequestException("invalid run id");

    if (!this.agentWs.isOnline(server.id)) throw new ConflictException({ statusCode: 409, code: "agent_offline", message: "the agent on this server is offline" });
    if (!this.agentWs.agentSupports(server.id, AGENT_FEATURE_COOLIFY_SECRETS)) {
      throw new ConflictException({ statusCode: 409, code: "agent_too_old", message: "this server's agent is too old for the sealed secret read - update the agent" });
    }

    const existing = await this.prisma.coolifyHostGrant.findFirst({ where: { serverId: server.id, kind: "secrets", revokedAt: null, expiresAt: { gt: new Date() }, recipientKeyEnc: { not: null } } });
    if (existing) {
      // The same consent asked again for the same run is the same grant (two clicks, one run).
      if (sameSet(existing.classes, classes) && (runIdWanted === undefined || existing.runId === runIdWanted)) return this.view(existing as GrantRow, new Date());
      if (runIdWanted === undefined) throw new ConflictException({ statusCode: 409, code: "grant_active", message: "a grant with other classes is active on this server - revoke it first" });
      // A consent given for an import replaces the one an earlier run left standing (the owner just consented again, for this run): the old
      // run's key is destroyed and its capability handed over.
      await this.end(existing as GrantRow, userId);
      await this.audit.log({ actor: userId, action: "coolify.secrets.revoke", target: server.id, meta: { grantId: existing.id, reason: "superseded" } });
    }

    const key = this.sealed.newRunKey();
    const runId = runIdWanted ?? `${RUNLESS_PREFIX}${randomUUID()}`;
    const row = await this.prisma.coolifyHostGrant.create({
      data: {
        teamId: server.teamId, serverId: server.id, kind: "secrets", classes, grantedById: userId, runId,
        recipientPublicKey: key.publicKeyB64, recipientKeyEnc: key.privateKeyEnc, expiresAt: new Date(Math.min(Date.now() + hours * 3_600_000, sessionEnd ?? Number.POSITIVE_INFINITY)),
      },
    });
    await this.servers.applyCoolifyRunCapability(server.id, CAPABILITY.secrets, true);
    await this.audit.log({ actor: userId, action: "coolify.secrets.grant", target: server.id, meta: { grantId: row.id, classes, hours } });
    return this.view(row as GrantRow, new Date());
  }

  // ---- end ------------------------------------------------------------------------------------------------------------------

  /** The owner withdraws consent. Stops reads at once (the capability drops and the key is destroyed). Idempotent. */
  async revoke(userId: string, grantId: string): Promise<CoolifyHostGrantView> {
    const row = await this.prisma.coolifyHostGrant.findUnique({ where: { id: grantId } });
    if (!row) throw new NotFoundException("grant not found");
    await this.access.requireRole(userId, row.teamId, OWNER_ONLY);
    if (!row.recipientKeyEnc && (row.revokedAt || row.expiresAt.getTime() <= Date.now())) return this.view(row as GrantRow, new Date());
    const ended = await this.end(row as GrantRow, userId);
    await this.audit.log({ actor: userId, action: `coolify.${row.kind}.revoke`, target: row.serverId, meta: { grantId } });
    return this.view(ended, new Date());
  }

  /** The run that owned the grant is over: same effect as a revoke, by the system. Lane code calls this when its import run ends. */
  async finishRun(grantId: string): Promise<void> {
    const row = await this.prisma.coolifyHostGrant.findUnique({ where: { id: grantId } });
    if (!row || (!row.recipientKeyEnc && (row.revokedAt || row.expiresAt.getTime() <= Date.now()))) return;
    await this.end(row as GrantRow, null);
    await this.audit.log({ actor: "system", action: `coolify.${row.kind}.revoke`, target: row.serverId, meta: { grantId, reason: "run_ended" } });
  }

  /** An import session ended: end the secrets grant that was made for that run (if it is still standing). Idempotent. */
  async finishRunByRunId(serverId: string, runId: string): Promise<void> {
    const rows = await this.prisma.coolifyHostGrant.findMany({ where: { serverId, kind: "secrets", runId, recipientKeyEnc: { not: null } }, take: 10 });
    for (const r of rows) await this.finishRun(r.id);
  }

  /**
   * The server's opt-in was withdrawn ("Stop and delete"): every secrets grant of that server ends with it, whatever run it was for.
   * Returns how many grants were ended. Idempotent.
   */
  async endSecretsForServer(serverId: string): Promise<number> {
    const rows = await this.prisma.coolifyHostGrant.findMany({ where: { serverId, kind: "secrets", recipientKeyEnc: { not: null } }, take: 50 });
    for (const r of rows) {
      await this.end(r as GrantRow, null);
      await this.audit.log({ actor: "system", action: "coolify.secrets.revoke", target: serverId, meta: { grantId: r.id, reason: "opt_in_withdrawn" } });
    }
    return rows.length;
  }

  /**
   * An import's consent belongs to its session: when that session is revoked, expired or gone (deleted by the opportunistic purge) the grant
   * ends with it, even though its own window is not over. Run-less grants (`cfy-` run ids) have no session and are left alone.
   */
  private async endOrphanedSessionGrants(now: Date): Promise<number> {
    const live = await this.prisma.coolifyHostGrant.findMany({
      where: { kind: "secrets", revokedAt: null, expiresAt: { gt: now }, recipientKeyEnc: { not: null }, NOT: { runId: { startsWith: RUNLESS_PREFIX } } },
      take: 200,
    });
    const ids = live.flatMap((g) => (g.runId ? [g.runId] : []));
    if (ids.length === 0) return 0;
    const sessions = await this.prisma.importSession.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, expiresAt: true } });
    const ok = new Set(sessions.filter((s) => s.status === "active" && s.expiresAt.getTime() > now.getTime()).map((s) => s.id));
    let n = 0;
    for (const g of live) {
      if (g.runId && ok.has(g.runId)) continue;
      await this.end(g as GrantRow, null);
      await this.audit.log({ actor: "system", action: "coolify.secrets.revoke", target: g.serverId, meta: { grantId: g.id, reason: "session_ended" } });
      n++;
    }
    return n;
  }

  /**
   * Close every grant whose window passed: destroy its key and drop the capability when nothing else keeps it, then reconcile every
   * server that still holds a takeover capability without an active grant (a hub that died between the two steps, or a grant row that
   * was deleted). Runs every minute and at boot, so a hub that was down over a grant's end still closes it. Returns how many grants
   * were closed.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.coolifyHostGrant.findMany({ where: { expiresAt: { lte: now }, recipientKeyEnc: { not: null } }, take: 200 });
    for (const row of due) {
      await this.end(row as GrantRow, null, now, false); // an expired grant keeps no revokedAt: its status stays "expired"
      await this.audit.log({ actor: "system", action: `coolify.${row.kind}.revoke`, target: row.serverId, meta: { grantId: row.id, reason: "expired" } });
    }
    const orphaned = await this.endOrphanedSessionGrants(now);
    await this.reconcile();
    return due.length + orphaned;
  }

  /** A server that holds `coolify_secrets` with no active secrets grant loses it. */
  private async reconcile(): Promise<void> {
    const held = await this.prisma.server.findMany({ where: { capabilities: { has: CAPABILITY.secrets } }, select: { id: true } });
    for (const s of held) await this.dropCapabilityIfUnused(s.id, "secrets");
  }

  private async end(row: GrantRow, byUserId: string | null, now: Date = new Date(), markRevoked = true): Promise<GrantRow> {
    const updated = await this.prisma.coolifyHostGrant.update({
      where: { id: row.id },
      data: {
        ...(markRevoked ? { revokedAt: row.revokedAt ?? now } : {}),
        ...(byUserId ? { revokedById: byUserId } : {}),
        recipientKeyEnc: null,
        recipientPublicKey: null,
      },
    });
    await this.dropCapabilityIfUnused(row.serverId, row.kind as CoolifyGrantKind);
    return updated as GrantRow;
  }

  private async dropCapabilityIfUnused(serverId: string, kind: CoolifyGrantKind): Promise<void> {
    const cap = CAPABILITY[kind];
    if (!cap) return;
    const others = await this.prisma.coolifyHostGrant.count({ where: { serverId, kind, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (others === 0) await this.servers.applyCoolifyRunCapability(serverId, cap, false);
  }

  // ---- validation -----------------------------------------------------------------------------------------------------------

  private resolveClasses(requested: CoolifySecretClass[] | undefined): CoolifySecretClass[] {
    if (requested === undefined) return COOLIFY_SECRET_CLASSES.filter((c) => COOLIFY_SECRET_TIER[c] === "T1");
    const out: CoolifySecretClass[] = [];
    for (const c of requested) {
      if (!(COOLIFY_SECRET_CLASSES as readonly string[]).includes(c)) throw new BadRequestException("unknown secret class");
      if (!out.includes(c)) out.push(c);
    }
    if (out.length === 0) throw new BadRequestException("choose at least one class");
    return out;
  }

  private resolveHours(hours: number | undefined): number {
    const h = hours ?? COOLIFY_SECRETS_GRANT_DEFAULT_HOURS;
    if (!Number.isInteger(h) || h < 1 || h > COOLIFY_SECRETS_GRANT_MAX_HOURS) throw new BadRequestException(`hours must be 1 to ${COOLIFY_SECRETS_GRANT_MAX_HOURS}`);
    return h;
  }

  private view(r: GrantRow, now: Date): CoolifyHostGrantView {
    // No key, no wrapped key, no run id: only what the consent screen shows.
    return {
      id: r.id, kind: r.kind as CoolifyGrantKind, serverId: r.serverId, classes: r.classes as CoolifySecretClass[], status: statusOf(r, now),
      grantedById: r.grantedById, expiresAt: r.expiresAt.toISOString(), revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null, createdAt: r.createdAt.toISOString(),
    };
  }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

