import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, Role, ServerStatus } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import {
  COOLIFY_SSH_GRANT_DEFAULT_HOURS,
  COOLIFY_SSH_LIMITS,
  COOLIFY_SSH_UUID_RE,
  COOLIFY_SSH_CONTAINER_ID_RE,
  appVersion,
  coolifySshOffersManualCommand,
  type CoolifyProbeFacts,
  type CoolifySshResultCode,
  type CoolifySshResultMsg,
  type CoolifySshRunView,
  type CoolifySshTargetState,
  type CoolifySshTargetView,
} from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { APP_MOVE_TERMINAL } from "../common/app-move-guard";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ServersService } from "../servers/servers.service";
import type { CoolifyInventoryData, InvServer } from "./coolify-inventory";
import { findHostMatch } from "./coolify-install-plan";
import { COOLIFY_SSH_PROBE_SHA256, COOLIFY_SSH_UNINSTALL_SHA256, renderCoolifySshInstallScript } from "./coolify-ssh-scripts";
import {
  COOLIFY_HOST_IDENTITY,
  Semaphore,
  checkEnrolled,
  clampPerHost,
  codeOfError,
  decideProbe,
  isActiveState,
  useSudoFor,
  COOLIFY_SSH_ACTIVE_STATES,
  type CoolifyHostIdentityReader,
} from "./coolify-ssh-plan";

const OWNER_ONLY: Role[] = [Role.OWNER];
const READ_ROLES: Role[] = [Role.OWNER, Role.ADMIN];
const MAX_TARGETS_PER_RUN = 100;
const SWEEP_MS = 60_000;
/** How long the cross-check waits for a freshly enrolled agent to report its own sshd host keys. */
const IDENTITY_WAIT_MS = 2_000;
const IDENTITY_WAIT_TRIES = 6;
const ENROLL_POLL_MS = 3_000;
const MIN_ENROLL_WAIT_MS = 60_000;
const PROBE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const UNINSTALL_TIMEOUT_MS = 120_000;
/** Migration run statuses in which the run no longer works on its target servers. */
const MIGRATION_TERMINAL = ["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "FAILED", "DRY_RUN_DONE"] as const;
/** Codes after which the install may have started the container anyway: the hub cannot tell from the code alone, so it looks (a probe). */
const OUTCOME_UNKNOWN: readonly CoolifySshResultCode[] = ["timeout", "unreachable", "installer_failed"];
/** Marker kept in the grant's `classes` when THIS run turned the capability on (it is dropped again only then). */
const CAP_ADDED = "cap_added";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
    }),
  random: () => Math.random(),
};

export interface StartRunInput {
  coolifyServerUuids: string[];
  teamId: string;
  confirm: string;
  concurrency?: number;
}

