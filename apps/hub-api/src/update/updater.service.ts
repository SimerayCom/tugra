import { Injectable, Logger } from "@nestjs/common";
import { appVersion, isAutoApplicable, isNewer, parseVersion } from "@tugra/shared";
import { RedisService } from "../redis/redis.service";
import { UpdateService } from "./update.service";
import { InFlightService } from "../in-flight/in-flight.service";
import type { InFlightItem } from "../in-flight/in-flight.dto";
import { SHA256_HEX } from "./update-manifest";
import type { HalfUpdateView, UpdateApplyResult, UpdateHoldView, UpdateProgress } from "./dto";

// The hub cannot recreate its own container, so it never runs docker. Instead it takes a cross-process
// lock and LPUSHes a job onto a Redis queue that the `tugra-updater` sidecar (docker.sock) drains; the
// sidecar reports progress back into the status key. All three keys live in Redis so they survive the
// hub-api container being recreated mid-update.
export const UPDATE_LOCK_KEY = "instance:update:lock";
export const UPDATE_STATUS_KEY = "instance:update:status";
const LOCK_KEY = UPDATE_LOCK_KEY;
const STATUS_KEY = UPDATE_STATUS_KEY;
export const UPDATE_QUEUE_KEY = "instance:update:queue";
const QUEUE_KEY = UPDATE_QUEUE_KEY;
/** Written by the sidecar (no TTL) when .env names a release newer than the one the containers run; see HalfUpdateView. */
export const UPDATE_HALF_STATE_KEY = "instance:update:half_state";
/** Written by the scheduler while an automatic update is held back by work in flight (see UpdateHoldView). The TTL is only a backstop: the first tick that finds nothing in flight clears it. */
export const UPDATE_HOLD_KEY = "instance:update:hold";
const HOLD_TTL_S = 6 * 3600;
const LOCK_TTL_S = 900; // 15-min backstop; the sidecar releases the lock on any terminal status
const STATUS_TTL_S = 3600; // must outlive the recreate so a reconnecting client can read the final state

const TERMINAL_PHASES: readonly UpdateProgress["phase"][] = ["done", "failed", "recovery_required"];

/** Whether a progress phase is terminal (the SSE completes here). Pure — unit-tested directly. */
export function isTerminalPhase(phase: UpdateProgress["phase"]): boolean {
  return TERMINAL_PHASES.includes(phase);
}

const EMPTY_PROGRESS_FIELDS = { code: null, needBytes: null, haveBytes: null, path: null } as const;

/** Parse the Redis status blob into a UpdateProgress; "idle" when absent or unparseable. Pure. */
export function mapStatus(raw: string | null): UpdateProgress {
  if (!raw) return { phase: "idle", targetVersion: null, error: null, ...EMPTY_PROGRESS_FIELDS };
  try {
    const p = JSON.parse(raw) as Partial<Record<keyof UpdateProgress, unknown>>;
    const phases: UpdateProgress["phase"][] = ["idle", "queued", "pulling", "recreating", "done", "failed", "recovery_required"];
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
    return {
      phase: typeof p.phase === "string" && (phases as string[]).includes(p.phase) ? (p.phase as UpdateProgress["phase"]) : "idle",
      targetVersion: str(p.targetVersion),
      error: str(p.error),
      code: str(p.code),
      needBytes: num(p.needBytes),
      haveBytes: num(p.haveBytes),
      path: str(p.path),
    };
  } catch {
    return { phase: "idle", targetVersion: null, error: null, ...EMPTY_PROGRESS_FIELDS };
  }
}

/** Parse the sidecar's half-state marker; null when absent/garbled or when the running hub already is on `envVersion`. Pure. */
export function mapHalfState(raw: string | null, running: string): HalfUpdateView | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { envVersion?: unknown; runningVersion?: unknown };
    if (typeof p.envVersion !== "string" || typeof p.runningVersion !== "string") return null;
    if (!parseVersion(p.envVersion) || !isNewer(p.envVersion, running)) return null; // stale: the hub caught up (or it is not a version)
    return { envVersion: p.envVersion, runningVersion: running };
  } catch {
    return null;
  }
}

