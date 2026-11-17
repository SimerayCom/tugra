import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { appVersion, isNewer, parseVersion } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RedisService } from "../redis/redis.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { hubComposeProject } from "../hub-backup/hub-backup-script";
import { UpdateService } from "./update.service";
import { UPDATE_LOCK_KEY, UPDATE_STATUS_KEY, mapStatus } from "./updater.service";
import type { UpdaterView } from "./dto";
import {
  buildProbeScript,
  buildRefreshScript,
  decideConverge,
  parseProbeOutput,
  parseRefreshOutput,
  plannedServices,
  type IsBehind,
  type StackProbe,
} from "./stack-converge-script";

const INFO_KEY = "instance:update:updater-info";
const MARKER_KEY = "instance:update:stack-converge";
const INFO_TTL_S = 14 * 24 * 3600;
const MARKER_OK_TTL_S = 30 * 24 * 3600;
/** A failed attempt is retried after this long (the marker doubles as the "once per release" guard while it lives). */
const MARKER_FAILED_TTL_S = 6 * 3600;
/** After the helper is scheduled the update lock stays for this long: the recreate window (helper delay + `up`). */
const LOCK_HOLD_S = 120;
const PROBE_TIMEOUT_MS = 30_000;
const REFRESH_TIMEOUT_MS = 12 * 60_000;
/**
 * The lock is taken for the WHOLE operation: the refresh script pulls images and applies host files for up to
 * REFRESH_TIMEOUT_MS before it even starts the detached helper, and a lock that lapsed in between would let an
 * "Update now" queue a job that the helper's recreate then cuts off. Shortened to LOCK_HOLD_S once the helper runs.
 */
const LOCK_OPERATION_S = Math.ceil(REFRESH_TIMEOUT_MS / 1000) + 120;
const PANEL_MIN_GAP_MS = 10 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;
const INTERVAL_MS = 60 * 60_000;
const REFRESHING_WINDOW_MS = 10 * 60_000;
/** Without a probe taken after the refreshing window, "refreshing" is kept for at most this long before it counts as failed. */
const PROBE_GRACE_MS = 60 * 60_000;
const IN_FLIGHT_PHASES = new Set(["queued", "pulling", "recreating"]);

export type ConvergeOutcome =
  | "disabled"
  | "no-local-agent"
  | "agent-offline"
  | "no-capability"
  | "probe-failed"
  | "current"
  | "already-attempted"
  | "update-in-progress"
  | "no-digest"
  | "scheduled"
  | "failed"
  | "error";

interface StoredInfo {
  present: boolean;
  version: string | null;
  image: string | null;
  checkedAt: string;
  scheduledAt?: string;
  error?: string;
}

/** `other` is strictly older than `own`. An unparseable side is never "behind": the hub never acts on a guess. */
export const isBehind: IsBehind = (own, other) => !!other && !!parseVersion(own) && !!parseVersion(other) && isNewer(own, other);

/** uname/docker arch → the release pipeline's platform key (amd64 | arm64); unknown → null. */
function platformArch(arch: string | null | undefined): "amd64" | "arm64" | null {
  const a = (arch ?? "").toLowerCase();
  if (a === "x86_64" || a === "amd64") return "amd64";
  if (a === "aarch64" || a === "arm64") return "arm64";
  return null;
}

/**
 * Converges the bundled stack's helpers onto the hub's own release after an update, without an installer run.
 *
 * The in-app update recreates hub-api + web, and (through the checkout's scripts/update.sh) the local agent and the
 * updater sidecar. An install whose updater and update.sh predate those steps never got them, so after the hub was
 * updated its agent and updater stayed on old releases and the compose/scripts in the checkout were never applied. The
 * recreated hub therefore checks, through the LOCAL agent (a separate container that can run docker), whether the
 * updater (and agent) lag its own release and, if so, asks that agent to run the refresh script
 * (stack-converge-script.ts): pull by signed digest, apply the signed host files, recreate the lagging services with
 * a detached helper.
 *
 * Safety: never while an update job is queued/running (and the update lock is held for the window the recreate
 * needs); at most once per release (a Redis marker, retried after a failure only every few hours); only for a release
 * the signed manifest vouches for (digests come from it, version labels are checked on the pulled images); the
 * agent's own `deploy` capability gates every command, exactly like any other signed command.
 */
