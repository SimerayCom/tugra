import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Observable } from "rxjs";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { LogStreamService, type LogStreamEvent } from "../agent-gateway/log-stream.service";
import { ContainerMetricsService } from "../metrics/container-metrics.service";
import { clampTail, normalizeSince, normalizeSearch } from "../common/log-filters";

// A plain docker container name. The target is also matched against the server's live inventory before
// use, so this is defence in depth against a name that would reach the shell-less docker/grep argv.
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type ContainerAction = "restart" | "stop" | "remove";
// `remove` force-removes (stop + rm) since the UI only exposes it for foreign, non-managed containers.
const DOCKER_CMD: Record<ContainerAction, string> = { restart: "restart", stop: "stop", remove: "rm -f" };

/**
 * View the logs of ANY container on a managed host (not just a Tugra app/db), from the server's
 * Containers tab. Writer-level (servers:ops) because container logs can carry secrets, and the target
 * container is validated against the server's live inventory so only a container actually running on
 * that host can be targeted — never an arbitrary name. Reuses the signed `logs` capability + the same
 * log pipeline the app/database viewers use.
 */
@Injectable()
export class ContainerOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly logStream: LogStreamService,
    private readonly containerMetrics: ContainerMetricsService,
  ) {}

  /** Pre-flight access check (writer + agent online + the container really is on this host). Run from
   *  a guard so `@Sse` returns a real 403/400/503 instead of a committed 200 stream. */
  async assertLogAccess(userId: string, serverId: string, container: string): Promise<void> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    if (!this.agentWs.isOnline(serverId)) throw new ServiceUnavailableException("agent offline");
    await this.assertKnownContainer(serverId, container);
  }

  private async assertKnownContainer(serverId: string, container: string): Promise<void> {
    if (!CONTAINER_RE.test(container ?? "")) throw new BadRequestException("invalid container name");
    const inv = await this.containerMetrics.forServer(serverId);
    if (!inv.containers.some((c) => c.name === container)) {
      throw new BadRequestException("unknown container on this server");
    }
  }

  async streamLogs(
    userId: string,
    serverId: string,
    container: string,
    opts: { tail?: number; follow?: boolean; since?: string; search?: string },
  ): Promise<Observable<LogStreamEvent>> {
    await this.assertLogAccess(userId, serverId, container);
    await this.audit.log({ actor: userId, action: "server.container.logs.stream", target: serverId, meta: { container } });
    return this.logStream.stream(serverId, container, {
      tail: clampTail(opts.tail),
      follow: opts.follow ?? true,
      since: normalizeSince(opts.since),
      search: normalizeSearch(opts.search),
    });
  }

  async downloadLogs(
    userId: string,
    serverId: string,
    container: string,
    opts: { tail?: number; since?: string },
  ): Promise<string> {
    await this.assertLogAccess(userId, serverId, container);
    const tail = clampTail(opts.tail, 10000);
    const since = normalizeSince(opts.since);
    // Fixed argv; container is inventory-validated + charset-checked, since is normalized.
    const cmd = `docker logs --timestamps --tail ${tail}${since ? ` --since ${since}` : ""} ${container} 2>&1`;
    const r = await this.agentWs.sendCommand(serverId, cmd, "logs", 60_000);
    await this.audit.log({ actor: userId, action: "server.container.logs.download", target: serverId, meta: { container } });
    return r.output.slice(0, 5_000_000);
  }

  /**
   * Lifecycle action on a container (restart / stop / remove). Writer-level (servers:ops), and the
   * container is validated against the live inventory. Strong guards: Tugra's OWN control-plane stack
   * (hub / web / agent / postgres / redis / updater) can never be touched here; `remove` is allowed
   * ONLY on a foreign (non-Tugra-managed) container and ONLY with a matching name confirmation — a
   * managed app/database must be removed through its own delete so records + volumes are cleaned up.
   */
  async action(userId: string, serverId: string, container: string, action: ContainerAction, confirmName?: string): Promise<void> {
    if (!CONTAINER_RE.test(container ?? "")) throw new BadRequestException("invalid container name");
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    if (!this.agentWs.isOnline(serverId)) throw new ServiceUnavailableException("agent offline");
    const inv = await this.containerMetrics.forServer(serverId);
    const row = inv.containers.find((c) => c.name === container);
    if (!row) throw new BadRequestException("unknown container on this server");
    if (row.kind === "system") throw new BadRequestException("Tugra's own containers can't be managed here");
    if (action === "remove") {
      if (row.kind !== "other") throw new BadRequestException("delete the app or database instead to remove its container");
      if (confirmName !== container) throw new BadRequestException("confirmation name does not match");
    }
    // Verify the docker command actually succeeded. sendCommand resolves even on a non-zero exit (it rejects
    // only on offline/timeout), and the container was just inventory-validated, so exitCode != 0 is a genuine
    // failure — don't audit success or let the UI toast claim it worked.
    const r = await this.agentWs.sendCommand(serverId, `docker ${DOCKER_CMD[action]} ${container}`, "bulk", 60_000);
    if (r.exitCode !== 0) throw new ServiceUnavailableException(`docker ${action} failed (exit ${r.exitCode})`);
    await this.audit.log({ actor: userId, action: `server.container.${action}`, target: serverId, meta: { container } });
  }
}
