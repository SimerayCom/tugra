import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { resolveContainerLabel } from "../metrics/container-metrics.service";
import {
  CONTAINER_HEALTH_SCRIPT,
  parseHealthOutput,
  diffContainerStates,
  type ContainerSnap,
  type PrevState,
  type NextState,
} from "./container-health";

const POLL_TIMEOUT_MS = 15_000;
const SEED_WINDOW_SEC = 120; // first tick: look back this far for the events cursor
const MAX_LOG_FETCH_PER_TICK = 8; // cap the extra `docker logs` pulls per server per tick (a mass-crash storm)
const LOG_TAIL_LINES = 80;
const LOG_TAIL_MAX_BYTES = 8192; // frozen pre-crash log snapshot kept on the ContainerEvent row
// A plain docker container name — defence in depth before a name reaches the logs command (names come from
// `docker inspect` output, so this only ever rejects something already impossible).
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * One container-health tick: for every ONLINE server with a reachable agent, run the read-only inspect+events
 * script over the "bulk" capability, diff against ContainerState, and fire crash/OOM on a TRANSITION only.
 * Each server is isolated (a failure warns + skips, never a false alert). Never throws.
 */
@Injectable()
export class ContainerHealthRunnerService {
  private readonly logger = new Logger(ContainerHealthRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
  ) {}

  async runTick(): Promise<void> {
    const servers = await this.prisma.server.findMany({ where: { status: "ONLINE" }, select: { id: true, name: true, teamId: true, hostname: true } });
    for (const server of servers) {
      try {
        if (!this.agentWs.isOnline(server.id)) continue;
        await this.checkServer(server);
      } catch (e) {
        this.logger.warn(`container-health check failed for server ${server.id}: ${String(e)}`);
      }
    }
  }