/** A job's agent digests: the signed per-platform image manifest digests, keyed like the manifest's `agentSha256`. */
export type AgentDigests = Record<string, string>;

/**
 * The job the sidecar drains. When the freshly verified manifest entry carries BOTH the hub and web INDEX
 * digests the job pins them (`{targetVersion, hubDigest, webDigest}`, flat strings — the sidecar parses with
 * grep, no jq); a missing or partial pair degrades to the legacy tag-only `{targetVersion}` so old manifests
 * keep updating exactly as before. The digests are bare 64-hex (schema-validated at consume time).
 * `hostFilesDigest` (sha256 of the release's signed host-files manifest) is added independently when the entry
 * carries it: it tells the sidecar the release publishes compose/script files to apply. It carries NO file content —
 * the sidecar downloads and signature-verifies those itself, so a compromised hub or Redis cannot inject a file.
 * `agentAmd64Digest` / `agentArm64Digest` (the manifest's per-platform agent image digests, only when well-formed) let
 * the sidecar pull the bundled local agent by digest — a plain tag pull of the multi-platform index failed on engines
 * with the containerd image store — and are optional: without them the sidecar pulls the tag with `docker pull`.
 * Pure — unit-tested directly.
 */
export interface UpdateJob {
  targetVersion: string;
  hubDigest?: string;
  webDigest?: string;
  hostFilesDigest?: string;
  agentAmd64Digest?: string;
  agentArm64Digest?: string;
}
export function buildUpdateJob(
  targetVersion: string,
  digests?: { hub?: string; web?: string },
  hostFilesDigest?: string,
  agentSha256?: AgentDigests,
): UpdateJob {
  const job: UpdateJob = { targetVersion };
  if (digests?.hub && digests.web) {
    job.hubDigest = digests.hub;
    job.webDigest = digests.web;
  }
  if (hostFilesDigest) job.hostFilesDigest = hostFilesDigest;
  if (agentSha256?.amd64 && SHA256_HEX.test(agentSha256.amd64)) job.agentAmd64Digest = agentSha256.amd64;
  if (agentSha256?.arm64 && SHA256_HEX.test(agentSha256.arm64)) job.agentArm64Digest = agentSha256.arm64;
  return job;
}

/**
 * The APPLY half of self-update. `requestUpdate` is the single gate choke-point: it re-verifies the signed
 * manifest fresh (never applies from a stale/unverified cache), refuses any downgrade / channel-skip, limits
 * AUTO updates to patch bumps, and serializes concurrent updates with a Redis lock — only then does it queue
 * the job for the sidecar. Nothing here runs docker; the sidecar does the pull/recreate.
 */
@Injectable()
export class UpdaterService {
  private readonly logger = new Logger(UpdaterService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly update: UpdateService,
    private readonly inFlight: InFlightService,
  ) {}

