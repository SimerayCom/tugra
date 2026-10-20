import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MigratorService } from "../migrator/migrator.service";
import { LocalDockerSource } from "./sources/local-docker.source";
import { CoolifySource } from "./sources/coolify.source";
import { CoolifyClientFactory } from "./sources/coolify-client.factory";
import { assertAllowedUrl } from "./sources/ssrf-guard";
import { planImport } from "./import-planner";
import type { ImportPlan } from "./foreign-fleet";
import type { ImportConnectInput, ImportPlanRequestInput } from "./dto";

const SESSION_TTL_MS = 60 * 60_000; // 1h — long enough to review → apply, short enough to limit a stored token

/**
 * Importer orchestration — the DRY-RUN side: connect to a remote source (encrypted session) and preview an
 * import plan. Authorization is team-scoped (`apps:config`); the local-docker source additionally reuses the
 * migrator's per-server check. The remote API token is encrypted at rest and never returned.
 */
@Injectable()
export class ImporterService {
  constructor(
    private readonly migrator: MigratorService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly coolify: CoolifyClientFactory,
  ) {}

  /** Verify a Coolify instance is reachable with the given token, then store an encrypted, expiring session. */
  async connect(userId: string, input: ImportConnectInput): Promise<{ sessionId: string; expiresAt: Date }> {
    await this.access.requirePermission(userId, input.teamId, "apps:config");
    try {
      assertAllowedUrl(input.baseUrl); // scheme / credentials / blocked-IP-literal — a 400, not a 500
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : "invalid base URL");
    }
    // Opportunistic GC: expired sessions are dead weight (encrypted + unusable); purge them on connect.
    await this.prisma.importSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const source = new CoolifySource(this.coolify.create(input.baseUrl, input.token));
    let ok: { ok: boolean; detail?: string };
    try {
      ok = await source.verify();
    } finally {
      await source.close();
    }
    if (!ok.ok) throw new BadRequestException(`could not reach Coolify: ${ok.detail ?? "verification failed"}`);

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const session = await this.prisma.importSession.create({
      data: {
        teamId: input.teamId,
        actorId: userId,
        sourceKind: "coolify",
        baseUrl: input.baseUrl,
        tokenEnc: this.crypto.encrypt(input.token), // never stored or returned in the clear
        status: "active",
        expiresAt,
      },
    });
    await this.audit.log({ actor: userId, action: "import.connect", target: session.id, meta: { sourceKind: "coolify", teamId: input.teamId, baseUrl: input.baseUrl } });
    return { sessionId: session.id, expiresAt };
  }

  async plan(userId: string, input: ImportPlanRequestInput): Promise<ImportPlan> {
    if (input.sourceKind === "local-docker") {
      const source = new LocalDockerSource(this.migrator, userId, input.serverId);
      try {
        const fleet = await source.discover();
        return planImport(fleet, { sourceKind: "local-docker", targetServerId: input.serverId });
      } finally {
        await source.close();
      }
    }

    // coolify: resolve the owned, unexpired session → discover over the SSRF-safe client.
    const { source, session } = await this.openSession(userId, input.sessionId);
    try {
      const fleet = await source.discover();
      await this.prisma.importSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
      return planImport(fleet, { sourceKind: "coolify" });
    } finally {
      await source.close();
    }
  }

  /**
   * Resolve an owned, active, unexpired Coolify session into a live {@link CoolifySource} (SSRF-safe client,
   * token decrypted in memory). Enforces session ownership + the session team's apps:config. Shared by the
   * plan path and the apply executor so session authz lives in exactly one place. The caller must close() it.
   */
  async openSession(userId: string, sessionId: string): Promise<{ source: CoolifySource; session: { id: string; teamId: string } }> {
    const session = await this.prisma.importSession.findUnique({ where: { id: sessionId } });
    if (!session || session.sourceKind !== "coolify") throw new NotFoundException("import session not found");
    if (session.actorId !== userId) throw new ForbiddenException("not your import session");
    if (session.status !== "active" || session.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("import session expired or revoked — reconnect");
    }
    await this.access.requirePermission(userId, session.teamId, "apps:config");
    const token = this.crypto.decrypt(session.tokenEnc);
    return { source: new CoolifySource(this.coolify.create(session.baseUrl, token)), session: { id: session.id, teamId: session.teamId } };
  }
}
