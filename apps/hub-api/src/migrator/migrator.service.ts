import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService, type AppView } from "../applications/applications.service";
import {
  buildDiscoverScript,
  buildInspectOneScript,
  buildRenameScript,
  buildUnadoptScript,
  parseDiscovered,
  NO_DOCKER_MARKER,
  type DiscoveredContainer,
  type DiscoveredEnv,
} from "./discover-script";
import type { AdoptInput } from "./dto";

const DISCOVER_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 15_000;
const RENAME_TIMEOUT_MS = 15_000;

export type AdoptableContainer = DiscoveredContainer & { adoptable: boolean };

/**
 * Migrator: scan an enrolled server for foreign (non-Tugra) Docker containers and adopt one as a
 * Tugra-managed app. Adoption creates the app record WITHOUT deploying, then `docker rename`s the
 * running container to Tugra's `tugra_<appId>` convention so every existing lifecycle path works
 * unchanged. Reuses the "deploy" capability (already default-granted, already used by listContainers).
 */
@Injectable()
export class MigratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
  ) {}

  /** Read-only scan: foreign containers on the host, each flagged whether it can be adopted. */
  async discover(userId: string, serverId: string): Promise<{ containers: AdoptableContainer[] }> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildDiscoverScript(), "deploy", DISCOVER_TIMEOUT_MS);
    if (r.output.includes(NO_DOCKER_MARKER)) {
      throw new ServiceUnavailableException("Docker is not available on this server");
    }
    const containers = parseDiscovered(r.output)
      .filter((c) => !c.isTugra) // never offer Tugra's own app/infra containers
      .map((c) => ({
        ...c,
        // The client only needs env KEYS (to choose what to import); adopt() re-reads the values
        // fresh server-side. Don't ship potentially-secret env values over the wire.
        env: c.env.map((e) => ({ key: e.key, value: "" })),
        adoptable: c.composeProject === null, // compose-managed = not adoptable (v1)
      }));
    return { containers };
  }

  /** Adopt one foreign container as a Tugra app: create record → rename → set status. */
  async adopt(userId: string, serverId: string, dto: AdoptInput): Promise<AppView> {
    await this.requireWrite(userId, serverId);

    // Re-inspect the target FRESH on the agent — never trust a client-cached discover() snapshot for
    // the fields that gate safety (identity / Tugra-ownership / compose membership). Closes TOCTOU.
    const inspect = await this.agentWs.sendCommand(
      serverId,
      buildInspectOneScript(dto.container),
      "deploy",
      INSPECT_TIMEOUT_MS,
    );
    const found = parseDiscovered(inspect.output)[0];
    if (!found) throw new NotFoundException("container not found");
    if (found.isTugra) throw new BadRequestException("this container is already managed by Tugra");
    if (found.composeProject) throw new BadRequestException("compose-managed containers can't be adopted yet");
    if (!found.image) throw new BadRequestException("could not determine the container's image");

    // An explicit port choice must actually exist on the freshly-inspected container — otherwise we'd
    // silently fall back to containerPort 80 and drop the real port (breaks a later redeploy's -p).
    if (dto.portIndex != null && dto.portIndex >= found.ports.length) {
      throw new BadRequestException("the selected port is not available on this container");
    }
    const chosen = found.ports[dto.portIndex ?? 0] ?? null;
    // Insert the app row only (deploy:false → no docker); exposeMode:none is mandatory (else create()
    // silently mints a magic sslip.io domain). All image/port/env values come from the fresh inspect.
    const app = await this.apps.create(userId, {
      name: dto.name,
      serverId,
      environmentId: dto.environmentId,
      source: "IMAGE",
      image: found.image,
      hostPort: chosen?.host ?? undefined, // undefined (Zod optional), never null
      containerPort: chosen?.container ?? 80,
      env: pickEnv(found.env, dto.envKeys),
      exposeMode: "none",
      deploy: false,
      tags: ["adopted"],
    });

    // Take ownership of the running container by renaming it to Tugra's convention. ANY failure — a
    // non-zero exit OR sendCommand rejecting (agent offline / timeout / capability) — must undo the
    // just-created record so no orphaned "adopted" app lingers; the foreign container is left as-is.
    let rename: { exitCode: number };
    try {
      rename = await this.agentWs.sendCommand(serverId, buildRenameScript(dto.container, `tugra_${app.id}`), "deploy", RENAME_TIMEOUT_MS);
    } catch {
      await this.apps.discardUndeployed(app.id);
      throw new ServiceUnavailableException("could not adopt the container (agent unavailable)");
    }
    if (rename.exitCode !== 0) {
      await this.apps.discardUndeployed(app.id);
      throw new ServiceUnavailableException("could not adopt the container (rename failed)");
    }

    await this.prisma.application.update({
      where: { id: app.id },
      data: { status: found.state === "running" ? "RUNNING" : "STOPPED" },
    });
    // Audit carries the ORIGINAL container name for traceability — never any imported env value.
    await this.audit.log({ actor: userId, action: "app.adopt", target: app.id, meta: { serverId, fromContainer: dto.container } });
    return this.apps.get(userId, app.id);
  }

  /**
   * Undo an adoption (importer rollback): rename the Tugra-managed container back to its original name, then
   * drop the app record. The rename runs via {@link buildUnadoptScript}, which succeeds (exit 0) both when it
   * renames and when the container is already gone. Only THEN is the record removed. A genuine failure — a
   * non-zero exit (e.g. the original name is taken) or a rejection (agent offline/timeout) — throws WITHOUT
   * deleting the record, so the caller records the failure and the task stays retryable (never a false
   * "rolled back" that orphans a live tugra_<appId> container).
   */
  async unadopt(userId: string, serverId: string, appId: string, originalName: string): Promise<void> {
    await this.requireWrite(userId, serverId);
    let r: { exitCode: number };
    try {
      r = await this.agentWs.sendCommand(serverId, buildUnadoptScript(`tugra_${appId}`, originalName), "deploy", RENAME_TIMEOUT_MS);
    } catch {
      throw new ServiceUnavailableException("could not roll back the adoption (agent unavailable)");
    }
    if (r.exitCode !== 0) {
      throw new ServiceUnavailableException("could not roll back the adoption (rename failed — the original name may be taken)");
    }
    await this.apps.discardUndeployed(appId);
    await this.audit.log({ actor: userId, action: "app.unadopt", target: appId, meta: { serverId, toContainer: originalName } });
  }

  private async requireWrite(userId: string, serverId: string): Promise<{ teamId: string }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    return server;
  }
}

/** DiscoveredEnv[] → Record, keeping only `keys` when given (else all). */
function pickEnv(env: DiscoveredEnv[], keys?: string[]): Record<string, string> {
  const allow = keys ? new Set(keys) : null;
  const out: Record<string, string> = {};
  for (const e of env) {
    if (allow && !allow.has(e.key)) continue;
    out[e.key] = e.value;
  }
  return out;
}
