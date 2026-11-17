import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, type ServerReboot } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentDisconnectedException, AgentCommandTimeoutException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { NotificationsService } from "../notifications/notifications.service";
import { ContainerMetricsService } from "../metrics/container-metrics.service";
import { parseHostExec, wrapHostExec } from "./patch-script";
import {
  buildBootIdScript,
  buildDomainProbeScript,
  buildRebootPreflightScript,
  buildRebootStartScript,
  buildRebootStateScript,
  parseDomainProbe,
  parseRebootHost,
  parseRebootStart,
  parseRebootState,
  REBOOT_DELAY_SEC,
  type RebootStateRead,
} from "./reboot-script";
import {
  ACTIVE_REBOOT_STATES,
  buildDomainTargets,
  checkRebootSchedule,
  evaluateVerification,
  failureReport,
  rebootTiming,
  snapshotContainers,
  type RebootFailureReason,
  type RebootReport,
  type RebootResult,
  type RebootSnapshot,
  type RebootState,
} from "./reboot-logic";
import { RebootQueueService } from "./reboot-queue.service";
import type { RebootRequestInput, RebootView } from "./dto";

const STATE_TIMEOUT_MS = 45_000;
const PROBE_TIMEOUT_MS = 90_000;
const HOST_TIMEOUT_MS = 60_000;
const HOST_EXEC = { deadlineSec: 40, killSec: 5 };

const SCHEDULE_MESSAGES = {
  invalid: "`at` must be a valid date-time",
  past: "a scheduled reboot must be at least a minute from now",
  too_far: "a scheduled reboot can be at most 7 days from now",
} as const;

const EVENT_FOR_RESULT: Partial<Record<RebootResult, string>> = {
  ok: "server_reboot_verified",
  degraded: "server_reboot_degraded",
  failed: "server_reboot_failed",
};

/** The agent went away AFTER a command may already have reached it (the outcome is unknown). */
function isAfterSendDrop(e: unknown): boolean {
  return e instanceof AgentDisconnectedException || e instanceof AgentCommandTimeoutException;
}

type StartOutcome =
  | { kind: "started" }
  | { kind: "skipped" }
  /** Could not start NOW but may later (a scheduled reboot keeps waiting): the cause. */
  | { kind: "blocked"; reason: Extract<RebootFailureReason, "busy_patch" | "busy_deploy" | "agent_offline"> }
  | { kind: "failed"; reason: RebootFailureReason; http: "conflict" | "unavailable" | "bad" };

/**
 * Server reboot: request, schedule, cancel, status, and the watcher that carries a reboot from "unit armed" through
 * "agent is back" to "verified". The row in ServerReboot is the whole state machine, so a hub restart (also the hub
 * that runs on the very server being rebooted) resumes where it left off; the BullMQ jobs are only triggers.
 *
 *   SCHEDULED -> STARTING -> REBOOTING -> WAITING_AGENT -> VERIFYING -> DONE(ok | degraded | failed)
 *                  (SCHEDULED/STARTING -> DONE(cancelled | failed))
 *
 * A reboot is never automatic: a row exists only because someone asked, with the server's name typed as confirmation.
 * Everything host-side reuses the patch lane's mechanism (the `patch` capability + the nsenter helper).
 */
