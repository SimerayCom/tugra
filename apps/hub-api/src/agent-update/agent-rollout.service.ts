import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ServerStatus } from "@prisma/client";
import { appVersion, isNewer } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { UpdateService } from "../update/update.service";
import { AgentUpdateService, outdatedAgents } from "./agent-update.service";

/** How often the rollout looks at the fleet. */
const TICK_MS = 60_000;
/** An agent that was sent an update and still reports the old version after this long counts as a failed attempt. */
const SETTLE_MS = 10 * 60_000;
/** After this many failed attempts at one release an agent is left alone until the hub restarts (it stays in the notice). */
const MAX_ATTEMPTS = 3;

export type RolloutOutcome =
  | { action: "off" } // "Apply updates automatically" is off
  | { action: "idle" } // nothing is behind the hub
  | { action: "waiting-hub" } // the published release is newer than this hub: the hub updates first
  | { action: "waiting-agent"; serverId: string } // the previous agent has not come back on the new version yet
  | { action: "sent"; serverId: string }
  | { action: "unavailable" }; // no verified manifest right now

interface Pending {
  version: string;
  at: number;
}

/**
 * Automatic agent rollout. With "Apply updates automatically" on, once the hub itself runs the published release the
 * remote agents that are still on an older one are updated ONE AT A TIME through the same signed, digest-pinned path
 * as the manual "Update agent" button (the version, image and sha256 come only from the verified manifest). The next
 * agent is started only after the previous one reconnected on the new version (or gave up after SETTLE_MS), so a bad
 * release can never take the whole fleet offline at once. The hub's own box is left to the stack converge that
 * follows a hub update. State is in memory on purpose: after a hub restart the loop simply re-reads the DB.
 */
@Injectable()
export class AgentRolloutService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentRolloutService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private pending: (Pending & { serverId: string }) | null = null;
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly update: UpdateService,
    private readonly agentUpdate: AgentUpdateService,
    private readonly settings: InstanceSettingsService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    this.timer = setInterval(() => void this.safeTick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async safeTick(): Promise<void> {
    if (this.running) return; // never overlap two passes
    this.running = true;
    try {
      const r = await this.tick();
      if (r.action === "sent") this.logger.log(`agent rollout: update sent to ${r.serverId}`);
    } catch (e) {
      this.logger.warn(`agent rollout pass failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass: at most one agent is started. Exposed for tests. */
  async tick(now: number = Date.now()): Promise<RolloutOutcome> {
    let autoUpdate = false;
    try {
      autoUpdate = (await this.settings.get()).autoUpdate;
    } catch {
      return { action: "off" }; // a transient DB error just skips this round
    }
    if (!autoUpdate) {
      this.pending = null;
      return { action: "off" };
    }
    const hub = appVersion();
    const servers = await this.prisma.server.findMany({
      where: { isLocal: false, status: { not: ServerStatus.PENDING } },
      select: { id: true, teamId: true, arch: true, agentVersion: true, status: true },
    });
    const behind = outdatedAgents(servers, hub);
    if (behind.length === 0) {
      this.pending = null;
      return { action: "idle" };
    }

    // One at a time: wait for the agent we already sent an update to, unless it came back current or ran out of time.
    if (this.pending) {
      const p = this.pending;
      const stillBehind = behind.some((s) => s.id === p.serverId);
      if (stillBehind && now - p.at < SETTLE_MS) return { action: "waiting-agent", serverId: p.serverId };
      if (stillBehind) this.attempts.set(`${p.serverId}@${p.version}`, (this.attempts.get(`${p.serverId}@${p.version}`) ?? 0) + 1);
      this.pending = null;
    }

    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { action: "unavailable" };
    // Agents never run ahead of the hub: wait until the hub is on the published release (or newer than it).
    if (isNewer(verified.entry.version, hub)) return { action: "waiting-hub" };

    // Fewest failed attempts first: an agent that did not come back goes to the back of the line instead of
    // holding up the rest of the fleet.
    const tries = (id: string) => this.attempts.get(`${id}@${verified.entry.version}`) ?? 0;
    const candidate = behind
      .filter((s) => s.status === ServerStatus.ONLINE && tries(s.id) < MAX_ATTEMPTS)
      .sort((x, y) => tries(x.id) - tries(y.id))[0];
    if (!candidate) return { action: "idle" };

    const res = await this.agentUpdate.applyAuto(candidate, verified.entry);
    const key = `${candidate.id}@${verified.entry.version}`;
    if (res.status === "sent") {
      this.pending = { serverId: candidate.id, version: verified.entry.version, at: now };
      return { action: "sent", serverId: candidate.id };
    }
    // Skipped or offline: count it so this agent cannot stall the loop; the next pass tries the next one.
    this.attempts.set(key, res.status === "skipped" ? MAX_ATTEMPTS : (this.attempts.get(key) ?? 0) + 1);
    return { action: "idle" };
  }
}
