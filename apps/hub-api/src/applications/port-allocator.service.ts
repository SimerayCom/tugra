import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { PrismaService } from "../prisma/prisma.service";

/** One published port of an app's service, allocated at install time. */
export interface PortMapping {
  serviceName: string;
  containerPort: number;
  hostPort: number;
  mode: string;
}

// A fixed, input-free probe: list listening TCP sockets and docker-published ports. Both halves
// tolerate their tool being absent (`2>/dev/null`). No value is interpolated, so it is injection-proof.
const PROBE_CMD = "ss -ltnH 2>/dev/null; docker ps --format '{{.Ports}}' 2>/dev/null";
const PROBE_TIMEOUT_MS = 10_000;

/** Extract host ports in use from the combined `ss -ltnH` + `docker ps --format '{{.Ports}}'` output.
 *  Grabs each docker `:PORT->` published mapping and each `ss` local-address `:PORT` at a token end.
 *  Malformed lines are skipped; out-of-range ports are harmless (allocate only draws from its range). */
export function parseProbe(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    for (const m of line.matchAll(/:(\d{1,5})->/g)) ports.add(Number(m[1])); // docker published host port
    for (const tok of line.split(/\s+/)) {
      const mm = tok.match(/:(\d{1,5})$/); // ss local address ...:PORT
      if (mm) ports.add(Number(mm[1]));
    }
  }
  return ports;
}

/**
 * Allocates free host ports for install-time port publishing so two installs of the same template
 * never collide on a host port. Draws from [TUGRA_HOSTPORT_MIN, TUGRA_HOSTPORT_MAX], skipping ports
 * already used by any app (hostPort + portMappings) or database on the server, and — when the agent
 * is online — ports actually listening on the host (catches non-Tugra services). Allocation runs
 * under a per-server Postgres advisory lock so concurrent allocations serialize; when composed into a
 * caller's create transaction the lock is held until commit, making allocate+persist
 * atomic and truly race-safe. Nothing consumes it yet.
 */
@Injectable()
export class PortAllocatorService {
  private readonly logger = new Logger(PortAllocatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly config: ConfigService,
  ) {}

  async allocate(
    serverId: string,
    count: number,
    tx?: Prisma.TransactionClient,
    probed?: Set<number>,
  ): Promise<number[]> {
    // The probe is a network round-trip and MUST NOT run inside a transaction (it would hold the
    // pooled connection idle-in-transaction and can outlast Prisma's default 5s tx timeout). Standalone
    // (no tx): probe here, before our own tx opens. Composed into a caller's tx: the caller pre-probes
    // OUTSIDE its transaction and passes `probed` in; we never probe inside their open transaction.
    const seen = probed ?? (tx ? new Set<number>() : await this.probeUsedPorts(serverId));

    const run = async (client: Prisma.TransactionClient): Promise<number[]> => {
      // Serialize concurrent allocations for this server; xact-scoped → released on commit/rollback.
      await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${serverId}))`;
      const used = await this.gatherUsed(client, serverId);
      for (const p of seen) used.add(p);
      return this.pickFree(used, count);
    };

    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /** Best-effort probe of listening host ports; empty when the agent is offline or the probe fails.
   *  Public so a tx-composing caller (e.g. template install) can run it OUTSIDE its transaction and
   *  pass the result into allocate(). */
  async probeUsedPorts(serverId: string): Promise<Set<number>> {
    if (!this.agentWs.isOnline(serverId)) return new Set();
    try {
      const { output } = await this.agentWs.sendCommand(serverId, PROBE_CMD, "deploy", PROBE_TIMEOUT_MS);
      return parseProbe(output);
    } catch (e) {
      this.logger.warn(`port probe failed for ${serverId}: ${e instanceof Error ? e.message : e}`);
      return new Set(); // DB-only reservation
    }
  }

  /** Host ports already reserved by apps (hostPort + portMappings) and databases on this server. */
  private async gatherUsed(client: Prisma.TransactionClient, serverId: string): Promise<Set<number>> {
    const used = new Set<number>();
    const apps = await client.application.findMany({ where: { serverId }, select: { hostPort: true, portMappings: true } });
    for (const a of apps) {
      if (typeof a.hostPort === "number") used.add(a.hostPort);
      if (Array.isArray(a.portMappings)) {
        for (const m of a.portMappings as unknown as PortMapping[]) {
          if (m && typeof m.hostPort === "number") used.add(m.hostPort);
        }
      }
    }
    const dbs = await client.database.findMany({ where: { serverId }, select: { hostPort: true } });
    for (const d of dbs) if (typeof d.hostPort === "number") used.add(d.hostPort);
    return used;
  }

  /** Pick the first `count` free ports in the configured range, or throw when the range is exhausted. */
  private pickFree(used: Set<number>, count: number): number[] {
    const min = Number(this.config.get("TUGRA_HOSTPORT_MIN") ?? 20000);
    const max = Number(this.config.get("TUGRA_HOSTPORT_MAX") ?? 45000);
    const free: number[] = [];
    for (let p = min; p <= max && free.length < count; p++) {
      if (!used.has(p)) free.push(p);
    }
    if (free.length < count) {
      throw new ServiceUnavailableException(`no free host ports available in ${min}-${max}`);
    }
    return free;
  }
}