@Injectable()
export class RebootService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RebootService.name);
  /** Rows being advanced right now in this process (a slow verification poll must not overlap the next tick). */
  private readonly inflight = new Set<string>();
  private lastTickAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly notifications: NotificationsService,
    private readonly queue: RebootQueueService,
    private readonly containerMetrics: ContainerMetricsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.queue.start({ tick: () => this.pacedTick(), due: (id) => this.advanceById(id) });
    await this.resyncScheduled().catch((e) => this.logger.warn(`could not re-queue scheduled reboots: ${String(e)}`));
  }

  // ───────────────────────────── API ─────────────────────────────

  /** The live reboot (if any) and the last finished one, for any member of the server's team. */
  async status(userId: string, serverId: string): Promise<{ active: RebootView | null; last: RebootView | null }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, teamId: true } });
    if (!server) throw new NotFoundException("server not found");
    if (!(await this.access.teamRole(userId, server.teamId))) throw new ForbiddenException("not a member of this team");
    const [active, last] = await Promise.all([
      this.prisma.serverReboot.findFirst({ where: { serverId, state: { not: "DONE" } }, orderBy: { createdAt: "desc" } }),
      this.prisma.serverReboot.findFirst({ where: { serverId, state: "DONE", result: { not: "cancelled" } }, orderBy: { createdAt: "desc" } }),
    ]);
    return { active: active ? toView(active) : null, last: last ? toView(last) : null };
  }

  /** What a reboot would take down, for the confirmation dialog. DB + the metrics inventory only: no agent traffic. */
  async preview(userId: string, serverId: string): Promise<{ containers: number; domains: number; hostsHub: boolean; agentOnline: boolean }> {
    const server = await this.requireServer(userId, serverId);
    const [inventory, apps] = await Promise.all([this.containerMetrics.forServer(serverId), this.routedApps(serverId)]);
    return { containers: inventory.containers.length, domains: buildDomainTargets(apps).length, hostsHub: server.isLocal, agentOnline: this.agentWs.isOnline(serverId) };
  }

  /**
   * Ask for a reboot now, or at a time. The typed confirmation must equal the server's name. An immediate reboot is
   * refused (409) while an OS update unit or a deploy runs on the server. The request is AUDITED BEFORE anything runs
   * (a reboot that takes the hub down with the host would otherwise leave no trace).
   */
  async request(userId: string, serverId: string, body: RebootRequestInput): Promise<RebootView> {
    const server = await this.requireServer(userId, serverId);
    if (body.confirmName !== server.name) throw new BadRequestException("confirmation name does not match the server name");
    const now = body.mode === "now";
    let at: Date | null = null;
    if (!now) {
      const c = checkRebootSchedule(body.at, Date.now());
      if (!c.ok) throw new BadRequestException(SCHEDULE_MESSAGES[c.reason]);
      at = c.at;
    }
    if (!this.agentWs.isOnline(serverId)) throw new AgentOfflineException();
    const existing = await this.prisma.serverReboot.findFirst({ where: { serverId, state: { not: "DONE" } } });
    if (existing) throw new ConflictException(existing.state === "SCHEDULED" ? "a reboot is already scheduled for this server — cancel it first" : "a reboot is already in progress on this server");
    if (now) await this.assertNoDeploy(serverId);
    // Read-only host look: is there systemd to hold a delayed reboot, and (for "now") is an OS update running.
    const host = await this.readHost(serverId);
    if (host.systemd === false) throw new BadRequestException("this server has no systemd, so Tugra cannot arm a delayed reboot on it — reboot it from a shell on the server");
    if (now && host.patchRunning) throw new ConflictException("an OS update is running on this server — wait for it to finish before rebooting");

    let row: ServerReboot;
    try {
      row = await this.prisma.serverReboot.create({ data: { serverId, requestedBy: userId, mode: body.mode, state: now ? "STARTING" : "SCHEDULED", scheduledAt: at } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ConflictException("a reboot is already scheduled or in progress for this server");
      throw e;
    }
    try {
      await this.audit.log({ actor: userId, action: now ? "server.reboot.request" : "server.reboot.schedule", target: serverId, meta: { rebootId: row.id, mode: body.mode, ...(at ? { at: at.toISOString() } : {}) } });
    } catch (e) {
      // Not audited -> not run.
      await this.prisma.serverReboot.delete({ where: { id: row.id } }).catch(() => undefined);
      throw e;
    }
    if (!now) {
      await this.queue.scheduleAt(row.id, at as Date).catch((e) => this.logger.warn(`could not queue reboot ${row.id}: ${String(e)} (the watcher will start it when due)`));
      return toView(row);
    }
    const outcome = await this.start(row, server);
    if (outcome.kind === "failed") {
      const msg = FAILURE_MESSAGES[outcome.reason];
      if (outcome.http === "conflict") throw new ConflictException(msg);
      if (outcome.http === "bad") throw new BadRequestException(msg);
      throw new ServiceUnavailableException(msg);
    }
    if (outcome.kind === "blocked") {
      // Raced with a deploy or update that started between the check and the unit: nothing was armed.
      await this.settle(row.id, "failed", failureReport(outcome.reason, null), { notify: false });
      throw outcome.reason === "agent_offline" ? new AgentOfflineException() : new ConflictException(FAILURE_MESSAGES[outcome.reason]);
    }
    const fresh = await this.prisma.serverReboot.findUnique({ where: { id: row.id } });
    return toView(fresh ?? row);
  }

  /** Cancel a reboot that has not started. Once its unit is armed there is no taking it back from here. */
  async cancel(userId: string, serverId: string): Promise<RebootView> {
    await this.requireServer(userId, serverId);
    const active = await this.prisma.serverReboot.findFirst({ where: { serverId, state: { not: "DONE" } } });
    if (!active) throw new NotFoundException("no reboot is scheduled for this server");
    if (active.state !== "SCHEDULED") throw new ConflictException("the reboot has already started and cannot be cancelled");
    const claimed = await this.prisma.serverReboot.updateMany({ where: { id: active.id, state: "SCHEDULED" }, data: { state: "DONE", result: "cancelled", verifiedAt: new Date() } });
    if (claimed.count === 0) throw new ConflictException("the reboot has already started and cannot be cancelled");
    await this.queue.unschedule(active.id).catch(() => undefined);
    await this.audit.log({ actor: userId, action: "server.reboot.cancel", target: serverId, meta: { rebootId: active.id } }).catch(() => undefined);
    const row = await this.prisma.serverReboot.findUnique({ where: { id: active.id } });
    return toView(row ?? { ...active, state: "DONE", result: "cancelled" });
  }

  // ───────────────────────────── watcher ─────────────────────────────

  /** The queue's tick: a slow pass must not be followed by a burst of queued ones, so one that arrives right after the
   *  previous pass started is skipped. */
  private async pacedTick(): Promise<void> {
    const t = Date.now();
    if (t - this.lastTickAt < rebootTiming.tickMs / 2) return;
    this.lastTickAt = t;
    await this.tick();
  }

  /** Re-queue every scheduled reboot's delayed job (after a hub restart the queue may have lost them). Idempotent. */
  async resyncScheduled(): Promise<number> {
    const rows = await this.prisma.serverReboot.findMany({ where: { state: "SCHEDULED" } });
    for (const r of rows) if (r.scheduledAt) await this.queue.scheduleAt(r.id, r.scheduledAt);
    return rows.length;
  }

  /** One watcher pass: advance every live reboot. The DB decides what is due, so this also starts a scheduled reboot
   *  whose delayed job was lost. */
  async tick(): Promise<void> {
    const rows = await this.prisma.serverReboot.findMany({ where: { state: { in: ACTIVE_REBOOT_STATES } }, orderBy: { createdAt: "asc" } });
    for (const row of rows) await this.advance(row);
  }

  async advanceById(id: string): Promise<void> {
    if (!id) return;
    const row = await this.prisma.serverReboot.findUnique({ where: { id } });
    if (row) await this.advance(row);
  }

  private async advance(row: ServerReboot): Promise<void> {
    if (this.inflight.has(row.id)) return;
    this.inflight.add(row.id);
    try {
      switch (row.state as RebootState) {
        case "SCHEDULED":
          await this.advanceScheduled(row);
          break;
        case "STARTING":
          await this.advanceStarting(row);
          break;
        case "REBOOTING":
        case "WAITING_AGENT":
          await this.advanceWaiting(row);
          break;
        case "VERIFYING":
          await this.advanceVerifying(row);
          break;
        default:
          break;
      }
    } catch (e) {
      this.logger.warn(`reboot ${row.id} (${row.state}): ${String(e)}`);
    } finally {
      this.inflight.delete(row.id);
    }
  }

  private async advanceScheduled(row: ServerReboot): Promise<void> {
    if (!row.scheduledAt || row.scheduledAt.getTime() > Date.now()) return;
    const outcome = await this.start(row);
    // A failure was already settled (and notified) by start(); a blocked one keeps waiting until its window ends.
    if (outcome.kind === "blocked" && Date.now() > row.scheduledAt.getTime() + rebootTiming.busyRetryWindowMs) {
      await this.settle(row.id, "failed", failureReport(outcome.reason, null), { notify: true });
    }
  }

  /** A hub died between claiming the row and arming the unit. Whether the unit was armed is unknown, so let the same
   *  boot-id check as REBOOTING decide: a different boot id proves it rebooted; the same one past the grace fails it. */
  private async advanceStarting(row: ServerReboot): Promise<void> {
    if (Date.now() - row.updatedAt.getTime() < rebootTiming.startingStaleMs) return;
    if (!row.snapshot) {
      await this.settle(row.id, "failed", failureReport("interrupted", null), { notify: row.mode === "scheduled" });
      return;
    }
    await this.prisma.serverReboot.updateMany({ where: { id: row.id, state: "STARTING" }, data: { state: "REBOOTING", startedAt: row.updatedAt } });
  }

  /** REBOOTING / WAITING_AGENT: the unit is armed. Wait for the agent to come back on a NEW boot id. */
  private async advanceWaiting(row: ServerReboot): Promise<void> {
    const snap = row.snapshot as unknown as RebootSnapshot | null;
    const startedAt = row.startedAt?.getTime() ?? row.updatedAt.getTime();
    const age = Date.now() - startedAt;
    const online = this.agentWs.isOnline(row.serverId);
    if (!online) {
      if (age > rebootTiming.agentDeadlineMs) {
        await this.settle(row.id, "failed", failureReport("agent_never_returned", snap, true), { notify: true });
        return;
      }
      if (row.state === "REBOOTING") await this.prisma.serverReboot.updateMany({ where: { id: row.id, state: "REBOOTING" }, data: { state: "WAITING_AGENT" } });
      return;
    }
    let bootId: string | null = null;
    try {
      const r = await this.agentWs.sendCommand(row.serverId, buildBootIdScript(), "patch", 15_000);
      bootId = parseRebootState(r.output).bootId;
    } catch {
      return; // flapping agent: look again next tick
    }
    if (bootId && snap?.bootId && bootId !== snap.bootId) {
      await this.prisma.serverReboot.updateMany({ where: { id: row.id, state: { in: ["REBOOTING", "WAITING_AGENT"] } }, data: { state: "VERIFYING", agentBackAt: new Date() } });
      const next = await this.prisma.serverReboot.findUnique({ where: { id: row.id } });
      if (next) await this.advanceVerifying(next); // do not wait a whole tick to take the first look
      return;
    }
    if (age > rebootTiming.noRebootGraceMs) {
      await this.settle(row.id, "failed", failureReport("host_did_not_reboot", snap), { notify: true });
    }
  }

  /** VERIFYING: poll the host until everything that was running is back, or the window ends. */
  private async advanceVerifying(row: ServerReboot): Promise<void> {
    const snap = row.snapshot as unknown as RebootSnapshot | null;
    if (!snap) {
      await this.settle(row.id, "failed", failureReport("interrupted", null, true), { notify: true });
      return;
    }
    const backAt = row.agentBackAt?.getTime() ?? row.updatedAt.getTime();
    const final = Date.now() - backAt >= rebootTiming.verifyWindowMs;
    const online = this.agentWs.isOnline(row.serverId);

    let state: RebootStateRead | null = null;
    let domains = null as ReturnType<typeof parseDomainProbe> | null;
    if (online) {
      try {
        const r = await this.agentWs.sendCommand(row.serverId, buildRebootStateScript(), "patch", STATE_TIMEOUT_MS);
        const read = parseRebootState(r.output);
        state = read.complete ? read : null;
      } catch {
        state = null;
      }
      if (state?.docker && snap.probe === "loopback" && snap.domains.length > 0) {
        try {
          const r = await this.agentWs.sendCommand(row.serverId, buildDomainProbeScript(snap.domains), "patch", PROBE_TIMEOUT_MS);
          domains = parseDomainProbe(r.output);
        } catch {
          domains = null;
        }
      }
    }
    let outcome = evaluateVerification({ snapshot: snap, state, domains, rebootRequired: null, final });
    // Everything else is fine: now (and only now: it costs a helper container) ask the host whether it still wants a reboot.
    if (outcome.result === "ok") {
      const flag = await this.readRebootFlag(row.serverId);
      outcome = evaluateVerification({ snapshot: snap, state, domains, rebootRequired: flag, final });
    }
    if (outcome.settled && outcome.result) {
      await this.settle(row.id, outcome.result, outcome.report, { notify: true });
      return;
    }
    await this.prisma.serverReboot.update({ where: { id: row.id }, data: { report: outcome.report as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
  }

  // ───────────────────────────── starting ─────────────────────────────

  /** Snapshot what should come back, then arm the host-side reboot unit. Returns how it went; failures are settled. */
  private async start(row: ServerReboot, knownServer?: { id: string; name: string; teamId: string; isLocal: boolean; proxyBind: string }): Promise<StartOutcome> {
    if (row.state === "SCHEDULED") {
      const claimed = await this.prisma.serverReboot.updateMany({ where: { id: row.id, state: "SCHEDULED" }, data: { state: "STARTING" } });
      if (claimed.count === 0) return { kind: "skipped" };
      await this.queue.unschedule(row.id).catch(() => undefined);
    }
    const scheduled = row.mode === "scheduled";
    const server = knownServer ?? (await this.prisma.server.findUnique({ where: { id: row.serverId }, select: { id: true, name: true, teamId: true, isLocal: true, proxyBind: true } }));
    if (!server) return { kind: "skipped" };
    const fail = async (reason: RebootFailureReason, http: "conflict" | "unavailable" | "bad", snap: RebootSnapshot | null = null): Promise<StartOutcome> => {
      await this.settle(row.id, "failed", failureReport(reason, snap), { notify: scheduled, server });
      return { kind: "failed", reason, http };
    };
    // A scheduled reboot that cannot start right now goes back to waiting (until its busy window ends).
    const block = async (reason: "busy_patch" | "busy_deploy" | "agent_offline"): Promise<StartOutcome> => {
      if (scheduled) await this.prisma.serverReboot.updateMany({ where: { id: row.id, state: "STARTING" }, data: { state: "SCHEDULED" } });
      return { kind: "blocked", reason };
    };

    if (!this.agentWs.isOnline(row.serverId)) return block("agent_offline");
    if (await this.deployRunning(row.serverId)) return block("busy_deploy");
    // Audited before it runs (a scheduled one was audited when it was scheduled; its firing is its own entry).
    if (scheduled) await this.audit.log({ actor: row.requestedBy, action: "server.reboot.start", target: row.serverId, meta: { rebootId: row.id } });

    let snap: RebootSnapshot;
    try {
      snap = await this.takeSnapshot(row, server);
    } catch (e) {
      if (e instanceof AgentOfflineException) return block("agent_offline");
      this.logger.warn(`reboot ${row.id}: snapshot failed: ${String(e)}`);
      return fail("snapshot_failed", "unavailable");
    }
    await this.prisma.serverReboot.update({ where: { id: row.id }, data: { snapshot: snap as unknown as Prisma.InputJsonValue } });

    let out: string;
    try {
      const r = await this.agentWs.sendCommand(row.serverId, wrapHostExec(buildRebootStartScript({ delaySec: REBOOT_DELAY_SEC }), HOST_EXEC), "patch", HOST_TIMEOUT_MS);
      out = r.output;
    } catch (e) {
      if (e instanceof AgentOfflineException) return block("agent_offline");
      if (isAfterSendDrop(e)) {
        // The command may have reached the host before the connection dropped: do not guess, let the boot id decide.
        await this.markRebooting(row.id);
        return { kind: "started" };
      }
      return fail("start_failed", "unavailable", snap);
    }
    const host = parseHostExec(out);
    if (!host.entered) {
      if (host.busy) return block("busy_patch");
      return fail("start_failed", "unavailable", snap);
    }
    const res = parseRebootStart(out);
    if (res.busy === "patch") return block("busy_patch");
    if (res.unsupported) return fail("unsupported", "bad", snap);
    if (!res.scheduled) return fail("start_failed", "unavailable", snap);
    await this.markRebooting(row.id);
    return { kind: "started" };
  }

  private async markRebooting(id: string): Promise<void> {
    await this.prisma.serverReboot.updateMany({ where: { id, state: "STARTING" }, data: { state: "REBOOTING", startedAt: new Date() } });
  }

  private async takeSnapshot(row: ServerReboot, server: { isLocal: boolean; proxyBind: string }): Promise<RebootSnapshot> {
    const r = await this.agentWs.sendCommand(row.serverId, buildRebootStateScript(), "patch", STATE_TIMEOUT_MS);
    const read = parseRebootState(r.output);
    if (!read.complete || read.docker !== true || !read.bootId) throw new Error("incomplete container state");
    const apps = await this.routedApps(row.serverId);
    return {
      version: 1,
      takenAt: new Date().toISOString(),
      bootId: read.bootId,
      hostsHub: server.isLocal,
      containers: snapshotContainers(read),
      domains: buildDomainTargets(apps),
      probe: server.proxyBind === "none" ? "skipped_no_host_port" : "loopback",
    };
  }

  // ───────────────────────────── finishing ─────────────────────────────

  /** End a reboot (once): store the result and report, audit it, tell the team. Returns false if it was already DONE. */
  private async settle(
    id: string,
    result: RebootResult,
    report: RebootReport,
    o: { notify: boolean; server?: { id: string; name: string; teamId: string } },
  ): Promise<boolean> {
    const done = await this.prisma.serverReboot.updateMany({
      where: { id, state: { not: "DONE" } },
      data: { state: "DONE", result, verifiedAt: new Date(), report: report as unknown as Prisma.InputJsonValue },
    });
    if (done.count === 0) return false;
    const row = await this.prisma.serverReboot.findUnique({ where: { id } });
    if (!row) return true;
    await this.audit
      .log({ actor: row.requestedBy, action: "server.reboot.result", target: row.serverId, meta: { rebootId: id, result, ...(report.reason ? { reason: report.reason } : {}), containersOk: report.summary.containersOk, containersExpected: report.summary.containersExpected, domainsOk: report.summary.domainsOk, domainsExpected: report.summary.domainsExpected } })
      .catch(() => undefined);
    const event = EVENT_FOR_RESULT[result];
    if (o.notify && event) {
      const server = o.server ?? (await this.prisma.server.findUnique({ where: { id: row.serverId }, select: { id: true, name: true, teamId: true } }));
      if (server) await this.notifications.fireForEvent(server.teamId, event, notifyCtx(server, row, report)).catch(() => undefined);
    }
    return true;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async requireServer(userId: string, serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { id: true, name: true, teamId: true, isLocal: true, proxyBind: true } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    return server;
  }

  private routedApps(serverId: string) {
    return this.prisma.application.findMany({
      where: { serverId, status: "RUNNING" },
      select: { status: true, domain: true, https: true, extraDomains: true, pathPrefix: true, serviceDomains: { select: { hostname: true } } },
    });
  }

  /** A deploy is running on this server (as the app's host, the run target, or the build server). */
  private async deployRunning(serverId: string): Promise<boolean> {
    const n = await this.prisma.deployment.count({
      where: { status: "RUNNING", OR: [{ runServerId: serverId }, { application: { serverId } }, { application: { buildServerId: serverId } }] },
    });
    return n > 0;
  }

  private async assertNoDeploy(serverId: string): Promise<void> {
    if (await this.deployRunning(serverId)) throw new ConflictException(FAILURE_MESSAGES.busy_deploy);
  }

  private async readHost(serverId: string) {
    const r = await this.agentWs.sendCommand(serverId, wrapHostExec(buildRebootPreflightScript(), HOST_EXEC), "patch", HOST_TIMEOUT_MS);
    const host = parseHostExec(r.output);
    if (!host.entered) {
      if (host.busy) throw new ConflictException("an OS update is running on this server — wait for it to finish before rebooting");
      throw new ServiceUnavailableException(`the server's host could not be reached: ${host.unavailableReason ?? "the agent could not run on the host"}`);
    }
    return parseRebootHost(r.output);
  }

  /** The host's "reboot required" flag after the reboot; null when it could not be read (never counted against the host). */
  private async readRebootFlag(serverId: string): Promise<boolean | null> {
    try {
      const r = await this.agentWs.sendCommand(serverId, wrapHostExec(buildRebootPreflightScript(), HOST_EXEC), "patch", HOST_TIMEOUT_MS);
      if (!parseHostExec(r.output).entered) return null;
      return parseRebootHost(r.output).rebootRequired;
    } catch {
      return null;
    }
  }
}

const FAILURE_MESSAGES: Record<RebootFailureReason, string> = {
  snapshot_failed: "could not read what is running on the server, so the reboot was not started",
  agent_offline: "the server's agent is offline — try again once it reconnects",
  busy_patch: "an OS update is running on this server — wait for it to finish before rebooting",
  busy_deploy: "a deploy is running on this server — wait for it to finish before rebooting",
  unsupported: "this server has no systemd, so Tugra cannot arm a delayed reboot on it — reboot it from a shell on the server",
  start_failed: "could not arm the reboot on the server",
  interrupted: "the hub was interrupted before the reboot started",
  host_did_not_reboot: "the server did not reboot",
  agent_never_returned: "the server's agent did not come back in time",
  docker_inactive: "Docker did not come back after the reboot",
  state_unreadable: "could not read the server after the reboot",
};

function notifyCtx(server: { id: string; name: string }, row: ServerReboot, report: RebootReport): Record<string, unknown> {
  const bad = [...report.containers.filter((c) => c.verdict === "missing" || c.verdict === "unhealthy" || c.verdict === "pending").map((c) => c.name), ...report.domains.filter((d) => d.verdict === "not_answering" || d.verdict === "pending").map((d) => d.host)];
  return {
    serverId: server.id,
    serverName: server.name,
    rebootId: row.id,
    reason: report.reason ?? "",
    containersOk: report.summary.containersOk,
    containersExpected: report.summary.containersExpected,
    domainsOk: report.summary.domainsOk,
    domainsExpected: report.summary.domainsExpected,
    rebootRequired: report.rebootRequired === "still_set" ? "yes" : "",
    problems: bad.slice(0, 8).join(", "),
    problemCount: bad.length,
  };
}

/** The wire view of a row: dates as ISO strings, the snapshot reduced to counts (the full snapshot stays server-side). */
export function toView(row: ServerReboot): RebootView {
  const snap = row.snapshot as unknown as RebootSnapshot | null;
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: row.id,
    serverId: row.serverId,
    mode: row.mode as RebootView["mode"],
    state: row.state as RebootView["state"],
    result: (row.result as RebootView["result"]) ?? null,
    requestedBy: row.requestedBy,
    scheduledAt: iso(row.scheduledAt),
    startedAt: iso(row.startedAt),
    agentBackAt: iso(row.agentBackAt),
    verifiedAt: iso(row.verifiedAt),
    createdAt: row.createdAt.toISOString(),
    snapshot: snap ? { containers: snap.containers.length, domains: snap.domains.length, hostsHub: snap.hostsHub } : null,
    report: (row.report as unknown as RebootView["report"]) ?? null,
  };
}
