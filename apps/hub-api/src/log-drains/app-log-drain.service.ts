import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Application, type LogDrain } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { CryptoService } from "../crypto/crypto.service";
import type { CreateAppLogDrainInput, UpdateAppLogDrainInput } from "../server-ops/dto";
import type { LogDrainView } from "../server-ops/log-drain.service";
import { LogDrainPushService } from "./log-drain-push.service";
import { validateContainers, validateDrainShape } from "./log-drain-shape";

/** At most this many drains on one app, and this many app drains anchored on one server (counted at create only). */
export const MAX_DRAINS_PER_APP = 10;
export const MAX_APP_DRAINS_PER_SERVER = 32;

type AppRow = Pick<Application, "id" | "teamId" | "serverId" | "clusterId" | "source">;

/**
 * Per-app log drains. Routes require `apps:config` on the app's team (writer-only, secrets-adjacent). Anything
 * that widens host egress — `allowPrivate: true`, or editing the destination of a drain that already has it —
 * additionally requires `servers:ops` on the team that owns the app's SERVER, so an app writer alone can never
 * point host egress at a LAN/loopback address.
 */
@Injectable()
export class AppLogDrainService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly push: LogDrainPushService,
  ) {}

  async list(userId: string, appId: string): Promise<LogDrainView[]> {
    const app = await this.requireApp(userId, appId);
    const rows = await this.prisma.logDrain.findMany({ where: { appId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    const targets = await this.push.targetServerIds(app);
    return rows.map((d) => this.view(d, targets));
  }

  async create(userId: string, appId: string, dto: CreateAppLogDrainInput): Promise<LogDrainView> {
    const app = await this.requireApp(userId, appId);
    const allowPrivate = dto.allowPrivate === true;
    if (allowPrivate) await this.requireServerOps(userId, app.serverId);

    const perApp = await this.prisma.logDrain.count({ where: { appId } });
    if (perApp >= MAX_DRAINS_PER_APP) throw new BadRequestException(`an app can have at most ${MAX_DRAINS_PER_APP} log drains`);
    const perServer = await this.prisma.logDrain.count({ where: { serverId: app.serverId, appId: { not: null } } });
    if (perServer >= MAX_APP_DRAINS_PER_SERVER) throw new BadRequestException(`a server can carry at most ${MAX_APP_DRAINS_PER_SERVER} app log drains`);

    const { options } = validateDrainShape({
      type: dto.type,
      endpoint: dto.endpoint,
      options: dto.options,
      scope: "app",
      allowPrivate,
      hasToken: !!dto.token,
    });
    const containers = validateContainers("app", dto.containers ?? [], app);
    const d = await this.prisma.logDrain.create({
      data: {
        serverId: app.serverId,
        appId,
        name: dto.name,
        type: dto.type,
        endpoint: dto.endpoint,
        authTokenEnc: dto.token ? this.crypto.encrypt(dto.token) : null,
        enabled: dto.enabled ?? true,
        containers,
        allowPrivate,
        ...(options ? { options: options as Prisma.InputJsonValue } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "app.logdrain.create", target: appId, meta: { drainId: d.id, type: d.type } });
    await this.push.pushForApp(app).catch(() => undefined);
    return this.view(d, await this.push.targetServerIds(app));
  }

  async update(userId: string, appId: string, drainId: string, dto: UpdateAppLogDrainInput): Promise<LogDrainView> {
    const app = await this.requireApp(userId, appId);
    const existing = await this.requireDrain(appId, drainId);

    const touchesDestination =
      dto.type !== undefined || dto.endpoint !== undefined || dto.options !== undefined || dto.token !== undefined || dto.containers !== undefined;
    if (dto.allowPrivate === true || (existing.allowPrivate && touchesDestination)) {
      await this.requireServerOps(userId, app.serverId);
    }

    const allowPrivateAfter = dto.allowPrivate ?? existing.allowPrivate;
    const data: Prisma.LogDrainUncheckedUpdateInput = {
      name: dto.name ?? undefined,
      type: dto.type ?? undefined,
      endpoint: dto.endpoint ?? undefined,
      enabled: dto.enabled ?? undefined,
      ...(dto.allowPrivate !== undefined ? { allowPrivate: dto.allowPrivate } : {}),
      ...(dto.token !== undefined ? { authTokenEnc: dto.token ? this.crypto.encrypt(dto.token) : null } : {}),
    };

    const mergedType = dto.type ?? existing.type;
    if (dto.token && (mergedType === "syslog" || mergedType === "gelf")) {
      throw new BadRequestException(`${mergedType} has no authentication: remove the token`);
    }
    // Validate only what is being written. Dropping allowPrivate re-checks the stored destination too, so a
    // private address can never stay behind a drain that no longer carries the flag.
    const touchesShape =
      dto.type !== undefined || dto.endpoint !== undefined || dto.options !== undefined || (dto.allowPrivate === false && existing.allowPrivate);
    if (touchesShape) {
      const typeChanged = dto.type !== undefined && dto.type !== existing.type;
      const isNet = (t: string) => t === "syslog" || t === "gelf" || t === "fluentd";
      const crossesNet = typeChanged && (isNet(dto.type as string) || isNet(existing.type));
      if (crossesNet) {
        if (dto.endpoint === undefined) throw new BadRequestException("changing the drain type needs the new endpoint in the same request");
        if (isNet(dto.type as string) && dto.options == null) throw new BadRequestException("changing to this drain type needs its options in the same request");
      }
      const options = dto.options !== undefined ? dto.options : crossesNet ? null : ((existing.options as Record<string, unknown> | null) ?? null);
      const hasTokenAfter = dto.token === undefined ? !!existing.authTokenEnc : !!dto.token;
      const shaped = validateDrainShape({
        type: mergedType,
        endpoint: dto.endpoint ?? existing.endpoint,
        options,
        scope: "app",
        allowPrivate: allowPrivateAfter,
        hasToken: hasTokenAfter,
      });
      data.options = shaped.options ? (shaped.options as Prisma.InputJsonValue) : Prisma.DbNull;
    }
    if (dto.containers !== undefined) data.containers = validateContainers("app", dto.containers, app);

    const d = await this.prisma.logDrain.update({ where: { id: drainId }, data });
    await this.audit.log({ actor: userId, action: "app.logdrain.update", target: appId, meta: { drainId, type: d.type } });
    await this.push.pushForApp(app).catch(() => undefined);
    return this.view(d, await this.push.targetServerIds(app));
  }

  async remove(userId: string, appId: string, drainId: string): Promise<void> {
    const app = await this.requireApp(userId, appId);
    const existing = await this.requireDrain(appId, drainId);
    await this.prisma.logDrain.delete({ where: { id: drainId } });
    await this.audit.log({ actor: userId, action: "app.logdrain.remove", target: appId, meta: { drainId, type: existing.type } });
    await this.push.pushForApp(app).catch(() => undefined);
  }

  /** Load the app (404) and require apps:config on its team. */
  private async requireApp(userId: string, appId: string): Promise<AppRow> {
    const app = await this.prisma.application.findUnique({
      where: { id: appId },
      select: { id: true, teamId: true, serverId: true, clusterId: true, source: true },
    });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, "apps:config");
    return app;
  }

  private async requireServerOps(userId: string, serverId: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
  }

  /** The drain must belong to THIS app: another app's (or a server-wide) drain id is a 404. */
  private async requireDrain(appId: string, drainId: string): Promise<LogDrain> {
    const d = await this.prisma.logDrain.findFirst({ where: { id: drainId, appId } });
    if (!d) throw new NotFoundException("log drain not found");
    return d;
  }

  private view(d: LogDrain, targets: string[]): LogDrainView {
    const { delivery, status } = this.push.deliveryFor(d, targets);
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      endpoint: d.endpoint,
      enabled: d.enabled,
      hasToken: !!d.authTokenEnc,
      createdAt: d.createdAt,
      scope: "app",
      appId: d.appId,
      containers: d.containers ?? [],
      options: (d.options as Record<string, unknown> | null) ?? null,
      allowPrivate: d.allowPrivate,
      delivery,
      status,
    };
  }
}
