import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException, AgentCommandTimeoutException } from "../agent-gateway/agent-offline.exception";
import { NotificationsService } from "../notifications/notifications.service";
import { type DbEngine } from "../databases/database-script";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { scrubRunOutput } from "./backup-script";
import { buildWalListScript, buildWalShipScript, isShippableWalName, parseWalList, parseWalShipped } from "./wal-ship-script";

const WALSHIP_TIMEOUT_MS = 300_000; // one tick's list + ship command budget
const WAL_SHIP_BATCH = 200; // segments shipped per tick (catch-up spans ticks; keeps output under the 64KB cap)
/** Backlog (segments still unshipped after a tick) above which we alert even when the tick itself did not fail —
 *  a destination/agent that is reachable but slow still risks filling the host disk. ~200 × 16MB ≈ 3 GiB. */
const WAL_BACKLOG_ALERT = 200;

export interface ShipResult {
  shipped: number;
  failed: number;
  backlog: number;
  skipped?: boolean;
}

/**
 * Drains each PITR-enabled Postgres database's host WAL spool to its backup destination (PITR 5.5). Mirrors
 * BaseBackupRunnerService: injects BackupRunnerService for destination/credential resolution — never the
 * reverse — so the DI graph stays acyclic, and never touches prisma.backup/baseBackup. INERT until a database
 * is actually PITR-enabled: shipAll selects only rows with pitrEnabled && pitrEnabledAt set, and nothing stamps
 * pitrEnabledAt until the enable endpoint lands (next slice), so in production this is a no-op today.
 */
