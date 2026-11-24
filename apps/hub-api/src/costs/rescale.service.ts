import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { Server, ServerRescale } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { TeamAccessService } from "../common/team-access.service";
import { CloudProviderFactory } from "../cloud/providers/provider-factory.service";
import type { CloudOobProvider, CloudPlanProvider } from "../cloud/providers/cloud-provider.interface";
import { oobHttpError } from "../cloud/oob.service";
import type { RescaleInput, RescaleView } from "./costs.dto";

const TICK_MS = 5_000;
/** A graceful shutdown that has not finished after this long is reported, never forced (a hard cut can lose data). */
const SHUTDOWN_TIMEOUT_MS = 8 * 60_000;
const TOTAL_TIMEOUT_MS = 25 * 60_000;
const TERMINAL = ["DONE", "FAILED"];

interface Link {
  server: Server;
  oob: CloudOobProvider;
  plans: CloudPlanProvider;
  token: string;
  providerServerId: string;
}

export const toRescaleView = (r: ServerRescale): RescaleView => ({
  id: r.id,
  serverId: r.serverId,
  provider: r.provider,
  fromPlan: r.fromPlan,
  toPlan: r.toPlan,
  phase: r.phase as RescaleView["phase"],
  error: r.error,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
});

/**
 * One-click rescale of a cloud-linked server through its provider API: graceful shutdown, change plan (the disk is kept
 * unless asked, so the move stays reversible), power on. The hub drives it step by step from the provider's own state
 * (every step is safe to repeat) and resumes after a restart. Never available for the box the hub runs on, and only for
 * providers whose client can change a plan (Hetzner today). The provider token is decrypted for one call and dropped.
 */
