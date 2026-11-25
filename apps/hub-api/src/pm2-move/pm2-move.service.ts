import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { ApplicationsService } from "../applications/applications.service";
import { assertSafeDockerOptions } from "../deploy/docker-options-safety";
import { runTag, tokenizeDockerOptions } from "../deploy/deploy-script";
import { autoFlagMultiline } from "../importer/env-auto-flags";
import { parseStoredReport } from "../server-ops/server-scan";
import { buildPm2FactsScript, parsePm2Facts, type Pm2FactsUser } from "./pm2-facts";
import { planAll, planProcess, type Pm2Exec, type Pm2Overrides, type Pm2Plan, type ScanSiteLite } from "./pm2-plan";
import {
  MOVE_SCRIPT_TIMEOUT_MS,
  RECOVER_SCRIPT_TIMEOUT_MS,
  buildPm2MoveScript,
  buildPm2RecoverScript,
  parsePm2MoveOutput,
  type MoveOutcome,
  type Pm2ScriptInput,
} from "./pm2-script";
import type { Pm2MoveInput, Pm2PlanInput } from "./dto";

const FACTS_TIMEOUT_MS = 60_000;
const JOB_TTL_MS = 2 * 60 * 60_000;
const MAX_JOBS = 50;

export type ItemStatus = "queued" | "running" | "moved" | "rolled_back" | "aborted" | "plan_changed" | "rollback_failed" | "unknown" | "failed";

export interface JobItem {
  key: string;
  user: string;
  name: string;
  status: ItemStatus;
  /** The step the script last reported (precheck, pull, stop, start, health, delete, rollback). */
  step: string | null;
  reason: string | null;
  appId: string | null;
  /** Moved to Tugra, but `pm2 delete` / `pm2 save` failed: the stopped entry is still in PM2 and must be removed by hand. */
  pm2Left: boolean;
  /** The app's own last output after a failed start (control characters stripped, 15 lines max). Owner-only. */
  logTail: string[];
  errTail: string[];
}
export interface JobView {
  id: string;
  serverId: string;
  state: "running" | "done";
  startedAt: string;
  finishedAt: string | null;
  items: JobItem[];
}
interface Job extends JobView {
  startedMs: number;
}

export type PlanResponse = { plans: Pm2Plan[]; truncated: boolean };

/**
 * "Move to Tugra (in place)" for PM2 processes. Instance-owner only (the controller's guards) because the result is a
 * host-network container that bind-mounts a host directory read-write and runs as the process's own uid: the same
 * host-privilege class as the per-app owner override, which this service sets on the app it creates (never on any
 * other). Per process, one atomic cutover script on the host (see pm2-script.ts); the hub prepares the app record
 * before and settles it after.
 *
 * Honest limits: the job list lives in this hub process (a hub restart loses the progress view, not the host state:
 * each script finishes or rolls back on its own); one job per server at a time.
 */
