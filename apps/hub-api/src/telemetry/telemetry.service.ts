import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { appVersion, releaseChannel } from "@tugra/shared";
import { currentEdition } from "../common/edition";
import { PrismaService } from "../prisma/prisma.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";

/** The exact anonymous payload sent to the telemetry endpoint — ALSO returned to the owner UI verbatim so
 *  what is shown is byte-for-byte what is sent (no hidden fields). Every field is a coarse aggregate or a
 *  random id: there is deliberately NO IP, hostname, domain, public URL, app/server name, email or any
 *  user-identifying value anywhere in this shape. */
export interface TelemetryPayload {
  instanceId: string; // random, anonymous, stable across restarts — the only identifier
  version: string; // e.g. "0.1.0"
  channel: string; // "stable" | "beta" | "dev"
  edition: string; // "community" | "pro" | "cloud"
  platform: string; // process.platform, e.g. "linux" (coarse)
  arch: string; // process.arch, e.g. "x64" (coarse)
  nodeMajor: number; // Node.js major only, e.g. 22 (never the full version string)
  counts: {
    servers: number;
    applications: number;
    databases: number;
    deployments: number;
    teams: number;
    users: number;
    clusters: number;
    monitors: number;
    containers: number; // floor estimate (applications + databases); no Container table to count exactly
  };
  sentAt: string; // ISO timestamp, set when the payload is built
}

export interface TelemetryStatus {
  enabled: boolean; // effective: on AND not env-forced-off
  forcedOff: boolean; // env TUGRA_TELEMETRY=0 — the owner toggle is then inert
  dbEnabled: boolean; // the raw owner-UI toggle value (telemetryEnabled)
  instanceId: string | null; // null until first minted
  lastSentAt: string | null;
  intervalMin: number;
  endpoint: string;
  payload: TelemetryPayload; // a live preview of exactly what would be sent
}

const SEND_TIMEOUT_MS = 10_000;

