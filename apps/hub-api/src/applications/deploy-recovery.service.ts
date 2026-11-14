import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Deployment } from "@prisma/client";
import { AGENT_FEATURE_CMD_JOURNAL } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentDisconnectedException } from "../agent-gateway/agent-offline.exception";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { ApplicationsService } from "./applications.service";
import { DeployLeaseService } from "./deploy-lease.service";

const TICK_MS = 15_000;
/** Rows whose deadline passed before any agent answered are settled regardless of agent state. */
const MIN_ADOPT_WINDOW_MS = 10_000;

/**
 * "Lose the hub without losing the deploy": adopts RUNNING deploys whose durable main command was dispatched by a
 * hub process that is gone (a restart) or whose socket dropped mid-command (lease released), by asking the agent's
 * command journal what happened to the EXACT command (reqId) and settling the row the way the live path would
 * have — never re-sending anything, so a double-apply is impossible.
 *
 * Who is adoptable: status RUNNING, phase DISPATCHED or RECOVERING, agentReqId set, ownerId ≠ our bootId (a dead
 * process's id, or NULL = released). Gates: the agent is online AND advertises cmd_journal_v1. The claim is a CAS
 * (ownerId ← us), so the reconnect hook, the lease-released hook and the ticker can all race harmlessly.
 *
 * Outcomes: done → finalizeAdopted (SUCCESS / FAILED / AUTO_ROLLBACK / CANCELLED, app status, notifications,
 * prune, drain); running → stream + await the live result until deadlineAt; interrupted / unknown / no reply /
 * deadline → settleInterrupted (the legacy FAILED -1 shape, Application.status untouched). A second drop while
 * waiting releases the lease again (RECOVERING) for the next reconnect.
 *
 * Rows WITHOUT a journaled command (pre-dispatch, build-server/render phase, swarm, rollback, old agent) are not
 * ours: DeploymentReconcileService reaps them at boot exactly as before.
 */
@Injectable()
export class DeployRecoveryService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeployRecoveryService.name);
  private timer?: ReturnType<typeof setInterval>;
  /** In-process: rows an adoption is currently awaiting (the CAS claim is the cross-process guard). */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
    private readonly lease: DeployLeaseService,
    private readonly deployLogs: DeployLogHub,
  ) {}

  onModuleInit(): void {
    this.apps.setLeaseReleasedHook((serverId) => void this.adoptForServer(serverId).catch(() => undefined));
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Adopt every recoverable deploy that was dispatched to this server (its agent just (re)connected). */
  async adoptForServer(serverId: string): Promise<void> {
    const rows = await this.prisma.deployment.findMany({ where: { ...this.recoverableWhere(), agentServerId: serverId } });
    // Concurrent: one adoption may wait minutes for a live command_result; the others (and the caller) must not.
    await Promise.allSettled(rows.map((row) => this.adoptOne(row)));
  }

  /**
   * Ticker: adopt what can be adopted (agent online), and settle a row past its deadline ONLY when its agent is not
   * there to ask — the journal keeps results for days, so an online agent is always asked first (a hub outage longer
   * than the deadline must not turn a real SUCCESS into "interrupted").
   */
  async sweep(): Promise<void> {
    const rows = await this.prisma.deployment.findMany({ where: this.recoverableWhere() });
    const now = Date.now();
    await Promise.allSettled(
      rows.map(async (row) => {
        const askable = !!row.agentServerId && this.agentWs.isOnline(row.agentServerId) && this.agentWs.agentSupports(row.agentServerId, AGENT_FEATURE_CMD_JOURNAL);
        if (askable) return this.adoptOne(row);
        if (row.deadlineAt && row.deadlineAt.getTime() <= now) {
          await this.apps.settleInterrupted(row, "the recovery deadline passed before the agent reconnected to report the outcome");
        }
      }),
    );
  }

  private recoverableWhere() {
    return {
      status: "RUNNING" as const,
      phase: { in: ["DISPATCHED", "RECOVERING"] },
      agentReqId: { not: null },
      OR: [{ ownerId: null }, { ownerId: { not: this.lease.bootId } }],
    };
  }

  /** Adopt one row: CAS-claim it, ask the agent, settle. Safe to call concurrently / repeatedly. */
  async adoptOne(row: Deployment): Promise<void> {
    if (!row.agentReqId || !row.agentServerId || this.inFlight.has(row.id)) return;
    // No deadline pre-check: past the deadline the command is long finished, so the (floored) status query answers
    // from the journal at once — the real outcome beats a guess. The sweep settles rows whose agent never returns.
    if (!this.agentWs.isOnline(row.agentServerId)) return;
    if (!this.agentWs.agentSupports(row.agentServerId, AGENT_FEATURE_CMD_JOURNAL)) {
      // The agent came back WITHOUT a journal (downgraded / replaced): nothing can be asked → the honest shape.
      await this.apps.settleInterrupted(row, "the agent that reconnected does not keep a command journal");
      return;
    }
    const { count } = await this.prisma.deployment.updateMany({
      where: { id: row.id, status: "RUNNING", phase: { in: ["DISPATCHED", "RECOVERING"] }, ownerId: row.ownerId },
      data: { ownerId: this.lease.bootId, phase: "DISPATCHED", heartbeatAt: new Date() },
    });
    if (count !== 1) return; // someone else (another adopter, a cancel, a settle) got there first
    this.inFlight.add(row.id);
    try {
      const remaining = Math.max(MIN_ADOPT_WINDOW_MS, (row.deadlineAt?.getTime() ?? Date.now() + MIN_ADOPT_WINDOW_MS) - Date.now());
      this.deployLogs.begin(row.appId);
      this.deployLogs.push(row.appId, "TUGRA: re-adopting this deploy from the agent's command journal\n");
      const adopted = await this.agentWs.adoptCommand(row.agentServerId, row.agentReqId, (chunk) => this.deployLogs.push(row.appId, chunk), remaining);
      const fresh = (await this.prisma.deployment.findUnique({ where: { id: row.id } })) ?? row;
      switch (adopted.kind) {
        case "result":
          this.logger.log(`deploy ${row.id}: adopted from agent ${row.agentServerId} (exit ${adopted.exitCode}${adopted.killed ? ", killed" : ""})`);
          await this.apps.finalizeAdopted(fresh, adopted);
          return;
        case "interrupted":
          if (adopted.output) this.deployLogs.push(row.appId, adopted.output);
          await this.apps.settleInterrupted(fresh, "the agent restarted while the deploy command was running");
          return;
        case "unknown":
          await this.apps.settleInterrupted(fresh, "the agent has no record of this deploy command");
          return;
        case "no_reply":
          await this.apps.settleInterrupted(fresh, "the agent did not report the outcome before the recovery deadline");
          return;
      }
    } catch (e) {
      // The agent dropped again (or the query failed): give the lease back for the next reconnect; the ticker
      // settles it past the deadline. Never a FAILED write here — the command may still be running.
      const why = e instanceof AgentDisconnectedException ? "agent disconnected again" : e instanceof Error ? e.message : String(e);
      this.logger.warn(`deploy ${row.id}: adoption paused (${why}); lease released`);
      await this.prisma.deployment
        .updateMany({ where: { id: row.id, status: "RUNNING", ownerId: this.lease.bootId }, data: { ownerId: null, phase: "RECOVERING" } })
        .catch(() => undefined);
    } finally {
      this.inFlight.delete(row.id);
    }
  }
}
