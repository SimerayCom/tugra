import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ServerStatus } from "@prisma/client";
import { appVersion, isNewer } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { UpdateService } from "../update/update.service";
import { AgentUpdateService, outdatedAgents } from "./agent-update.service";
import { InFlightService } from "../in-flight/in-flight.service";
import type { InFlightItem } from "../in-flight/in-flight.dto";

/** How often the rollout looks at the fleet. */
const TICK_MS = 60_000;
/** An agent that was sent an update and still reports the old version after this long counts as a failed attempt. */
const SETTLE_MS = 10 * 60_000;
/** After this many update requests at one release within ATTEMPT_WINDOW_MS an agent is left alone (it stays in the notice). */
const MAX_ATTEMPTS = 3;
/** Requests older than this no longer count, so an agent that was unreachable for a day is tried again. */
const ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
/** A refused update (capability not granted) is retried after this long, so granting it later takes effect. */
const SKIP_RETRY_MS = 60 * 60_000;
/** An agent that went offline between the check and the send is retried after this long. */
const OFFLINE_RETRY_MS = 5 * 60_000;

export type RolloutOutcome =
  | { action: "off" } // "Apply updates automatically" is off
  | { action: "idle" } // nothing is behind the hub, or nothing can be updated right now
  | { action: "waiting-hub" } // the published release is newer than this hub: the hub updates first
  | { action: "waiting-agent"; serverId: string } // the previous agent has not come back on the new version yet
  | { action: "held"; held: { serverId: string; inFlight: InFlightItem[] }[] } // every server still to update has work in flight (migration, takeover, cutover, move, transfer)
  | { action: "sent"; serverId: string }
  | { action: "unavailable" }; // no verified manifest right now

@Injectable()
export class AgentRolloutService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AgentRolloutService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** serverId -> epoch ms before which the agent is not tried again (refused or went offline just now). */
  private readonly retryAfter = new Map<string, number>();
  /** The held set last logged, so a long migration logs once and not every minute. */
  private heldLogged = "";

  constructor(
    private readonly prisma: PrismaService,
    private readonly update: UpdateService,
    private readonly agentUpdate: AgentUpdateService,
    private readonly settings: InstanceSettingsService,
    private readonly inFlightSvc: InFlightService,
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

  private logHeld(busy: Map<string, InFlightItem[]>): void {
    const key = [...busy].map(([id, items]) => `${id}:${items.map((i) => i.id).sort().join("+")}`).sort().join(",");
    if (key === this.heldLogged) return;
    this.heldLogged = key;
    if (key) this.logger.log(`agent rollout: skipping ${busy.size} server(s) with work in flight (${[...busy].map(([id, items]) => `${id}: ${items.map((i) => `${i.kind}:${i.id}`).join(" ")}`).join("; ")})`);
  }

  /** One pass: at most one agent is started. Exposed for tests. */
  async tick(now: number = Date.now()): Promise<RolloutOutcome> {
    let autoUpdate = false;
    try {
      autoUpdate = (await this.settings.get()).autoUpdate;
    } catch {
      return { action: "off" }; // a transient DB error just skips this round
    }
    if (!autoUpdate) return { action: "off" };
    const hub = appVersion();
    const servers = await this.prisma.server.findMany({
      where: { isLocal: false, status: { not: ServerStatus.PENDING } },
      select: { id: true, teamId: true, arch: true, agentVersion: true, status: true },
    });
    const behind = outdatedAgents(servers, hub);
    if (behind.length === 0) return { action: "idle" };

    // Never restart an agent in the middle of a migration, takeover, cutover, move or transfer on its server: those servers sit out
    // (the fleet status lists them with the reason), the others carry on. If the work cannot be read, nobody is updated this pass.
    let busy: Map<string, InFlightItem[]>;
    try {
      busy = InFlightService.byServer(await this.inFlightSvc.list(), behind.map((s) => s.id));
    } catch {
      return { action: "unavailable" };
    }
    this.logHeld(busy);

    // What was already sent, from the audit trail (survives a hub restart and also counts manual updates).
    const requests = await this.prisma.auditLog.findMany({
      where: {
        action: "agent.update.request",
        target: { in: behind.map((s) => s.id) },
        createdAt: { gte: new Date(now - ATTEMPT_WINDOW_MS) },
      },
      select: { target: true, createdAt: true, meta: true },
    });
    // One at a time: wait for an agent that was sent an update a moment ago and has not come back on the new version.
    const inFlight = requests.find((r) => r.target && now - r.createdAt.getTime() < SETTLE_MS);
    if (inFlight?.target) return { action: "waiting-agent", serverId: inFlight.target };

    // Agents never run ahead of the hub: while the published release (cached, no network) is newer, the hub goes first.
    if ((await this.update.getStatus()).updateAvailable) return { action: "waiting-hub" };

    // Fewest requests first: an agent that did not come back goes to the back of the line instead of holding up the rest.
    const tries = (id: string) =>
      requests.filter((r) => r.target === id && (r.meta as { to?: string } | null)?.to === hub).length;
    const candidate = behind
      .filter((s) => !busy.has(s.id) && s.status === ServerStatus.ONLINE && tries(s.id) < MAX_ATTEMPTS && (this.retryAfter.get(s.id) ?? 0) <= now)
      .sort((x, y) => tries(x.id) - tries(y.id))[0];
    if (!candidate) {
      const held = [...busy].map(([serverId, inFlight]) => ({ serverId, inFlight }));
      // Nobody to update now; when the only ones left are held, say so (the manifest is not fetched either way).
      return held.length > 0 && !behind.some((s) => !busy.has(s.id) && s.status === ServerStatus.ONLINE && tries(s.id) < MAX_ATTEMPTS) ? { action: "held", held } : { action: "idle" };
    }

    const verified = await this.update.verifyLatestEntry();
    if (verified.status !== "ok") return { action: "unavailable" };
    if (isNewer(verified.entry.version, hub)) return { action: "waiting-hub" };

    const res = await this.agentUpdate.applyAuto(candidate, verified.entry);
    if (res.status === "sent") {
      this.retryAfter.delete(candidate.id);
      return { action: "sent", serverId: candidate.id };
    }
    // Skipped or offline: back off so this agent cannot stall the loop; the next pass tries the next one.
    this.retryAfter.set(candidate.id, now + (res.status === "skipped" ? SKIP_RETRY_MS : OFFLINE_RETRY_MS));
    return { action: "idle" };
  }
}