type TargetRow = {
  id: string;
  teamId: string;
  serverId: string;
  runId: string;
  grantId: string | null;
  coolifyServerUuid: string;
  name: string;
  state: string;
  code: string | null;
  targetTeamId: string | null;
  tugraServerId: string | null;
  probe: Prisma.JsonValue | null;
  hostKeyFp: string | null;
  containerId: string | null;
  cancelledAt: Date | null;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isInventory(v: unknown): v is CoolifyInventoryData {
  return !!v && typeof v === "object" && (v as { v?: unknown }).v === 1 && Array.isArray((v as { servers?: unknown }).servers);
}

/** The first of `base`, `base (2)`, ... that no server of the team already uses (a team keeps one name per server). */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  const clean = base.trim().slice(0, 100) || "Server";
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) {
    const n = `${clean} (${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/**
 * Install the Tugra agent on the servers a Coolify knows, over Coolify's own SSH keys, through the agent on the Coolify host (Coolify hub
 * takeover, lane C). The keys never leave that host and the hub never sees them: it names a Coolify server uuid and the agent resolves the
 * address, key and host key itself.
 *
 * Per target a persisted state machine: PLANNED -> PROBING -> {SKIPPED_PRESENT | SKIPPED_FOREIGN | READY | FAILED} -> TOKEN_MINTED ->
 * INSTALLING -> WAIT_ENROLL -> ONLINE | FAILED, and ONLINE -> UNINSTALLING -> REMOVED. The probe is read-only and runs first; an enroll
 * token is minted only for a READY target, and is voided on every failure. A restart resumes with a probe, never a blind re-run.
 *
 * Team OWNER only (the Coolify host's team, and the target team with `servers:manage`), under a time-limited consent grant that also turns
 * the `coolify_ssh` capability on and off. Every privileged step is audited with names and fixed codes only: never a token or a key path.
 */
@Injectable()
export class CoolifySshInstallService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoolifySshInstallService.name);
  /** Replaced in tests (no sleeping, a controlled clock). */
  clock: Clock = realClock;
  private readonly hubSem = new Semaphore(COOLIFY_SSH_LIMITS.perHub);
  private readonly hostSems = new Map<string, Semaphore>();
  private readonly inflight = new Set<Promise<unknown>>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** The Coolify servers of an inventory, by run (display facts for the audit rows: address, port, user, key NAME). */
  private readonly facts = new Map<string, Map<string, InvServer>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly servers: ServersService,
    private readonly config: ConfigService,
    @Optional() @Inject(COOLIFY_HOST_IDENTITY) private readonly identity?: CoolifyHostIdentityReader,
  ) {}

  onModuleInit(): void {
    this.track(this.recover().catch((e) => this.logger.warn(`ssh install recovery skipped: ${e instanceof Error ? e.constructor.name : "error"}`)));
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Resolves when every background step that is running now has finished (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------------

  async latestRun(userId: string, serverId: string): Promise<CoolifySshRunView | null> {
    const inv = await this.requireInventory(serverId);
    await this.access.requireRole(userId, inv.teamId, READ_ROLES);
    const last = await this.prisma.coolifyHostGrant.findFirst({ where: { serverId, kind: "ssh", runId: { not: null } }, orderBy: { createdAt: "desc" } });
    if (!last?.runId) return null;
    return this.buildView(serverId, last.runId);
  }

  async getRun(userId: string, serverId: string, runId: string): Promise<CoolifySshRunView> {
    const inv = await this.requireInventory(serverId);
    await this.access.requireRole(userId, inv.teamId, READ_ROLES);
    return this.buildView(serverId, runId);
  }

  // ---- start (consent + probe) -------------------------------------------------------------------------------------------------

  /**
   * The owner agrees (types the number of servers), the hub opens a consent window for the run and PROBES the chosen servers. Nothing is
   * installed yet: the probe is read-only. A second request for the same servers while a run is going returns that run.
   */
  async startRun(userId: string, serverId: string, input: StartRunInput): Promise<CoolifySshRunView> {
    const inv = await this.requireInventory(serverId);
    await this.requireInstaller(userId, inv.teamId, input.teamId);
    const uuids = [...new Set(input.coolifyServerUuids)];
    if (uuids.length === 0 || uuids.length > MAX_TARGETS_PER_RUN || uuids.some((u) => !COOLIFY_SSH_UUID_RE.test(u))) {
      throw new BadRequestException({ code: "bad_request", message: "choose between 1 and 100 Coolify servers" });
    }
    if (input.confirm !== String(uuids.length)) throw new BadRequestException({ code: "confirm_mismatch", message: "type the number of servers to confirm" });
    if (!isInventory(inv.snapshot)) throw new ConflictException({ code: "not_read", message: "Read this Coolify first" });
    const byUuid = new Map(inv.snapshot.servers.map((s) => [s.uuid, s]));
    const chosen: InvServer[] = [];
    for (const u of uuids) {
      const s = byUuid.get(u);
      if (!s || s.isLocal) throw new BadRequestException({ code: "unknown_server", message: "That server is not in this inventory, or is the Coolify host itself" });
      chosen.push(s);
    }
    this.assertAgentReady(serverId);

    // Single flight: one active row per (Coolify host, Coolify server).
    const active = await this.prisma.coolifySshTarget.findMany({
      where: { serverId, coolifyServerUuid: { in: uuids }, state: { in: [...COOLIFY_SSH_ACTIVE_STATES, "READY"] } },
      select: { runId: true, coolifyServerUuid: true },
    });
    if (active.length > 0) {
      const runs = new Set(active.map((a) => a.runId));
      if (runs.size === 1 && active.length === uuids.length) return this.buildView(serverId, [...runs][0]);
      throw new ConflictException({ code: "run_in_progress", message: "Some of these servers are already being installed" });
    }

    const runId = randomUUID();
    const hours = COOLIFY_SSH_GRANT_DEFAULT_HOURS;
    const capAdded = await this.servers.setRunCapability(serverId, "coolify_ssh", true);
    const grant = await this.prisma.coolifyHostGrant.create({
      data: { teamId: inv.teamId, serverId, kind: "ssh", classes: capAdded ? [CAP_ADDED] : [], grantedById: userId, runId, expiresAt: new Date(this.clock.now() + hours * 3_600_000) },
    });
    await this.audit.log({ actor: userId, action: "coolify.ssh.grant", target: serverId, meta: { runId, count: uuids.length, hours, targetTeamId: input.teamId } });

    // Servers that are already in Tugra with a live agent need no SSH at all.
    const known = await this.prisma.server.findMany({
      where: { teamId: { in: await this.access.teamIds(userId) }, status: ServerStatus.ONLINE },
      select: { id: true, teamId: true, publicIp: true, publicIpv6: true, hostname: true, reportedIps: true },
    });
    const rows = chosen.map((s) => {
      const hit = findHostMatch(s.ip, known).match;
      return {
        teamId: inv.teamId, serverId, runId, grantId: grant.id, coolifyServerUuid: s.uuid, name: s.name.slice(0, 100), targetTeamId: input.teamId,
        state: hit ? "SKIPPED_PRESENT" : "PLANNED", code: hit ? "skipped_present" : null, tugraServerId: hit ? hit.id : null, finishedAt: hit ? new Date(this.clock.now()) : null,
      };
    });
    await this.prisma.coolifySshTarget.createMany({ data: rows });
    this.facts.set(runId, new Map(chosen.map((s) => [s.uuid, s])));
    this.hostSem(serverId).setMax(clampPerHost(input.concurrency));

    for (const r of rows) if (r.state === "PLANNED") this.track(this.probeOne(runId, r.coolifyServerUuid, userId));
    this.track(this.finalize(runId));
    return this.buildView(serverId, runId);
  }

  // ---- install (after the probe) -----------------------------------------------------------------------------------------------

  /** Install the agent on the READY targets of a run. The owner types the number of servers they are installing on. */
  async startInstall(userId: string, serverId: string, runId: string, input: { confirm: string; coolifyServerUuids?: string[] }): Promise<CoolifySshRunView> {
    const inv = await this.requireInventory(serverId);
    const ready = await this.prisma.coolifySshTarget.findMany({ where: { serverId, runId, state: "READY" } });
    if (ready.length === 0) throw new ConflictException({ code: "nothing_ready", message: "No server of this run is ready to install" });
    await this.requireInstaller(userId, inv.teamId, ready[0].targetTeamId ?? inv.teamId);
    const pick = input.coolifyServerUuids ? new Set(input.coolifyServerUuids) : null;
    const chosen = pick ? ready.filter((r) => pick.has(r.coolifyServerUuid)) : ready;
    if (chosen.length === 0) throw new BadRequestException({ code: "unknown_server", message: "None of those servers is ready" });
    if (input.confirm !== String(chosen.length)) throw new BadRequestException({ code: "confirm_mismatch", message: "type the number of servers to confirm" });
    await this.requireLiveGrant(runId);
    this.assertAgentReady(serverId);
    await this.audit.log({ actor: userId, action: "coolify.ssh.install_start", target: serverId, meta: { runId, count: chosen.length } });
    for (const t of chosen) this.track(this.installOne(t.id, userId));
    return this.buildView(serverId, runId);
  }

  // ---- uninstall (undo) --------------------------------------------------------------------------------------------------------

  /** Take the agent off the servers THIS run installed it on. A fresh consent window opens if the old one ended (typed count again). */
  async startUninstall(userId: string, serverId: string, runId: string, input: { confirm: string; coolifyServerUuids?: string[] }): Promise<CoolifySshRunView> {
    const inv = await this.requireInventory(serverId);
    const online = await this.prisma.coolifySshTarget.findMany({ where: { serverId, runId, state: "ONLINE", containerId: { not: null } } });
    if (online.length === 0) throw new ConflictException({ code: "nothing_to_remove", message: "No agent installed by this run can be removed" });
    await this.requireInstaller(userId, inv.teamId, online[0].targetTeamId ?? inv.teamId);
    const pick = input.coolifyServerUuids ? new Set(input.coolifyServerUuids) : null;
    const chosen = pick ? online.filter((r) => pick.has(r.coolifyServerUuid)) : online;
    if (chosen.length === 0) throw new BadRequestException({ code: "unknown_server", message: "None of those servers can be removed" });
    if (input.confirm !== String(chosen.length)) throw new BadRequestException({ code: "confirm_mismatch", message: "type the number of servers to confirm" });
    this.assertAgentReady(serverId);
    // The agent of a server that works (apps, databases, a move or a migration) is not taken off: the volume goes with it, and so would the
    // server's records. The owner moves or deletes those first.
    const busy: string[] = [];
    for (const t of chosen) if (t.tugraServerId && (await this.serverInUse(t.tugraServerId))) busy.push(t.name);
    if (busy.length > 0) {
      await this.audit.log({ actor: userId, action: "coolify.ssh.uninstall_refused", target: serverId, meta: { runId, count: busy.length, reason: "server_in_use" } });
      throw new ConflictException({ code: "server_in_use", message: `These servers still run apps, databases or a move: ${busy.slice(0, 5).join(", ")}. Move or delete those first.` });
    }
    await this.renewGrant(userId, inv.teamId, serverId, runId);
    await this.audit.log({ actor: userId, action: "coolify.ssh.uninstall_start", target: serverId, meta: { runId, count: chosen.length } });
    for (const t of chosen) this.track(this.uninstallOne(t.id));
    return this.buildView(serverId, runId);
  }

  // ---- cancel ------------------------------------------------------------------------------------------------------------------

  /**
   * Stop the run. Targets that have not started become FAILED/cancelled now; one that is in the middle of a step is rolled back at the next safe
   * point (an installed agent is removed again). The consent ends, and the capability with it, once nothing is running any more.
   */
  async cancelRun(userId: string, serverId: string, runId: string): Promise<CoolifySshRunView> {
    const inv = await this.requireInventory(serverId);
    await this.access.requireRole(userId, inv.teamId, OWNER_ONLY);
    const now = new Date(this.clock.now());
    await this.prisma.coolifySshTarget.updateMany({ where: { serverId, runId, state: { in: ["PLANNED", "READY"] } }, data: { state: "FAILED", code: "cancelled", cancelledAt: now, finishedAt: now } });
    await this.prisma.coolifySshTarget.updateMany({ where: { serverId, runId, state: { in: ["PROBING", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "UNINSTALLING"] } }, data: { cancelledAt: now } });
    await this.audit.log({ actor: userId, action: "coolify.ssh.cancel", target: serverId, meta: { runId } });
    await this.finalize(runId);
    return this.buildView(serverId, runId);
  }

  // ---- the pipelines (background) ----------------------------------------------------------------------------------------------

  private hostSem(serverId: string): Semaphore {
    let s = this.hostSems.get(serverId);
    if (!s) {
      s = new Semaphore(COOLIFY_SSH_LIMITS.perHostDefault);
      this.hostSems.set(serverId, s);
    }
    return s;
  }

  /** Both caps (this Coolify host, and the hub as a whole), taken together; the order is fixed so two callers cannot deadlock. */
  private async slot(serverId: string): Promise<() => void> {
    const host = await this.hostSem(serverId).acquire();
    const hub = await this.hubSem.acquire();
    return () => {
      hub();
      host();
    };
  }

  private async load(id: string): Promise<TargetRow | null> {
    return (await this.prisma.coolifySshTarget.findUnique({ where: { id } })) as TargetRow | null;
  }

  /** Move a target from one of `from` to a new state in one guarded write; false when someone else moved it first. */
  private async move(id: string, from: CoolifySshTargetState[], to: CoolifySshTargetState, data: Prisma.CoolifySshTargetUncheckedUpdateManyInput = {}): Promise<boolean> {
    const r = await this.prisma.coolifySshTarget.updateMany({ where: { id, state: { in: from } }, data: { ...data, state: to } });
    return r.count === 1;
  }

  private async fail(id: string, from: CoolifySshTargetState[], code: CoolifySshResultCode, data: Prisma.CoolifySshTargetUncheckedUpdateManyInput = {}): Promise<void> {
    await this.move(id, from, "FAILED", { ...data, code, finishedAt: new Date(this.clock.now()) });
  }

  private async probeOne(runId: string, uuid: string, userId: string): Promise<void> {
    const t = await this.prisma.coolifySshTarget.findFirst({ where: { runId, coolifyServerUuid: uuid } });
    if (!t || !(await this.move(t.id, ["PLANNED"], "PROBING", { startedAt: new Date(this.clock.now()), attempts: { increment: 1 } }))) return;
    const release = await this.slot(t.serverId);
    const started = this.clock.now();
    try {
      await this.clock.sleep(Math.floor(this.clock.random() * COOLIFY_SSH_LIMITS.jitterMaxMs));
      if ((await this.load(t.id))?.cancelledAt) return void (await this.fail(t.id, ["PROBING"], "cancelled"));
      let res: CoolifySshResultMsg;
      try {
        res = await this.agentWs.sendCoolifySsh(
          t.serverId,
          { op: "probe", coolifyServerUuid: uuid, scriptSha256: COOLIFY_SSH_PROBE_SHA256, payloadSha256: EMPTY_SHA256, useSudo: false, expectedHostKeyFp: "" },
          PROBE_TIMEOUT_MS,
        );
      } catch (e) {
        const code = codeOfError(e);
        await this.fail(t.id, ["PROBING"], code);
        return void (await this.auditStep(userId, "probe", t, runId, { code, durationMs: this.clock.now() - started }));
      }
      const d = decideProbe(res);
      const fp = res.probe?.sshHostKeyFp ?? null;
      const done = d.state === "READY" ? {} : { finishedAt: new Date(this.clock.now()) };
      await this.move(t.id, ["PROBING"], d.state, { code: d.code, probe: (res.probe ?? null) as Prisma.InputJsonValue, hostKeyFp: fp, ...done });
      await this.auditStep(userId, "probe", t, runId, { code: d.code ?? "ok", hostKeyFp: fp ?? undefined, durationMs: res.durationMs ?? this.clock.now() - started });
    } catch (e) {
      await this.fail(t.id, ["PROBING"], codeOfError(e));
      this.logger.warn(`ssh probe step failed: ${e instanceof Error ? e.constructor.name : "error"}`);
    } finally {
      release();
      await this.finalize(runId);
    }
  }

  private async installOne(targetId: string, userId: string): Promise<void> {
    const t0 = await this.load(targetId);
    if (!t0) return;
    const runId = t0.runId;
    // Claim first: two clicks, or two admins, mint ONE token.
    if (!(await this.move(targetId, ["READY"], "TOKEN_MINTED", { startedAt: new Date(this.clock.now()), attempts: { increment: 1 } }))) return;
    const release = await this.slot(t0.serverId);
    const started = this.clock.now();
    let mintedServerId: string | null = null;
    let containerId: string | null = null;
    let installSent = false;
    const rollback = async (code: CoolifySshResultCode, uninstall: boolean): Promise<void> => {
      if (uninstall && containerId) await this.removeRemote(t0, containerId, userId);
      if (mintedServerId) await this.voidToken(mintedServerId, userId);
      await this.fail(targetId, ["TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL"], code, { tugraServerId: null });
    };
    try {
      await this.clock.sleep(Math.floor(this.clock.random() * COOLIFY_SSH_LIMITS.jitterMaxMs));
      let t = (await this.load(targetId))!;
      if (t.cancelledAt) return void (await rollback("cancelled", false));
      const facts = (t.probe ?? null) as CoolifyProbeFacts | null;

      // The token is minted only now, after a READY probe.
      const teamId = t.targetTeamId ?? t.teamId;
      const taken = new Set((await this.prisma.server.findMany({ where: { teamId }, select: { name: true } })).map((s) => s.name.toLowerCase()));
      const made = await this.servers.createServersBulk(userId, [freeName(t.name, taken)], teamId);
      mintedServerId = made.servers[0].server.id;
      const token = made.servers[0].enrollToken;
      await this.move(targetId, ["TOKEN_MINTED"], "TOKEN_MINTED", { tugraServerId: mintedServerId });
      t = (await this.load(targetId))!;
      if (t.cancelledAt) return void (await rollback("cancelled", false));

      if (!(await this.move(targetId, ["TOKEN_MINTED"], "INSTALLING"))) return void (await rollback("cancelled", false));
      const script = renderCoolifySshInstallScript(this.agentImage());
      let res: CoolifySshResultMsg;
      try {
        installSent = true;
        res = await this.agentWs.sendCoolifySsh(
          t.serverId,
          {
            op: "install", coolifyServerUuid: t.coolifyServerUuid, scriptSha256: sha256(script), payloadSha256: sha256(token), useSudo: useSudoFor(facts),
            expectedHostKeyFp: t.hostKeyFp ?? "", script, payload: token,
          },
          Math.min(INSTALL_TIMEOUT_MS, COOLIFY_SSH_LIMITS.targetTimeoutMs),
        );
      } catch (e) {
        const code = await this.settleUnknownInstall(t, codeOfError(e));
        await rollback(code, false);
        return void (await this.auditStep(userId, "install", t, runId, { code, durationMs: this.clock.now() - started }));
      }
      if (!res.ok) {
        const code = await this.settleUnknownInstall(t, res.code);
        await rollback(code, false);
        return void (await this.auditStep(userId, "install", t, runId, { code, durationMs: res.durationMs ?? this.clock.now() - started }));
      }
      containerId = res.containerId && COOLIFY_SSH_CONTAINER_ID_RE.test(res.containerId) ? res.containerId : null;
      await this.move(targetId, ["INSTALLING"], "WAIT_ENROLL", { containerId });

      // Wait for the agent to enroll, bounded by what is left of the target's own budget.
      const deadline = this.clock.now() + Math.max(MIN_ENROLL_WAIT_MS, COOLIFY_SSH_LIMITS.targetTimeoutMs - (this.clock.now() - started));
      const outcome = await this.waitForEnroll(targetId, mintedServerId, deadline);
      if (outcome === "cancelled") return void (await rollback("cancelled", true));
      if (outcome === "timeout") {
        await rollback("enroll_timeout", true);
        return void (await this.auditStep(userId, "install", t, runId, { code: "enroll_timeout", durationMs: this.clock.now() - started }));
      }
      const verdict = await this.crossCheck(t, mintedServerId);
      if (verdict === "mismatch") {
        // The token went to another machine: void it, drop the row, take the agent off again, tell the owner.
        await this.voidToken(mintedServerId, userId);
        mintedServerId = null;
        await rollback("hostkey_mismatch", true);
        return void (await this.auditStep(userId, "install", t, runId, { code: "hostkey_mismatch", crossCheck: verdict, durationMs: this.clock.now() - started }));
      }
      await this.move(targetId, ["WAIT_ENROLL"], "ONLINE", { code: null, finishedAt: new Date(this.clock.now()) });
      await this.auditStep(userId, "install", t, runId, { code: "ok_installed", crossCheck: verdict, tugraServerId: mintedServerId, durationMs: this.clock.now() - started });
    } catch (e) {
      this.logger.warn(`ssh install step failed: ${e instanceof Error ? e.constructor.name : "error"}`);
      const code = installSent && !containerId ? await this.settleUnknownInstall(t0, codeOfError(e)) : codeOfError(e);
      await rollback(code, true).catch(() => undefined);
    } finally {
      release();
      await this.finalize(runId);
    }
  }

  private async uninstallOne(targetId: string): Promise<void> {
    const t = await this.load(targetId);
    if (!t || !t.containerId || !(await this.move(targetId, ["ONLINE"], "UNINSTALLING"))) return;
    const release = await this.slot(t.serverId);
    const started = this.clock.now();
    try {
      const grant = await this.prisma.coolifyHostGrant.findFirst({ where: { runId: t.runId, kind: "ssh" }, orderBy: { createdAt: "desc" } });
      const actor = grant?.grantedById ?? "system";
      const ok = await this.removeRemote(t, t.containerId, actor);
      if (ok) {
        // Something may have been placed on the server while the agent was being removed: then the row (and its cascade) stays.
        const tugraId = t.tugraServerId;
        const dropRow = !!tugraId && !(await this.serverInUse(tugraId));
        await this.move(targetId, ["UNINSTALLING"], "REMOVED", { code: null, containerId: null, ...(dropRow ? { tugraServerId: null } : {}), finishedAt: new Date(this.clock.now()) });
        if (dropRow) await this.voidToken(tugraId!, actor);
        else if (tugraId) this.logger.warn("agent removed but the Tugra server row was kept: it is in use");
      } else {
        await this.move(targetId, ["UNINSTALLING"], "ONLINE", { code: "bad_target" });
      }
      await this.auditStep(actor, "uninstall", t, t.runId, { code: ok ? "ok_installed" : "bad_target", durationMs: this.clock.now() - started });
    } catch (e) {
      await this.move(targetId, ["UNINSTALLING"], "ONLINE", { code: codeOfError(e) });
      this.logger.warn(`ssh uninstall step failed: ${e instanceof Error ? e.constructor.name : "error"}`);
    } finally {
      release();
      await this.finalize(t.runId);
    }
  }

  /** True while anything depends on this Tugra server: an app or database on it, a move, or a migration that targets it. */
  private async serverInUse(tugraServerId: string): Promise<boolean> {
    const id = tugraServerId;
    const [apps, dbs, appMoves, lock, runs] = await Promise.all([
      this.prisma.application.count({ where: { OR: [{ serverId: id }, { buildServerId: id }] } }),
      this.prisma.database.count({ where: { serverId: id } }),
      this.prisma.appMove.count({ where: { phase: { notIn: APP_MOVE_TERMINAL }, OR: [{ sourceServerId: id }, { targetServerId: id }] } }),
      this.prisma.migrationRunServerLock.count({ where: { serverId: id } }),
      this.prisma.migrationRun.count({ where: { targetServerId: id, status: { notIn: [...MIGRATION_TERMINAL] } } }),
    ]);
    return apps + dbs + appMoves + lock + runs > 0;
  }

  /**
   * After an install call whose outcome is not known (a timeout, a dropped agent, a generic failure) the container may be running on the
   * target. The hub looks with a probe (read only, the existing signed script): nothing found keeps the original code; our agent found
   * means it was left behind; no answer means the owner must look. Never a silent FAILED.
   */
  private async settleUnknownInstall(t: TargetRow, code: CoolifySshResultCode): Promise<CoolifySshResultCode> {
    if (!OUTCOME_UNKNOWN.includes(code)) return code;
    try {
      const res = await this.agentWs.sendCoolifySsh(
        t.serverId,
        { op: "probe", coolifyServerUuid: t.coolifyServerUuid, scriptSha256: COOLIFY_SSH_PROBE_SHA256, payloadSha256: EMPTY_SHA256, useSudo: false, expectedHostKeyFp: t.hostKeyFp ?? "" },
        PROBE_TIMEOUT_MS,
      );
      const agent = res.probe?.agent;
      if (res.ok && agent === "none") return code;
      if (agent === "ours" || agent === "stopped") return "agent_left_behind";
      return "install_unconfirmed";
    } catch {
      return "install_unconfirmed";
    }
  }

  /** The agent takes off the container THIS run installed (pinned by id and hub on the target); true when it is gone. */
  private async removeRemote(t: TargetRow, containerId: string, _actor: string): Promise<boolean> {
    try {
      const facts = (t.probe ?? null) as CoolifyProbeFacts | null;
      const res = await this.agentWs.sendCoolifySsh(
        t.serverId,
        {
          op: "uninstall", coolifyServerUuid: t.coolifyServerUuid, scriptSha256: COOLIFY_SSH_UNINSTALL_SHA256, payloadSha256: sha256(containerId), useSudo: useSudoFor(facts),
          expectedHostKeyFp: t.hostKeyFp ?? "", payload: containerId,
        },
        UNINSTALL_TIMEOUT_MS,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForEnroll(targetId: string, tugraServerId: string, deadline: number): Promise<"online" | "timeout" | "cancelled"> {
    for (;;) {
      const s = await this.prisma.server.findUnique({ where: { id: tugraServerId }, select: { status: true } });
      if (s?.status === ServerStatus.ONLINE) return "online";
      if ((await this.load(targetId))?.cancelledAt) return "cancelled";
      if (this.clock.now() >= deadline) return "timeout";
      await this.clock.sleep(ENROLL_POLL_MS);
    }
  }

  private async crossCheck(t: TargetRow, tugraServerId: string): Promise<"fingerprint" | "address" | "unverified" | "mismatch"> {
    let reportedFp: string | null = null;
    let reportedFps: string[] = [];
    // The agent reports its own sshd host keys with its host info, a moment after it comes online: give that report a short while, then
    // fall back to the address (the check never blocks without a report; it only says how strong the proof was).
    for (let i = 0; i < IDENTITY_WAIT_TRIES; i++) {
      try {
        reportedFp = (await this.identity?.reportedHostKeyFp(tugraServerId)) ?? null;
        reportedFps = (await this.identity?.reportedHostKeyFps?.(tugraServerId)) ?? [];
      } catch {
        reportedFp = null;
        reportedFps = [];
      }
      if (reportedFp || reportedFps.length > 0 || !t.hostKeyFp || !this.identity || i === IDENTITY_WAIT_TRIES - 1) break;
      await this.clock.sleep(IDENTITY_WAIT_MS);
    }
    const srv = await this.prisma.server.findUnique({ where: { id: tugraServerId }, select: { publicIp: true, publicIpv6: true, reportedIps: true } });
    const address = (await this.factOf(t))?.ip ?? "";
    return checkEnrolled({ probedFp: t.hostKeyFp, reportedFp, reportedFps, coolifyAddress: address, reportedAddresses: [srv?.publicIp, srv?.publicIpv6, ...(srv?.reportedIps ?? [])] });
  }

  /** Void an enroll token: the pending Tugra server it belongs to is removed (an enrolled one too, when it turned out to be the wrong machine). */
  private async voidToken(tugraServerId: string, actor: string): Promise<void> {
    try {
      await this.servers.deleteForUser(actor, tugraServerId);
    } catch (e) {
      this.logger.warn(`could not remove the pending server of a failed install: ${e instanceof Error ? e.constructor.name : "error"}`);
      // Last resort: make the token unusable even if the row cannot be deleted.
      await this.prisma.server.updateMany({ where: { id: tugraServerId, status: ServerStatus.PENDING }, data: { enrollTokenExpiresAt: new Date(0) } }).catch(() => undefined);
    }
  }

  private agentImage(): string {
    return this.config.get<string>("AGENT_IMAGE") ?? `ghcr.io/simeraycom/tugra-agent:${appVersion()}`;
  }

  // ---- consent -----------------------------------------------------------------------------------------------------------------

  private async requireLiveGrant(runId: string) {
    const g = await this.prisma.coolifyHostGrant.findFirst({ where: { runId, kind: "ssh", revokedAt: null, expiresAt: { gt: new Date(this.clock.now()) } } });
    if (!g) throw new ConflictException({ code: "grant_expired", message: "The consent for this run ended. Start a new run." });
    return g;
  }

  /** Uninstall may come after the window closed: a fresh window opens on the owner's typed confirmation. */
  private async renewGrant(userId: string, teamId: string, serverId: string, runId: string): Promise<void> {
    const live = await this.prisma.coolifyHostGrant.findFirst({ where: { runId, kind: "ssh", revokedAt: null, expiresAt: { gt: new Date(this.clock.now()) } } });
    if (live) return;
    const capAdded = await this.servers.setRunCapability(serverId, "coolify_ssh", true);
    await this.prisma.coolifyHostGrant.create({
      data: { teamId, serverId, kind: "ssh", classes: capAdded ? [CAP_ADDED] : [], grantedById: userId, runId, expiresAt: new Date(this.clock.now() + COOLIFY_SSH_GRANT_DEFAULT_HOURS * 3_600_000) },
    });
    await this.audit.log({ actor: userId, action: "coolify.ssh.grant", target: serverId, meta: { runId, hours: COOLIFY_SSH_GRANT_DEFAULT_HOURS, renewed: true } });
  }

  private async revokeGrant(g: { id: string; serverId: string; runId: string | null; classes: string[] }, reason: string, byId: string | null): Promise<void> {
    await this.prisma.coolifyHostGrant.updateMany({ where: { id: g.id, revokedAt: null }, data: { revokedAt: new Date(this.clock.now()), revokedById: byId } });
    if (g.classes.includes(CAP_ADDED)) {
      // The marker belongs to the host, not to one run: the grant that turned the capability on may end while another run's grant on the same
      // host is still live. The marker then passes to a live grant, so the last one to end is the one that turns the capability off.
      const others = (await this.prisma.coolifyHostGrant.findMany({ where: { serverId: g.serverId, kind: "ssh", revokedAt: null, expiresAt: { gt: new Date(this.clock.now()) }, id: { not: g.id } } })) as Array<{ id: string; classes: string[] }>;
      if (others.length === 0) await this.servers.setRunCapability(g.serverId, "coolify_ssh", false);
      else if (!others.some((o) => o.classes.includes(CAP_ADDED))) await this.prisma.coolifyHostGrant.updateMany({ where: { id: others[0].id, revokedAt: null }, data: { classes: [...others[0].classes, CAP_ADDED] } });
    }
    await this.audit.log({ actor: byId ?? "system", action: "coolify.ssh.revoke", target: g.serverId, meta: { runId: g.runId ?? undefined, reason } });
  }

  /** When nothing of a run is working any more and nothing waits for the owner, the consent ends and the capability goes with it. */
  private async finalize(runId: string): Promise<void> {
    const rows = await this.prisma.coolifySshTarget.findMany({ where: { runId }, select: { state: true, cancelledAt: true } });
    if (rows.length === 0 || rows.some((r) => isActiveState(r.state))) return;
    if (rows.some((r) => r.state === "READY") && !rows.some((r) => r.cancelledAt)) return; // the owner can still install
    const grants = await this.prisma.coolifyHostGrant.findMany({ where: { runId, kind: "ssh", revokedAt: null } });
    for (const g of grants) await this.revokeGrant(g, rows.some((r) => r.cancelledAt) ? "cancelled" : "finished", null);
  }

  /** Housekeeping: end expired consent, and give up on steps that outlived the run's time limit. */
  async sweep(): Promise<void> {
    const now = new Date(this.clock.now());
    const expired = await this.prisma.coolifyHostGrant.findMany({ where: { kind: "ssh", revokedAt: null, expiresAt: { lte: now } } });
    for (const g of expired) await this.revokeGrant(g, "expired", null);
    const stale = await this.prisma.coolifySshTarget.findMany({
      where: { state: { in: [...COOLIFY_SSH_ACTIVE_STATES] }, createdAt: { lt: new Date(this.clock.now() - COOLIFY_SSH_LIMITS.runTimeoutMs) } },
      select: { id: true, runId: true, state: true, tugraServerId: true, grantId: true },
    });
    for (const s of stale) {
      await this.fail(s.id, [s.state as CoolifySshTargetState], "timeout");
      await this.finalize(s.runId);
    }
  }

  /**
   * After a restart: PROBING goes back to PLANNED so the probe runs again (it is read-only); a target that was past the token step is not
   * installed blindly a second time: it fails (and its pending server is removed), and the next run starts with a probe, which sees whatever
   * the first one left. One that was waiting for the agent to enroll keeps waiting; an uninstall in progress is probed again by the owner.
   */
  async recover(): Promise<void> {
    const rows = (await this.prisma.coolifySshTarget.findMany({ where: { state: { in: ["PROBING", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "UNINSTALLING"] } } })) as TargetRow[];
    for (const t of rows) {
      const grant = await this.prisma.coolifyHostGrant.findFirst({ where: { runId: t.runId, kind: "ssh" }, orderBy: { createdAt: "desc" } });
      const actor = grant?.grantedById ?? "system";
      if (t.state === "PROBING") {
        if (await this.move(t.id, ["PROBING"], "PLANNED")) this.track(this.probeOne(t.runId, t.coolifyServerUuid, actor));
      } else if (t.state === "UNINSTALLING") {
        await this.move(t.id, ["UNINSTALLING"], "ONLINE");
      } else if (t.state === "WAIT_ENROLL" && t.tugraServerId) {
        this.track(this.resumeEnroll(t, actor));
      } else {
        if (t.tugraServerId) await this.voidToken(t.tugraServerId, actor);
        // An install that was in flight when the hub stopped may have started the container: look before calling it a plain timeout.
        const code = t.state === "INSTALLING" ? await this.settleUnknownInstall(t, "timeout") : "timeout";
        await this.fail(t.id, [t.state as CoolifySshTargetState], code, { tugraServerId: null });
        await this.finalize(t.runId);
      }
    }
  }

  private async resumeEnroll(t: TargetRow, actor: string): Promise<void> {
    const outcome = await this.waitForEnroll(t.id, t.tugraServerId!, this.clock.now() + MIN_ENROLL_WAIT_MS);
    if (outcome === "online") {
      const verdict = await this.crossCheck(t, t.tugraServerId!);
      if (verdict !== "mismatch") {
        await this.move(t.id, ["WAIT_ENROLL"], "ONLINE", { code: null, finishedAt: new Date(this.clock.now()) });
        return void (await this.finalize(t.runId));
      }
    }
    if (t.containerId) await this.removeRemote(t, t.containerId, actor);
    if (t.tugraServerId) await this.voidToken(t.tugraServerId, actor);
    await this.fail(t.id, ["WAIT_ENROLL"], outcome === "online" ? "hostkey_mismatch" : "enroll_timeout", { tugraServerId: null });
    await this.finalize(t.runId);
  }

  // ---- guards and views --------------------------------------------------------------------------------------------------------

  private async requireInventory(serverId: string) {
    const inv = await this.prisma.coolifyInventory.findUnique({ where: { serverId } });
    if (!inv) throw new ForbiddenException({ code: "not_enabled", message: "This server has not been opted in" });
    return inv;
  }

  /** OWNER of the Coolify host's team, and OWNER with `servers:manage` of the team the new servers go to. */
  private async requireInstaller(userId: string, hostTeamId: string, targetTeamId: string): Promise<void> {
    await this.access.requireRole(userId, hostTeamId, OWNER_ONLY);
    await this.access.requireRole(userId, targetTeamId, OWNER_ONLY);
    await this.access.requirePermission(userId, targetTeamId, "servers:manage");
  }

  private assertAgentReady(serverId: string): void {
    if (!this.agentWs.isOnline(serverId)) throw new ConflictException({ code: "agent_offline", message: "The agent on the Coolify server is offline" });
    if (!this.agentWs.agentSupports(serverId, "coolify_ssh_v1")) throw new ConflictException({ code: "agent_too_old", message: "Update the agent on the Coolify server first" });
  }

  private async auditStep(actor: string, step: "probe" | "install" | "uninstall", t: TargetRow, runId: string, extra: { code: string; hostKeyFp?: string; crossCheck?: string; tugraServerId?: string | null; durationMs: number }): Promise<void> {
    const f = await this.factOf(t);
    await this.audit.log({
      actor,
      action: `coolify.ssh.${step}`,
      target: t.serverId,
      meta: {
        runId, coolifyServerUuid: t.coolifyServerUuid, ...(f ? { ip: f.ip, port: f.port, user: f.user, keyName: f.keyName } : {}),
        code: extra.code, ...(extra.hostKeyFp ? { hostKeyFp: extra.hostKeyFp } : {}), ...(extra.crossCheck ? { crossCheck: extra.crossCheck } : {}),
        ...(extra.tugraServerId ? { tugraServerId: extra.tugraServerId } : {}), durationMs: Math.max(0, Math.round(extra.durationMs)),
      },
    });
  }

  /** The Coolify server's address, port, user and key NAME for the audit row and the enroll check; read from the stored inventory after a restart. */
  private async factOf(t: TargetRow): Promise<InvServer | undefined> {
    const known = this.facts.get(t.runId)?.get(t.coolifyServerUuid);
    if (known) return known;
    const inv = await this.prisma.coolifyInventory.findUnique({ where: { serverId: t.serverId }, select: { snapshot: true } }).catch(() => null);
    if (!inv || !isInventory(inv.snapshot)) return undefined;
    const found = inv.snapshot.servers.find((s) => s.uuid === t.coolifyServerUuid);
    if (found) {
      const m = this.facts.get(t.runId) ?? new Map<string, InvServer>();
      m.set(found.uuid, found);
      this.facts.set(t.runId, m);
    }
    return found;
  }

  private view(t: TargetRow): CoolifySshTargetView {
    const state = t.state as CoolifySshTargetState;
    const code = (t.code as CoolifySshResultCode | null) ?? null;
    return {
      id: t.id, runId: t.runId, coolifyServerUuid: t.coolifyServerUuid, name: t.name, state, code, tugraServerId: t.tugraServerId,
      manualCommand: state === "FAILED" && coolifySshOffersManualCommand(code),
      canRemove: state === "ONLINE" && !!t.containerId && !!t.tugraServerId,
      probe: (t.probe ?? null) as CoolifyProbeFacts | null,
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  private async buildView(serverId: string, runId: string): Promise<CoolifySshRunView> {
    const rows = (await this.prisma.coolifySshTarget.findMany({ where: { serverId, runId }, orderBy: { createdAt: "asc" } })) as TargetRow[];
    if (rows.length === 0) throw new NotFoundException("run not found");
    const grant = await this.prisma.coolifyHostGrant.findFirst({ where: { runId, kind: "ssh" }, orderBy: { createdAt: "desc" } });
    const ended = !grant || !!grant.revokedAt || grant.expiresAt.getTime() <= this.clock.now();
    return {
      runId,
      inventoryServerId: serverId,
      teamId: rows[0].targetTeamId ?? rows[0].teamId,
      expiresAt: (grant?.expiresAt ?? new Date(0)).toISOString(),
      finished: !rows.some((r) => isActiveState(r.state) || (r.state === "READY" && !ended)),
      targets: rows.map((r) => this.view(r)),
    };
  }
}
