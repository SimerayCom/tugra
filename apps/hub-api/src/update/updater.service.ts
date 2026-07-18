import { Injectable, Logger } from "@nestjs/common";
import { appVersion, isNewer, isPatchUpgrade, parseVersion } from "@tugra/shared";
import { RedisService } from "../redis/redis.service";
import { UpdateService } from "./update.service";
import type { UpdateApplyResult, UpdateProgress } from "./dto";

// The hub cannot recreate its own container, so it never runs docker. Instead it takes a cross-process
// lock and LPUSHes a job onto a Redis queue that the `tugra-updater` sidecar (docker.sock) drains; the
// sidecar reports progress back into the status key. All three keys live in Redis so they survive the
// hub-api container being recreated mid-update.
const LOCK_KEY = "instance:update:lock";
const STATUS_KEY = "instance:update:status";
const QUEUE_KEY = "instance:update:queue";
const LOCK_TTL_S = 900; // 15-min backstop; the sidecar releases the lock on any terminal status
const STATUS_TTL_S = 3600; // must outlive the recreate so a reconnecting client can read the final state

const TERMINAL_PHASES: readonly UpdateProgress["phase"][] = ["done", "failed"];

/** Whether a progress phase is terminal (the SSE completes here). Pure — unit-tested directly. */
export function isTerminalPhase(phase: UpdateProgress["phase"]): boolean {
  return TERMINAL_PHASES.includes(phase);
}

/** Parse the Redis status blob into a UpdateProgress; "idle" when absent or unparseable. Pure. */
export function mapStatus(raw: string | null): UpdateProgress {
  if (!raw) return { phase: "idle", targetVersion: null, error: null };
  try {
    const p = JSON.parse(raw) as Partial<UpdateProgress>;
    const phases: UpdateProgress["phase"][] = ["idle", "queued", "pulling", "recreating", "done", "failed"];
    return {
      phase: typeof p.phase === "string" && phases.includes(p.phase) ? p.phase : "idle",
      targetVersion: typeof p.targetVersion === "string" ? p.targetVersion : null,
      error: typeof p.error === "string" ? p.error : null,
    };
  } catch {
    return { phase: "idle", targetVersion: null, error: null };
  }
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
  ) {}

  async requestUpdate({ actor, auto }: { actor: string; auto: boolean }): Promise<UpdateApplyResult> {
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
    // Auto-update applies PATCH bumps only; a minor/major is notify-only (never silently applied).
    if (auto && !isPatchUpgrade(latest, current)) return { status: "notify-only", targetVersion: latest };

    // Take the lock LAST so a rejected request never leaves one behind. The TTL is a backstop if the sidecar dies.
    const acquired = await this.redis.firstInWindow(LOCK_KEY, LOCK_TTL_S);
    if (!acquired) return { status: "in-progress", targetVersion: latest };

    await this.redis.set(
      STATUS_KEY,
      JSON.stringify({ phase: "queued", targetVersion: latest, error: null, actor, startedAt: new Date().toISOString() }),
      STATUS_TTL_S,
    );
    await this.redis.client.lpush(QUEUE_KEY, JSON.stringify({ targetVersion: latest }));
    this.logger.log(`update requested by ${actor} (auto=${auto}): ${current} → ${latest}`);
    return { status: "started", targetVersion: latest };
  }

  /** Current progress (read-only) for the SSE + any reconnecting client. */
  async getProgress(): Promise<UpdateProgress> {
    return mapStatus(await this.redis.get(STATUS_KEY));
  }
}