  /**
   * `force` updates through work in flight (the caller must already be an instance owner; the controller audits it). Without it, a
   * hub update never starts while a migration, takeover, cutover, move, transfer or cleanup is running: the answer is `held` with the list.
   */
  async requestUpdate({ actor, auto, force = false }: { actor: string; auto: boolean; force?: boolean }): Promise<UpdateApplyResult> {
    // Re-verify the signed manifest at apply time — never trust a possibly-stale cache.
    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { status: verified.status, targetVersion: null };

    const latest = verified.entry.version;
    const current = appVersion();

    // Downgrade guard — the anchor is the RUNNING build. A signed-but-older manifest never applies.
    if (!isNewer(latest, current)) return { status: "up-to-date", targetVersion: latest };
    // Refuse to skip past a required intermediate release. A present-but-unparseable minUpgradeFrom (a
    // publisher typo like "v1.9") fails SAFE — we cannot confirm the instance is new enough to jump directly,
    // so we refuse, matching every other version gate rather than silently skipping the bridge.
    const minUpgrade = verified.entry.minUpgradeFrom;
    if (minUpgrade && (!parseVersion(minUpgrade) || isNewer(minUpgrade, current))) {
      return { status: "needs-intermediate", targetVersion: latest };
    }
    // AUTO applies a patch bump, or the next prerelease of the same family (beta.N → beta.N+1); minor/major and
    // prerelease → stable are notify-only (never silently applied).
    if (auto && !isAutoApplicable(latest, current)) return { status: "notify-only", targetVersion: latest };

    // Nothing may be cut off mid-run. Checked after every "nothing to do" answer (an up-to-date hub is never "held"), before the lock.
    let running: InFlightItem[];
    try {
      running = await this.inFlight.list();
    } catch (e) {
      // Cannot tell what is running: do not update blind. (A forced update goes on: the owner already chose to.)
      this.logger.warn(`could not read what is in flight: ${String((e as Error)?.message ?? e)}`);
      if (!force) return { status: "error", targetVersion: latest };
      running = [];
    }
    if (running.length > 0 && !force) return { status: "held", targetVersion: latest, inFlight: running };

    // Take the lock LAST so a rejected request never leaves one behind. The TTL is a backstop if the sidecar dies.
    const acquired = await this.redis.firstInWindow(LOCK_KEY, LOCK_TTL_S);
    if (!acquired) return { status: "in-progress", targetVersion: latest };

    await this.redis.set(
      STATUS_KEY,
      JSON.stringify({ phase: "queued", targetVersion: latest, error: null, actor, startedAt: new Date().toISOString() }),
      STATUS_TTL_S,
    );
    await this.redis.client.lpush(QUEUE_KEY, JSON.stringify(buildUpdateJob(latest, verified.entry.imageDigests, verified.entry.hostFilesDigest, verified.entry.agentSha256)));
    this.logger.log(`update requested by ${actor} (auto=${auto}): ${current} → ${latest}`);
    return { status: "started", targetVersion: latest, ...(running.length > 0 ? { overridden: running } : {}) };
  }

  /** The scheduler holds an automatic update back: remember since when and by what (never throws: this is bookkeeping). */
  async recordHold(items: InFlightItem[]): Promise<void> {
    try {
      const prev = await this.getHold();
      const now = new Date().toISOString();
      const hold: UpdateHoldView = { since: prev?.since ?? now, checkedAt: now, items };
      await this.redis.set(UPDATE_HOLD_KEY, JSON.stringify(hold), HOLD_TTL_S);
    } catch (e) {
      this.logger.warn(`could not record the update hold: ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** The hold ended (nothing in flight any more, or the update started). */
  async clearHold(): Promise<void> {
    try {
      await this.redis.del(UPDATE_HOLD_KEY);
    } catch {
      /* bookkeeping only */
    }
  }

  /** The recorded hold, or null. */
  async getHold(): Promise<UpdateHoldView | null> {
    try {
      const raw = await this.redis.get(UPDATE_HOLD_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw) as Partial<UpdateHoldView>;
      if (typeof p.since !== "string" || typeof p.checkedAt !== "string" || !Array.isArray(p.items)) return null;
      return { since: p.since, checkedAt: p.checkedAt, items: p.items };
    } catch {
      return null;
    }
  }

  /** What is running on the hub right now (live read). */
  listInFlight(): Promise<InFlightItem[]> {
    return this.inFlight.list();
  }

  /** The half-finished update the sidecar reported (null = none). The running version is this hub's own, not the stored one. */
  async getHalfUpdate(): Promise<HalfUpdateView | null> {
    return mapHalfState(await this.redis.get(UPDATE_HALF_STATE_KEY), appVersion());
  }

  /** Current progress (read-only) for the SSE + any reconnecting client. */
  async getProgress(): Promise<UpdateProgress> {
    return mapStatus(await this.redis.get(STATUS_KEY));
  }
}