@Injectable()
export class StackConvergeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StackConvergeService.name);
  private running = false;
  private lastPanelRunAt = 0;
  private first?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly agentWs: AgentWsServer,
    private readonly update: UpdateService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    if (this.update.isForcedOff()) return; // TUGRA_UPDATE_CHECKS=0 is a hard off: nothing is pulled or fetched
    // A while after boot (the update job that brought this hub up is still finishing its own steps), then hourly.
    this.first = setTimeout(() => void this.reconcile(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.reconcile(), INTERVAL_MS);
    this.first.unref?.();
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** Opening the panel: probe/converge in the background at most every few minutes. Never waits, never throws. */
  reconcileIfStale(): void {
    const now = Date.now();
    if (this.running || now - this.lastPanelRunAt < PANEL_MIN_GAP_MS) return;
    this.lastPanelRunAt = now;
    void this.reconcile();
  }

  /** What the panel shows about the update helper. Reads only Redis, never docker. */
  async view(): Promise<UpdaterView> {
    const info = await this.readInfo();
    if (!info || !info.present) return { version: null, behind: false, state: "unknown", checkedAt: info?.checkedAt ?? null };
    const behind = isBehind(appVersion(), info.version);
    let state: UpdaterView["state"] = info.version ? "current" : "unknown";
    if (behind) {
      const scheduled = info.scheduledAt ? Date.parse(info.scheduledAt) : NaN;
      const checked = Date.parse(info.checkedAt);
      const sinceScheduled = Date.now() - scheduled;
      if (Number.isFinite(scheduled) && sinceScheduled < REFRESHING_WINDOW_MS) state = "refreshing";
      else if (Number.isFinite(scheduled) && !(checked >= scheduled + REFRESHING_WINDOW_MS) && sinceScheduled < PROBE_GRACE_MS) {
        // The stored version is still the one seen BEFORE the refresh: no probe has run since the helper had time to
        // recreate the updater, so "still behind" proves nothing yet. Keep saying "refreshing" and look again.
        state = "refreshing";
        this.reconcileIfStale();
      } else if (info.error || info.scheduledAt) state = "failed"; // an attempt was made and the helper still lags
      else state = "behind";
    }
    return { version: info.version, behind, state, checkedAt: info.checkedAt };
  }

  /** One pass. Never throws; the outcome is for logs and tests. Concurrent calls collapse into one. */
  async reconcile(): Promise<ConvergeOutcome> {
    if (this.running) return "current";
    this.running = true;
    try {
      return await this.run();
    } catch (e) {
      this.logger.warn(`stack converge failed: ${String((e as Error)?.message ?? e)}`);
      return "error";
    } finally {
      this.running = false;
    }
  }

  private async run(): Promise<ConvergeOutcome> {
    if (!this.update.isConfigured()) return "disabled";
    const local = await this.prisma.server.findFirst({ where: { isLocal: true }, select: { id: true, arch: true, agentVersion: true, capabilities: true } });
    if (!local) return "no-local-agent";
    if (!this.agentWs.isOnline(local.id)) return "agent-offline";
    if (!local.capabilities.includes("deploy")) return "no-capability";

    const own = appVersion();
    const project = hubComposeProject();

    let probe: StackProbe;
    try {
      const r = await this.agentWs.sendCommand(local.id, buildProbeScript(project), "deploy", PROBE_TIMEOUT_MS);
      probe = parseProbeOutput(r.output);
    } catch (e) {
      this.logger.warn(`could not inspect the updater through the local agent: ${String((e as Error)?.message ?? e)}`);
      return "probe-failed";
    }
    await this.saveProbe(probe);

    const decision = decideConverge({ own, updaterVersion: probe.version, updaterPresent: probe.present, agentVersion: local.agentVersion }, isBehind);
    if (!decision.refreshUpdater && !decision.refreshAgent) return "current";

    // Once per release: a marker written before the attempt (short TTL while it has not succeeded).
    if ((await this.redis.get(MARKER_KEY)) === own) return "already-attempted";
    // Never mid-job: an update that is queued/pulling/recreating owns the stack; the lock (also held for the recreate
    // window below) makes the check-and-take atomic against a click on "Update now".
    if (IN_FLIGHT_PHASES.has(mapStatus(await this.redis.get(UPDATE_STATUS_KEY)).phase)) return "update-in-progress";
    if (!(await this.redis.firstInWindow(UPDATE_LOCK_KEY, LOCK_OPERATION_S))) return "update-in-progress";

    let scheduled = false;
    try {
      // Digests come ONLY from the signed manifest, and only when it is for this very release.
      const verified = await this.update.verifyLatestEntry();
      const entry = verified.status === "ok" && verified.entry.version === own ? verified.entry : null;
      const arch = platformArch(local.arch);
      const agentDigest = arch ? entry?.agentSha256?.[arch] : undefined;
      const refreshAgent = decision.refreshAgent && !!agentDigest;
      const refreshUpdater = decision.refreshUpdater;
      if (!refreshAgent && !refreshUpdater) {
        await this.recordAttempt("the signed release manifest has no digest for this agent's platform yet", false);
        return "no-digest";
      }
      const plan = {
        project,
        version: own,
        refreshUpdater,
        refreshAgent,
        updaterDigest: entry?.imageDigests?.updater,
        agentDigest: refreshAgent ? agentDigest : undefined,
        // The host files are applied for a lagging updater only: that is the install whose checkout predates them.
        hostFilesDigest: refreshUpdater ? entry?.hostFilesDigest : undefined,
      };
      await this.redis.set(MARKER_KEY, own, MARKER_FAILED_TTL_S);
      const r = await this.agentWs.sendCommand(local.id, buildRefreshScript(plan), "deploy", REFRESH_TIMEOUT_MS);
      const res = parseRefreshOutput(r.exitCode, r.output);
      if (!res.ok) {
        this.logger.warn(`updater refresh to ${own} did not start: ${res.error ?? "unknown"}`);
        await this.recordAttempt(res.error ?? "failed", false);
        return "failed";
      }
      scheduled = true;
      // The helper is running now: the lock only has to cover its delay + recreate from here on.
      await this.redis.expire(UPDATE_LOCK_KEY, LOCK_HOLD_S).catch(() => undefined);
      await this.redis.set(MARKER_KEY, own, MARKER_OK_TTL_S);
      await this.recordAttempt(null, true);
      this.logger.log(`refreshing ${plannedServices(plan).join(" + ")} to ${own} through the local agent${res.hostFiles ? ` (host files: ${res.hostFiles})` : ""}`);
      await this.audit.log({
        actor: "system",
        action: "instance_update.stack_converge",
        target: local.id,
        meta: { version: own, services: res.scheduled, hostFiles: res.hostFiles },
      });
      return "scheduled";
    } catch (e) {
      this.logger.warn(`updater refresh failed: ${String((e as Error)?.message ?? e)}`);
      await this.recordAttempt("the local agent did not complete the refresh", false).catch(() => undefined);
      return "failed";
    } finally {
      // Hold the lock through the recreate window after a successful start (shortened above); release it at once otherwise.
      if (!scheduled) await this.redis.del(UPDATE_LOCK_KEY).catch(() => undefined);
    }
  }

  private async readInfo(): Promise<StoredInfo | null> {
    try {
      const raw = await this.redis.get(INFO_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as Partial<StoredInfo>;
      if (typeof p.present !== "boolean" || typeof p.checkedAt !== "string") return null;
      return {
        present: p.present,
        version: typeof p.version === "string" ? p.version : null,
        image: typeof p.image === "string" ? p.image : null,
        checkedAt: p.checkedAt,
        ...(typeof p.scheduledAt === "string" ? { scheduledAt: p.scheduledAt } : {}),
        ...(typeof p.error === "string" ? { error: p.error } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Store what the probe saw; the previous attempt's outcome is carried over only while the helper is unchanged. */
  private async saveProbe(probe: StackProbe): Promise<void> {
    const prior = await this.readInfo();
    const same = prior && prior.version === probe.version;
    const next: StoredInfo = {
      present: probe.present,
      version: probe.version,
      image: probe.image,
      checkedAt: new Date().toISOString(),
      ...(same && prior.scheduledAt ? { scheduledAt: prior.scheduledAt } : {}),
      ...(same && prior.error ? { error: prior.error } : {}),
    };
    await this.redis.set(INFO_KEY, JSON.stringify(next), INFO_TTL_S);
  }

  private async recordAttempt(error: string | null, scheduled: boolean): Promise<void> {
    const cur = (await this.readInfo()) ?? { present: true, version: null, image: null, checkedAt: new Date().toISOString() };
    const next: StoredInfo = { ...cur, checkedAt: cur.checkedAt };
    delete next.error;
    delete next.scheduledAt;
    if (scheduled) next.scheduledAt = new Date().toISOString();
    if (error) next.error = error.slice(0, 200);
    await this.redis.set(INFO_KEY, JSON.stringify(next), INFO_TTL_S);
  }
}