@Injectable()
export class Pm2MoveService {
  private readonly log = new Logger(Pm2MoveService.name);
  private readonly jobs = new Map<string, Job>();
  private readonly activeByServer = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
  ) {}

  // ── preview ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async plan(userId: string, serverId: string, body: Pm2PlanInput): Promise<PlanResponse> {
    const server = await this.load(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    const sites = this.sitesOf(server.scanReport);
    const facts = await this.readFacts(serverId);
    const overrides: Record<string, Pm2Overrides> = {};
    for (const it of body.items ?? []) overrides[`${it.user}/${it.name}`] = { nodeMajor: it.nodeMajor, probePath: it.probePath ?? null };
    const planned = planAll(facts.users, sites, overrides);
    return { plans: planned.map((p) => p.plan), truncated: facts.truncated };
  }

  // ── move ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  async start(userId: string, serverId: string, body: Pm2MoveInput): Promise<JobView> {
    const server = await this.load(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    if (body.environmentId) await this.assertEnvironmentInTeam(body.environmentId, server.teamId);
    // The move runs host-level code (patch capability) and starts a container (deploy capability): both must be granted.
    for (const cap of ["patch", "deploy"] as const) {
      if (!(await this.agentWs.isCapabilityGranted(serverId, cap))) throw new ForbiddenException(`capability "${cap}" is not granted for this server`);
    }
    const keys = new Set<string>();
    for (const it of body.items) {
      const key = `${it.user}/${it.name}`;
      if (keys.has(key)) throw new BadRequestException("the same process is listed twice");
      keys.add(key);
    }
    if (this.activeByServer.has(serverId)) throw new ConflictException("a PM2 move is already running on this server");
    this.gc();

    const job: Job = {
      id: randomBytes(12).toString("hex"),
      serverId,
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedMs: Date.now(),
      items: body.items.map((it) => ({
        key: `${it.user}/${it.name}`,
        user: it.user,
        name: it.name,
        status: "queued" as ItemStatus,
        step: null,
        reason: null,
        appId: null,
        pm2Left: false,
        logTail: [],
        errTail: [],
      })),
    };
    this.jobs.set(job.id, job);
    this.activeByServer.set(serverId, job.id);
    // Counts only: process names stay out of the audit trail.
    await this.audit.log({ actor: userId, action: "pm2.move.start", target: serverId, meta: { processes: body.items.length } });
    const sites = this.sitesOf(server.scanReport);
    void this.runJob(job, userId, body, sites).catch((e) => this.log.error(`pm2 move job failed: ${(e as Error).message}`));
    return this.view(job);
  }

  async getJob(userId: string, serverId: string, jobId: string): Promise<JobView> {
    const server = await this.load(serverId);
    await this.access.requirePermission(userId, server.teamId, "servers:ops");
    const job = this.jobs.get(jobId);
    if (!job || job.serverId !== serverId) throw new NotFoundException("move job not found");
    return this.view(job);
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async runJob(job: Job, userId: string, body: Pm2MoveInput, sites: ScanSiteLite[]): Promise<void> {
    try {
      for (let i = 0; i < body.items.length; i++) {
        const item = job.items[i];
        item.status = "running";
        try {
          await this.moveOne(job, item, userId, body.items[i], body.environmentId, sites);
        } catch (e) {
          // A failure of the hub's own preparation (before the host was touched) or an unreachable agent.
          item.status = item.status === "running" ? "failed" : item.status;
          item.reason = this.reasonOf(e);
          this.log.warn(`pm2 move item failed: ${(e as Error).message}`);
        }
        await this.audit
          .log({ actor: userId, action: "pm2.move", target: item.appId ?? job.serverId, meta: { serverId: job.serverId, result: item.status, reason: item.reason, pm2Left: item.pm2Left } })
          .catch(() => undefined);
      }
    } finally {
      job.state = "done";
      job.finishedAt = new Date().toISOString();
      this.activeByServer.delete(job.serverId);
    }
  }

  private async moveOne(
    job: Job,
    item: JobItem,
    userId: string,
    req: Pm2MoveInput["items"][number],
    environmentId: string | undefined,
    sites: ScanSiteLite[],
  ): Promise<void> {
    // 1. fresh facts of THIS process (with its environment) and a fresh plan: the preview must still be true.
    const fresh = await this.readFacts(job.serverId, { user: req.user, name: req.name, withEnv: true });
    const owner = fresh.users.find((u) => u.user === req.user);
    const fact = owner?.procs.find((p) => p.name === req.name);
    if (!owner || !fact) {
      item.status = "plan_changed";
      item.reason = "gone";
      return;
    }
    const planned = planProcess(owner, fact, { sites, override: { nodeMajor: req.nodeMajor, probePath: req.probePath ?? null } });
    if (planned.plan.planHash !== req.planHash) {
      item.status = "plan_changed";
      item.reason = "changed";
      return;
    }
    if (!planned.exec) {
      item.status = "plan_changed";
      item.reason = planned.plan.reasons[0] ?? "unsupported";
      return;
    }
    const exec = planned.exec;

    // 2. the Tugra app record: the same shape a manual setup would have, so a later redeploy reproduces the container.
    const env = fact.env ?? {};
    let envFlags: ReturnType<typeof autoFlagMultiline>;
    try {
      envFlags = autoFlagMultiline(env);
    } catch (e) {
      throw new BadRequestException(`cannot carry the environment: ${(e as Error).message}`);
    }
    this.assertExecOptions(exec);
    const created = await this.apps.create(userId, {
      name: exec.name,
      serverId: job.serverId,
      environmentId,
      source: "IMAGE",
      image: exec.image,
      containerPort: exec.healthPort ?? 80,
      env,
      ...(Object.keys(envFlags).length ? { envFlags } : {}),
      exposeMode: "none",
      deploy: false,
      tags: ["pm2", "moved"],
    });
    item.appId = created.id;
    try {
      await this.prisma.application.update({
        where: { id: created.id },
        data: {
          dockerOptions: exec.dockerOptions,
          // The owner override, on THIS app only: the options above carry host networking and a read-write host bind.
          allowPrivilegedDockerOptions: true,
          containerCommand: exec.command as unknown as Prisma.InputJsonValue,
          restartPolicy: "unless-stopped",
          // Two copies can never share a host port: a redeploy replaces, it never overlaps.
          deployStrategy: "RECREATE",
        },
      });
      const dep = await this.prisma.deployment.create({
        data: { appId: created.id, status: "RUNNING", kind: "DEPLOY", trigger: "pm2-move", requestedBy: userId, startedAt: new Date() },
      });
      const tag = runTag({ id: created.id }, dep.id);
      const runScript = await this.apps.buildLocalRunScript(created.id, dep.id);
      const input: Pm2ScriptInput = {
        appId: created.id,
        user: exec.user,
        home: exec.home,
        userUid: exec.userUid,
        name: exec.name,
        image: exec.image,
        interpreterDir: exec.interpreterDir,
        healthPort: exec.healthPort,
        probePath: exec.probePath,
        tag,
      };
      const outcome = await this.runScripts(job.serverId, buildPm2MoveScript({ ...input, runScript }), () => buildPm2RecoverScript(input), item);
      await this.settle(item, outcome, dep.id, tag);
    } catch (e) {
      // Nothing reached the host (a build/validation error or an offline agent): the record has no container behind it.
      if (item.status === "running") await this.apps.discardUndeployed(created.id);
      throw e;
    }
  }

  /** Run the move script; when its outcome is unknown (timeout, dropped agent, no final marker) run the recovery. */
  private async runScripts(serverId: string, script: string, recover: () => string, item: JobItem): Promise<MoveOutcome> {
    let outcome: MoveOutcome | null = null;
    try {
      const r = await this.agentWs.sendCommand(serverId, script, "patch", MOVE_SCRIPT_TIMEOUT_MS, (chunk) => this.trackStep(item, chunk));
      outcome = parsePm2MoveOutput(r.output);
    } catch (e) {
      // The agent never got the command: nothing happened, so there is nothing to recover.
      if (e instanceof AgentOfflineException || e instanceof ForbiddenException) throw e;
      outcome = null;
    }
    if (outcome && outcome.result !== "unknown") return outcome;
    this.log.warn("pm2 move outcome unknown; running the recovery");
    try {
      const r = await this.agentWs.sendCommand(serverId, recover(), "patch", RECOVER_SCRIPT_TIMEOUT_MS);
      const rec = parsePm2MoveOutput(r.output);
      return { ...rec, steps: [...(outcome?.steps ?? []), ...rec.steps] };
    } catch {
      return { result: "unknown", reason: "agent_unreachable", steps: outcome?.steps ?? [], logTail: outcome?.logTail ?? [], errTail: outcome?.errTail ?? [] };
    }
  }

  private trackStep(item: JobItem, chunk: string): void {
    for (const m of chunk.matchAll(/^TUGRA_PM2MOVE: step=([a-z]{1,20})\s*$/gm)) item.step = m[1];
  }

  private async settle(item: JobItem, o: MoveOutcome, depId: string, tag: string): Promise<void> {
    item.step = o.steps.length ? o.steps[o.steps.length - 1] : item.step;
    item.reason = o.reason;
    item.logTail = o.logTail;
    item.errTail = o.errTail;
    const appId = item.appId as string;
    switch (o.result) {
      case "moved":
      case "moved_pm2_left":
        item.status = "moved";
        item.pm2Left = o.result === "moved_pm2_left";
        await this.prisma.application.update({ where: { id: appId }, data: { status: "RUNNING" } });
        await this.prisma.deployment.update({
          where: { id: depId },
          data: {
            status: "SUCCESS",
            exitCode: 0,
            imageTag: tag,
            durationMs: 0,
            logs: `Moved in place from PM2 (${o.steps.join(" > ")}).${item.pm2Left ? " The stopped PM2 entry could not be removed." : ""}`,
          },
        });
        return;
      case "unknown":
        // Neither success nor a confirmed rollback: keep the record (a container may be live) and say so.
        item.status = "unknown";
        return;
      default:
        item.status = o.result === "rolled_back" ? "rolled_back" : o.result === "aborted" ? "aborted" : "rollback_failed";
        // The container (if any) is gone and the PM2 process was put back: the record has nothing behind it. When the
        // rollback itself failed the record is dropped too; the process is then stopped in PM2 and the result says so.
        await this.apps.discardUndeployed(appId);
        item.appId = null;
    }
  }

  private assertExecOptions(exec: Pm2Exec): void {
    // The options are generated from validated fields only; assert it anyway, and that they tokenize to what we built.
    assertSafeDockerOptions(exec.dockerOptions, { allowPrivileged: true });
    const t = tokenizeDockerOptions(exec.dockerOptions);
    const want = ["--network", "host", "-u", `${exec.uid}:${exec.gid}`, "-w", exec.workDir, "-v", `${exec.mountDir}:${exec.mountDir}`];
    if (t.length !== want.length || t.some((x, i) => x !== want[i])) throw new BadRequestException("the generated docker options are not the expected ones");
  }

  private async readFacts(serverId: string, narrow: { user?: string; name?: string; withEnv?: boolean } = {}): Promise<{ users: Pm2FactsUser[]; truncated: boolean }> {
    const r = await this.agentWs.sendCommand(serverId, buildPm2FactsScript(narrow), "bulk", FACTS_TIMEOUT_MS);
    const parsed = parsePm2Facts(r.output);
    if (parsed.status !== "ok") {
      throw new ServiceUnavailableException(parsed.reason === "outdated" ? "update this server's agent to read its PM2 processes" : "could not read the PM2 processes of this server");
    }
    return { users: parsed.users, truncated: parsed.truncated };
  }

  private sitesOf(stored: unknown): ScanSiteLite[] {
    const report = parseStoredReport(stored);
    return (report?.sites ?? []).map((s) => ({ names: s.names, root: s.root, kind: s.kind, port: s.port, siteUser: s.siteUser }));
  }

  private reasonOf(e: unknown): string {
    if (e instanceof AgentOfflineException) return "agent_offline";
    if (e instanceof ForbiddenException) return "capability";
    if (e instanceof BadRequestException) return "invalid";
    return "error";
  }

  private async assertEnvironmentInTeam(environmentId: string, teamId: string): Promise<void> {
    const env = await this.prisma.environment.findFirst({ where: { id: environmentId, project: { teamId } }, select: { id: true } });
    if (!env) throw new BadRequestException("environment not found in this team");
  }

  private view(job: Job): JobView {
    return { id: job.id, serverId: job.serverId, state: job.state, startedAt: job.startedAt, finishedAt: job.finishedAt, items: job.items.map((i) => ({ ...i })) };
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.state === "done" && now - j.startedMs > JOB_TTL_MS) this.jobs.delete(id);
    while (this.jobs.size >= MAX_JOBS) {
      const oldest = [...this.jobs.values()].filter((j) => j.state === "done").sort((a, b) => a.startedMs - b.startedMs)[0];
      if (!oldest) break;
      this.jobs.delete(oldest.id);
    }
  }

  private async load(serverId: string) {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    return server;
  }
}