/**
 * Anonymous usage stats — ON by default, opt-out. Collects only coarse aggregate counts + build metadata
 * under a random instance id (see TelemetryPayload). Two independent off-switches, both honoured here:
 *  - env TUGRA_TELEMETRY=0  → HARD off (deployment decision: install --no-telemetry / headless CI). The
 *    scheduler never even starts, so a forced-off box makes ZERO outbound calls.
 *  - owner-UI toggle (DB telemetryEnabled) → runtime off, flippable without a restart; each send re-checks.
 * The sender NEVER throws and never blocks anything — an unreachable endpoint silently skips the round.
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly settings: InstanceSettingsService,
  ) {}

  /** A deployment-level hard off: the owner-UI toggle cannot re-enable telemetry while this is set. */
  isForcedOff(): boolean {
    return this.config.get<string>("TUGRA_TELEMETRY") === "0";
  }

  /** Effective state: on only when NOT env-forced-off AND the owner toggle is on (DB default true). */
  async isEnabled(): Promise<boolean> {
    if (this.isForcedOff()) return false;
    const s = await this.settings.get();
    return s.telemetryEnabled;
  }

  endpoint(): string {
    return this.config.get<string>("TUGRA_TELEMETRY_URL")!;
  }

  intervalMin(): number {
    return this.config.get<number>("TUGRA_TELEMETRY_INTERVAL_MIN") ?? 1440;
  }

  /** The anonymous instance id, minted once on first access and persisted. Stable across restarts. */
  async getInstanceId(): Promise<string> {
    const s = await this.settings.get();
    if (s.telemetryInstanceId) return s.telemetryInstanceId;
    // Atomic compare-and-set: the `WHERE telemetryInstanceId IS NULL` means only the first racer's id
    // sticks, so two concurrent first-time callers can never end up sending two different ids.
    const id = randomUUID();
    await this.prisma.instanceSettings.updateMany({
      where: { id: "singleton", telemetryInstanceId: null },
      data: { telemetryInstanceId: id },
    });
    const after = await this.settings.get(); // re-read the persisted value (ours, or the racer's that won)
    return after.telemetryInstanceId ?? id;
  }

  /** Rotate to a fresh anonymous id (owner "reset identity" action). Returns the new id. */
  async resetInstanceId(): Promise<string> {
    const id = randomUUID();
    await this.settings.update({ telemetryInstanceId: id });
    return id;
  }

  /** Build the exact payload that would be sent. Pure read; does not send. Container count is a documented
   *  floor estimate (applications + databases) since there is no Container table to count precisely. Pass
   *  `instanceId` to render a preview WITHOUT minting a new id (e.g. status() when telemetry is off);
   *  omit it on the real send path, where the id is minted on first use. */
  async buildPayload(instanceId?: string): Promise<TelemetryPayload> {
    const [servers, applications, databases, deployments, teams, users, clusters, monitors] =
      await this.prisma.$transaction([
        this.prisma.server.count(),
        this.prisma.application.count(),
        this.prisma.database.count(),
        this.prisma.deployment.count(),
        this.prisma.team.count(),
        this.prisma.user.count(),
        this.prisma.cluster.count(),
        this.prisma.monitor.count(),
      ]);
    const id = instanceId ?? (await this.getInstanceId());
    const nodeMajor = Number(process.versions.node.split(".")[0]) || 0;
    return {
      instanceId: id,
      version: appVersion(),
      channel: releaseChannel(),
      edition: currentEdition(),
      platform: process.platform,
      arch: process.arch,
      nodeMajor,
      counts: {
        servers,
        applications,
        databases,
        deployments,
        teams,
        users,
        clusters,
        monitors,
        containers: applications + databases,
      },
      sentAt: new Date().toISOString(),
    };
  }

  /**
   * Send one anonymous stats ping if enabled. Fail-closed + fail-soft: returns `disabled` (and sends
   * NOTHING) when either off-switch is set, `error` on any network/HTTP/DB failure, `sent` on 2xx. Records
   * telemetryLastSentAt only on a real delivery. NEVER throws — the ENTIRE body (including the isEnabled DB
   * read) is guarded, so a DB blip fails closed to `error` instead of propagating out of a scheduler.
   */
  async sendNow(): Promise<{ status: "sent" | "disabled" | "error" }> {
    try {
      if (!(await this.isEnabled())) return { status: "disabled" };
      const payload = await this.buildPayload();
      if (!(await this.postPayload(payload))) return { status: "error" };
      // Record the delivery OUTSIDE the network try: a DB write blip here must NOT downgrade a ping that
      // was actually delivered to `error` (that would make the next boot re-send).
      try {
        await this.settings.update({ telemetryLastSentAt: new Date() });
      } catch (e) {
        this.logger.warn(`telemetry lastSentAt write failed (ping was delivered): ${e instanceof Error ? e.message : e}`);
      }
      return { status: "sent" };
    } catch (e) {
      this.logger.warn(`telemetry sendNow error: ${e instanceof Error ? e.message : e}`);
      return { status: "error" };
    }
  }

  /** POST the payload with a hard timeout. Returns whether it was delivered (2xx); never throws. */
  private async postPayload(payload: TelemetryPayload): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`telemetry send got HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      // Offline / DNS failure / timeout / endpoint down — expected; never surfaced, never retried hard.
      this.logger.debug?.(`telemetry send skipped: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Owner-facing status + a live preview of the exact payload. Does NOT mint an id as a side effect:
   *  when none exists yet, the preview shows a placeholder, so merely opening Settings never creates one. */
  async status(): Promise<TelemetryStatus> {
    const s = await this.settings.get();
    const payload = await this.buildPayload(s.telemetryInstanceId ?? "(generated on first send)");
    return {
      enabled: !this.isForcedOff() && s.telemetryEnabled,
      forcedOff: this.isForcedOff(),
      dbEnabled: s.telemetryEnabled,
      instanceId: s.telemetryInstanceId,
      lastSentAt: s.telemetryLastSentAt ? s.telemetryLastSentAt.toISOString() : null,
      intervalMin: this.intervalMin(),
      endpoint: this.endpoint(),
      payload,
    };
  }

  /** Set the owner-UI toggle (does not affect the env hard-off). */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.settings.update({ telemetryEnabled: enabled });
  }
}