@Injectable()
export class WalShipperRunnerService {
  private readonly logger = new Logger(WalShipperRunnerService.name);
  // Per-db overlap guard: a global sweep must never run two shipOnce for the same db concurrently (the second
  // would try to re-upload/delete a segment the first is mid-ship on).
  private readonly inflight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentWs: AgentWsServer,
    private readonly runner: BackupRunnerService,
    private readonly alerts: BackupAlertsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Ship every enabled database once. Each db is isolated in its own try/catch so one offline agent or one
   *  bad spool never stalls the rest of the fleet. */
  async shipAll(): Promise<void> {
    const rows = await this.prisma.database.findMany({
      where: { engine: "POSTGRES", pitrEnabled: true, pitrEnabledAt: { not: null } },
      select: { id: true },
    });
    for (const { id } of rows) {
      try {
        await this.shipOnce(id);
      } catch (e) {
        this.logger.warn(`wal ship for database ${id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * List and drain one database's spool. Transient agent conditions (offline / capability not granted /
   * command timeout) are swallowed into {skipped} — the spool simply accumulates and the next tick retries —
   * so the scheduled job is never retry-spammed; any other error propagates to shipAll's per-db guard.
   */
  async shipOnce(databaseId: string): Promise<ShipResult> {
    const db = await this.prisma.database.findUnique({ where: { id: databaseId } });
    if (!db || !db.pitrEnabled || !db.pitrEnabledAt || (db.engine as DbEngine) !== "POSTGRES") {
      return { shipped: 0, failed: 0, backlog: 0, skipped: true };
    }
    if (this.inflight.has(databaseId)) return { shipped: 0, failed: 0, backlog: 0, skipped: true };
    this.inflight.add(databaseId);

    // Everything below runs inside the try so the finally ALWAYS releases the inflight lock — destinationSpecById
    // decrypts the destination's creds and can throw (a rotated/corrupt key), and a leaked lock would silently
    // stop this db from ever being shipped again until a hub restart.
    try {
      const dest = await this.runner.destinationSpecById(db.backupDestinationId);
      let dbPassword: string | undefined;
      try {
        dbPassword = this.runner.toSpec(db).credentials.password;
      } catch {
        /* undecryptable creds → nothing to redact; the ship below will surface its own error */
      }
      const secrets = [dbPassword, dest.s3?.accessKey, dest.s3?.secretKey, dest.encryption?.key];
      const ctx = {
        dbId: db.id,
        dbName: `${db.name} (WAL)`,
        engine: db.engine,
        version: db.version,
        destType: dest.type,
        bucket: dest.type === "S3" && dest.s3 ? dest.s3.bucket : "",
        region: dest.type === "S3" && dest.s3 ? dest.s3.region : "",
      };

      try {
        const listed = parseWalList(
          (await this.agentWs.sendCommand(db.serverId, buildWalListScript(db.id), "backup", WALSHIP_TIMEOUT_MS)).output,
        );
        // Re-validate every name on the hub before it reaches a root shell (defence in depth with the agent-side
        // allow-list); anything that does not match a WAL-name shape is dropped and logged, never shipped.
        const valid = listed.entries.filter((e) => isShippableWalName(e.name));
        const dropped = listed.entries.length - valid.length;
        if (dropped > 0) {
          this.logger.warn(`wal ship for database ${db.id}: dropped ${dropped} unshippable spool name(s)`);
        }
        if (valid.length === 0) {
          // An empty spool is a clean drain; a spool that holds ONLY foreign/invalid files is not — surface it
          // as backlog (and do not clear the alert state), so it does not read as healthy.
          if (listed.total > 0) return { shipped: 0, failed: 0, backlog: listed.total };
          await this.alerts.recover("walship", db.id, db.teamId, ctx).catch(() => undefined);
          return { shipped: 0, failed: 0, backlog: 0 };
        }
        // Ship in WAL order (sort hub-side so order never depends on the agent shell's locale).
        const batch = valid
          .slice(0, WAL_SHIP_BATCH)
          .map((e) => e.name)
          .sort();
        const shipOut = await this.agentWs.sendCommand(
          db.serverId,
          buildWalShipScript(db.id, batch, dest),
          "backup",
          WALSHIP_TIMEOUT_MS,
        );
        const { shipped, failed } = parseWalShipped(shipOut.output);
        const backlog = Math.max(0, listed.total - shipped.length);
        // A non-zero exit with no FAIL marker (the script was killed, hit a syntax error, or its output was
        // truncated past the agent's 64KB cap) is STILL a failure — never treat it as a clean partial tick.
        const scriptFailed = failed.length > 0 || shipOut.exitCode !== 0;

        if (scriptFailed || backlog > WAL_BACKLOG_ALERT) {
          if (await this.alerts.shouldNotifyFailure("walship", db.id)) {
            const tail = scriptFailed
              ? scrubRunOutput(shipOut.output, secrets)
              : `WAL backlog ${backlog} segment(s) not yet shipped to ${dest.type}`;
            await this.notifications.fireForEvent(db.teamId, "backup_failed", { ...ctx, errorTail: tail }).catch(() => undefined);
          }
        } else if (backlog === 0) {
          await this.alerts.recover("walship", db.id, db.teamId, ctx).catch(() => undefined);
        }
        return { shipped: shipped.length, failed: failed.length, backlog };
      } catch (e) {
        // A clean offline / capability-not-granted is transient — skip and retry next tick (never retry-spam).
        if (e instanceof AgentOfflineException || e instanceof ForbiddenException) {
          this.logger.warn(`wal ship for database ${db.id} skipped: ${e.message}`);
          return { shipped: 0, failed: 0, backlog: 0, skipped: true };
        }
        // A TIMEOUT is a stuck/hung upload, not a clean offline: it would grow the spool silently, so raise the
        // throttled failure alert (≤1/24h) instead of skipping quietly.
        if (e instanceof AgentCommandTimeoutException) {
          this.logger.warn(`wal ship for database ${db.id} timed out`);
          if (await this.alerts.shouldNotifyFailure("walship", db.id)) {
            await this.notifications
              .fireForEvent(db.teamId, "backup_failed", { ...ctx, errorTail: `WAL shipping to ${dest.type} timed out` })
              .catch(() => undefined);
          }
          return { shipped: 0, failed: 0, backlog: 0, skipped: true };
        }
        throw e;
      }
    } finally {
      this.inflight.delete(databaseId);
    }
  }
}