  private async checkServer(server: { id: string; name: string; teamId: string; hostname: string | null }): Promise<void> {
    const prevRows = await this.prisma.containerState.findMany({ where: { serverId: server.id } });
    const seed = prevRows.length === 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const cursor = seed ? nowSec - SEED_WINDOW_SEC : Math.max(nowSec - SEED_WINDOW_SEC, ...prevRows.map((r) => Number(r.lastEventTs)));

    const r = await this.agentWs.sendCommand(server.id, CONTAINER_HEALTH_SCRIPT(cursor), "bulk", POLL_TIMEOUT_MS);
    if (r.exitCode !== 0) {
      this.logger.warn(`container-health list failed on server ${server.id} (exit ${r.exitCode})`);
      return; // state untouched → no false transitions
    }
    const parsed = parseHealthOutput(r.output);
    if (parsed.truncated) this.logger.warn(`container-health output truncated on server ${server.id} (too many containers)`);

    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({ where: { serverId: server.id }, select: { id: true, name: true, status: true } }),
      this.prisma.database.findMany({ where: { serverId: server.id }, select: { id: true, name: true } }),
    ]);
    const appsById = new Map(apps.map((a) => [a.id, a.name]));
    const dbsById = new Map(dbs.map((d) => [d.id, d.name]));
    const stoppedAppIds = new Set(apps.filter((a) => a.status === "STOPPED").map((a) => a.id));
    const prevByName = new Map(prevRows.map((row) => [row.containerName, row]));
    const now = Date.now();
    let logFetches = 0;

    for (const snap of parsed.containers) {
      const prevRow = prevByName.get(snap.name);
      if (seed) {
        await this.persist(server.id, snap, this.seedState(snap, parsed.events));
        continue;
      }
      const prev: PrevState | undefined = prevRow
        ? {
            containerId: prevRow.containerId,
            restartCount: prevRow.restartCount,
            finishedAt: prevRow.finishedAt ? prevRow.finishedAt.toISOString() : null,
            lastEventTs: Number(prevRow.lastEventTs),
            lastNotifiedKey: prevRow.lastNotifiedKey,
            lastNotifiedAt: prevRow.lastNotifiedAt ? prevRow.lastNotifiedAt.getTime() : null,
            restartCountAtNotify: prevRow.restartCountAtNotify,
          }
        : undefined;
      const { fire, event, next } = diffContainerStates(prev, snap, parsed.events, { now });

      // Freeze the pre-crash log tail at the moment of a detected death — `docker logs` would otherwise lose
      // it on the next recreate. Bounded per tick so a mass crash can't turn one poll into a log storm.
      let logTail: string | null = null;
      if (event && logFetches < MAX_LOG_FETCH_PER_TICK) {
        logFetches++;
        logTail = await this.fetchLogTail(server.id, snap.name);
      }

      if (fire) {
        const label = resolveContainerLabel(snap.name, appsById, dbsById);
        // Don't alert on Tugra's own control-plane stack (noisy during self-update) or on an app the operator
        // deliberately stopped. A fired-but-suppressed death still persists `next` (so it isn't re-fired later).
        const suppressed = label.kind === "system" || (label.kind === "app" && !!label.resourceId && stoppedAppIds.has(label.resourceId));
        if (!suppressed) {
          await this.notifications
            .fireForEvent(server.teamId, fire.type, {
              serverId: server.id,
              serverName: server.name,
              hostname: server.hostname ?? "",
              containerName: snap.name,
              label: label.label,
              kind: label.kind,
              resourceId: label.resourceId ?? "",
              exitCode: fire.exitCode,
              restartDelta: fire.restartDelta,
              oomKilled: fire.oomKilled,
              // `reason` (exit-code meaning) is safe to send to external channels; the raw pre-crash log tail
              // is NOT — it can carry secrets — so it stays on the ContainerEvent row (in-app, access-controlled).
              reason: event ? event.reason : "",
            })
            .catch(() => undefined);
        }
      }
      await this.persist(server.id, snap, next);

      // Append the timeline row AFTER state is persisted, isolated per container: a bad row (or a byte Postgres
      // rejects) must never drop another container's episode or abort the tick.
      if (event) {
        try {
          await this.prisma.containerEvent.create({
            data: {
              serverId: server.id,
              containerName: snap.name,
              containerId: snap.id,
              ts: event.ts > 0 ? new Date(event.ts * 1000) : new Date(now),
              kind: event.kind,
              exitCode: event.exitCode,
              oomKilled: event.oomKilled,
              restartCount: event.restartCount,
              restartDelta: event.restartDelta,
              reason: event.reason,
              logTail,
            },
          });
        } catch (e) {
          this.logger.warn(`container-event write failed for ${snap.name} on server ${server.id}: ${String(e)}`);
        }
      }
    }

    // Drop rows for containers that no longer exist (removed/renamed) so the table stays bounded.
    const liveNames = parsed.containers.map((c) => c.name);
    await this.prisma.containerState.deleteMany({ where: { serverId: server.id, containerName: { notIn: liveNames.length ? liveNames : ["\u0000"] } } });
  }

  /** Grab the last log lines of a just-crashed container over the "logs" capability (same gate as the
   *  interactive log reader — an operator who revoked "logs" gets no captured tail). Best-effort: any failure
   *  (capability denied, container already gone, timeout) returns null so the tick never breaks. `pipefail`
   *  propagates a `docker logs` failure past the `tail` pipe; NULs are stripped (Postgres TEXT rejects 0x00). */
  private async fetchLogTail(serverId: string, container: string): Promise<string | null> {
    if (!CONTAINER_RE.test(container)) return null;
    try {
      const cmd = `set -o pipefail; docker logs --tail ${LOG_TAIL_LINES} --timestamps ${container} 2>&1 | tail -c ${LOG_TAIL_MAX_BYTES}`;
      const r = await this.agentWs.sendCommand(serverId, cmd, "logs", POLL_TIMEOUT_MS);
      if (r.exitCode !== 0) return null;
      const out = (r.output ?? "").replace(/\u0000/g, "").trim();
      return out ? out.slice(0, LOG_TAIL_MAX_BYTES) : null;
    } catch {
      return null;
    }
  }

  /** Baseline row for a container seen for the first time (seed tick) — records state, never alerts. */
  private seedState(snap: ContainerSnap, events: { name: string; ts: number }[]): NextState {
    const maxEventTs = events.filter((e) => e.name === snap.name).reduce((m, e) => Math.max(m, e.ts), 0);
    return {
      containerId: snap.id,
      status: snap.status,
      exitCode: snap.exitCode,
      oomKilled: snap.oomKilled,
      restartCount: snap.restartCount,
      startedAt: snap.startedAt,
      finishedAt: snap.finishedAt,
      health: snap.health,
      lastEventTs: maxEventTs,
      lastNotifiedKey: null,
      lastNotifiedAt: null,
      restartCountAtNotify: snap.restartCount,
    };
  }

  private async persist(serverId: string, snap: ContainerSnap, next: NextState): Promise<void> {
    const data = {
      containerId: next.containerId,
      status: next.status,
      exitCode: next.exitCode,
      oomKilled: next.oomKilled,
      restartCount: next.restartCount,
      startedAt: next.startedAt ? new Date(next.startedAt) : null,
      finishedAt: next.finishedAt ? new Date(next.finishedAt) : null,
      health: next.health,
      lastEventTs: BigInt(Math.max(0, Math.floor(next.lastEventTs))),
      lastNotifiedKey: next.lastNotifiedKey,
      lastNotifiedAt: next.lastNotifiedAt ? new Date(next.lastNotifiedAt) : null,
      restartCountAtNotify: next.restartCountAtNotify,
    };
    await this.prisma.containerState.upsert({
      where: { serverId_containerName: { serverId, containerName: snap.name } },
      create: { serverId, containerName: snap.name, ...data },
      update: data,
    });
  }
}