@Injectable()
export class RescaleService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RescaleService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly providers: CloudProviderFactory,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const open = await this.prisma.serverRescale.findMany({ where: { phase: { notIn: TERMINAL } }, select: { id: true } }).catch(() => []);
    for (const r of open) this.schedule(r.id);
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** The latest rescale of a server (any member of its team). */
  async status(userId: string, serverId: string): Promise<{ rescale: RescaleView | null }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { teamId: true } });
    if (!server) throw new NotFoundException("server not found");
    if (!(await this.access.membershipPermissions(userId, server.teamId))) throw new ForbiddenException("not a member of this team");
    const r = await this.prisma.serverRescale.findFirst({ where: { serverId }, orderBy: { startedAt: "desc" } });
    return { rescale: r ? toRescaleView(r) : null };
  }

  /** Start a rescale (servers:manage + the server's name typed). Returns at once; the move continues in the background. */
  async start(userId: string, serverId: string, body: RescaleInput): Promise<RescaleView> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:manage");
    if (server.isLocal) throw new ConflictException({ statusCode: 409, message: "this is the machine the hub runs on; rescale it from the provider console", code: "rescale_local_hub" });
    if (body.confirmName !== server.name) throw new BadRequestException({ statusCode: 400, message: "confirmation name does not match the server name", code: "oob_confirm_mismatch" });
    const link = await this.link(server);
    const providerName = server.provider as string;
    let current;
    let target;
    try {
      current = await link.plans.getServerPlan(link.token, link.providerServerId);
      const catalog = await link.plans.listPlanCatalog(link.token);
      target = catalog.find((p) => p.slug === body.planSlug);
    } catch (e) {
      throw oobHttpError(providerName, e);
    }
    const unavailable = (message: string, code: string) => new HttpException({ statusCode: 422, message, code }, 422);
    if (!target || target.deprecated || current.location === null || target.monthlyCentsByLocation[current.location] === undefined) {
      throw unavailable("that size is not available for this server's location", "rescale_plan_unavailable");
    }
    if (target.slug === current.plan.slug) throw unavailable("the server already has this size", "rescale_same_plan");
    if (target.architecture !== current.plan.architecture) throw unavailable("a server cannot move between processor architectures", "rescale_arch_mismatch");
    if (!body.upgradeDisk && target.diskGb < current.plan.diskGb) throw unavailable("disks do not shrink: pick a size with at least the current disk", "rescale_disk_shrink");
    if (await this.prisma.serverRescale.findFirst({ where: { serverId, phase: { notIn: TERMINAL } }, select: { id: true } })) {
      throw new ConflictException({ statusCode: 409, message: "a rescale is already running for this server", code: "rescale_active" });
    }
    let row: ServerRescale;
    try {
      row = await this.prisma.serverRescale.create({
        data: { serverId, requestedBy: userId, provider: providerName, fromPlan: current.plan.slug, toPlan: target.slug, upgradeDisk: body.upgradeDisk === true },
      });
    } catch {
      throw new ConflictException({ statusCode: 409, message: "a rescale is already running for this server", code: "rescale_active" });
    }
    await this.audit.log({
      actor: userId,
      action: "server.rescale.start",
      target: serverId,
      meta: { provider: providerName, providerServerId: link.providerServerId, from: current.plan.slug, to: target.slug, upgradeDisk: body.upgradeDisk === true },
    });
    try {
      const state = await link.oob.getServerState(link.token, link.providerServerId);
      if (state.status === "off") await this.setPhase(row.id, "RESIZING");
      else await link.oob.power(link.token, link.providerServerId, "shutdown");
    } catch (e) {
      const mapped = oobHttpError(providerName, e, true);
      await this.fail(row.id, userId, mapped.message);
      throw mapped;
    }
    this.schedule(row.id);
    const fresh = await this.prisma.serverRescale.findUnique({ where: { id: row.id } });
    return toRescaleView(fresh ?? row);
  }

  // ───────────────────────────── driver ─────────────────────────────

  private schedule(id: string, delay = TICK_MS): void {
    if (process.env.NODE_ENV === "test") return;
    const prev = this.timers.get(id);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => void this.tick(id), delay);
    t.unref?.();
    this.timers.set(id, t);
  }

  private async tick(id: string): Promise<void> {
    this.timers.delete(id);
    try {
      await this.advance(id);
    } catch (e) {
      this.logger.warn(`rescale ${id}: step failed (${e instanceof Error ? e.message : "error"})`);
    }
    const r = await this.prisma.serverRescale.findUnique({ where: { id }, select: { phase: true } }).catch(() => null);
    if (r && !TERMINAL.includes(r.phase)) this.schedule(id);
  }

  /** Do the next step of a rescale from the provider's own state. Safe to call repeatedly. */
  async advance(id: string): Promise<void> {
    const row = await this.prisma.serverRescale.findUnique({ where: { id } });
    if (!row || TERMINAL.includes(row.phase)) return;
    if (Date.now() - row.startedAt.getTime() > TOTAL_TIMEOUT_MS) return this.fail(id, row.requestedBy, "the rescale took too long; check the server at your provider");
    const server = await this.prisma.server.findUnique({ where: { id: row.serverId } });
    if (!server) return;
    let link: Link;
    try {
      link = await this.link(server);
    } catch (e) {
      return this.fail(id, row.requestedBy, e instanceof Error ? e.message : "the cloud link is gone");
    }
    try {
      if (row.phase === "SHUTTING_DOWN") {
        const state = await link.oob.getServerState(link.token, link.providerServerId);
        if (state.status !== "off") {
          if (Date.now() - row.updatedAt.getTime() > SHUTDOWN_TIMEOUT_MS) {
            return this.fail(id, row.requestedBy, "the server did not shut down in time; it was left as it is");
          }
          return;
        }
        await this.setPhase(id, "RESIZING");
        row.phase = "RESIZING";
      }
      if (row.phase === "RESIZING") {
        const [state, plan] = await Promise.all([link.oob.getServerState(link.token, link.providerServerId), link.plans.getServerPlan(link.token, link.providerServerId)]);
        if (state.locked) return; // the provider is still working on a step
        if (plan.plan.slug === row.toPlan) {
          await this.setPhase(id, "POWERING_ON");
          row.phase = "POWERING_ON";
        } else {
          try {
            await link.plans.changeType(link.token, link.providerServerId, row.toPlan, row.upgradeDisk);
          } catch (e) {
            // Put the server back on its feet before reporting: it was shut down for this.
            await link.oob.power(link.token, link.providerServerId, "power_on").catch(() => undefined);
            return this.fail(id, row.requestedBy, oobHttpError(row.provider, e, true).message);
          }
          return;
        }
      }
      if (row.phase === "POWERING_ON") {
        const state = await link.oob.getServerState(link.token, link.providerServerId);
        if (state.status === "running") return this.complete(row, link);
        if (state.status === "off" && !state.locked) {
          await link.oob.power(link.token, link.providerServerId, "power_on").catch((e) => {
            if ((e as { status?: number })?.status !== 423) throw e; // an action already running is fine
          });
        }
      }
    } catch (e) {
      // A provider hiccup is retried on the next tick; only a refused credential ends the move.
      const mapped = oobHttpError(row.provider, e, true);
      if (mapped.getStatus() === 424) return this.fail(id, row.requestedBy, mapped.message);
      this.logger.warn(`rescale ${id}: ${mapped.message}`);
    }
  }

  private async complete(row: ServerRescale, link: Link): Promise<void> {
    const plan = await link.plans.getServerPlan(link.token, link.providerServerId).catch(() => null);
    if (plan && plan.monthlyCents !== null) {
      const data = { monthlyCents: plan.monthlyCents, currency: plan.currency, source: "provider", provider: row.provider, planSlug: plan.plan.slug, location: plan.location, syncedAt: new Date() };
      await this.prisma.serverCost.upsert({ where: { serverId: row.serverId }, create: { serverId: row.serverId, ...data }, update: data });
    } else {
      // The old price no longer describes the server; the next sync or the estimate takes over.
      await this.prisma.serverCost.deleteMany({ where: { serverId: row.serverId } });
    }
    await this.prisma.serverRescale.update({ where: { id: row.id }, data: { phase: "DONE", finishedAt: new Date(), error: null } });
    await this.audit.log({ actor: row.requestedBy, action: "server.rescale.done", target: row.serverId, meta: { from: row.fromPlan, to: row.toPlan } }).catch(() => undefined);
  }

  private async setPhase(id: string, phase: string): Promise<void> {
    await this.prisma.serverRescale.update({ where: { id }, data: { phase } });
  }

  private async fail(id: string, actor: string, message: string): Promise<void> {
    const row = await this.prisma.serverRescale.update({ where: { id }, data: { phase: "FAILED", error: message.slice(0, 300), finishedAt: new Date() } }).catch(() => null);
    if (row) await this.audit.log({ actor, action: "server.rescale.failed", target: row.serverId, meta: { from: row.fromPlan, to: row.toPlan } }).catch(() => undefined);
  }

  /** The provider link of a server: clients and the decrypted token (held only for the call). */
  private async link(server: Server): Promise<Link> {
    if (!server.provider || !server.providerServerId || !server.cloudCredentialId) {
      throw new ConflictException({ statusCode: 409, message: "this server is not linked to a cloud server", code: "oob_not_linked" });
    }
    const plans = this.providers.getPlans(server.provider);
    const oob = this.providers.getOob(server.provider);
    if (!plans || !oob) throw new BadRequestException(`one-click rescale is not available for ${server.provider} yet`);
    const cred = await this.prisma.cloudCredential.findUnique({ where: { id: server.cloudCredentialId } });
    if (!cred || cred.teamId !== server.teamId) {
      throw new ConflictException({ statusCode: 409, message: "the cloud credential of this server was deleted; link the server again", code: "oob_credential_missing" });
    }
    return { server, oob, plans, token: this.crypto.decrypt(cred.apiTokenEnc), providerServerId: server.providerServerId };
  }
}
