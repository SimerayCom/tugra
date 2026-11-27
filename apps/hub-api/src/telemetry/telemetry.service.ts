import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { appVersion, releaseChannel } from "@tugra/shared";
import { currentEdition } from "../common/edition";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";
import { InstanceSettingsService } from "../instance/instance-settings.service";

/** Wire format version of the stats report. */
export const STATS_REPORT_VERSION = 1;
/** Request header that carries base64url(ed25519 signature over the exact raw request body). */
export const STATS_SIGNATURE_HEADER = "x-tugra-signature";
/** Shown in the owner preview until the identity exists (opening Settings never creates one). */
export const PENDING_IDENTITY = "(generated on first send)";

/** The hub's stats identity: an ed25519 key pair generated once. */
export interface HubIdentity {
  hubId: string; // first 32 hex chars of sha256(raw 32-byte public key)
  publicKey: string; // base64url raw 32-byte ed25519 public key
}

/** Derive the public identity (id + raw public key) from an ed25519 public key's raw bytes. */
export function identityFromRawPublicKey(raw: Buffer): HubIdentity {
  return { hubId: createHash("sha256").update(raw).digest("hex").slice(0, 32), publicKey: raw.toString("base64url") };
}

/** The exact anonymous report sent to the stats endpoint — ALSO returned to the owner UI verbatim so what is
 *  shown is byte-for-byte what is sent (no hidden fields). Every field is a coarse aggregate or the hub id:
 *  there is deliberately NO IP, hostname, domain, public URL, app/server name, email or any other
 *  user-identifying value anywhere in this shape. */
export interface TelemetryPayload {
  v: number; // wire format version
  hubId: string; // first 32 hex chars of sha256(public key) — the only identifier
  publicKey: string; // base64url raw ed25519 public key (lets the receiver verify the signature)
  sentAt: string; // ISO timestamp, set when the payload is built
  version: string; // e.g. "0.1.0"
  counts: {
    servers: number;
    applications: number; // apps that are not compose stacks
    databases: number;
    services: number; // compose stacks
    teams: number;
    users: number;
  };
  features: {
    channel: string; // "stable" | "beta" | "dev"
    edition: string; // "community" | "pro" | "cloud"
    platform: string; // process.platform, e.g. "linux" (coarse)
    arch: string; // process.arch, e.g. "x64" (coarse)
    nodeMajor: number; // Node.js major only, e.g. 22 (never the full version string)
    deployments: number;
    clusters: number;
    monitors: number;
  };
}

export interface TelemetryStatus {
  enabled: boolean; // effective: on AND not env-forced-off
  forcedOff: boolean; // env TUGRA_STATS=0 (or legacy TUGRA_TELEMETRY=0) — the owner toggle is then inert
  dbEnabled: boolean; // the raw owner-UI toggle value (telemetryEnabled)
  hubId: string | null; // null until the identity is first generated
  lastSentAt: string | null;
  intervalMin: number;
  endpoint: string;
  payload: TelemetryPayload; // a live preview of exactly what would be sent
}

const SEND_TIMEOUT_MS = 10_000;

/**
 * Anonymous usage stats — ON by default, opt-out. Collects only coarse aggregate counts + build metadata
 * under a hub id derived from an ed25519 public key (see TelemetryPayload); every report is signed with the
 * matching private key. Two independent off-switches, both honoured here:
 *  - env TUGRA_STATS=0 (legacy TUGRA_TELEMETRY=0) → HARD off (deployment decision: install --no-telemetry / headless CI). The
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
    private readonly crypto: CryptoService,
  ) {}

  /** A deployment-level hard off: the owner-UI toggle cannot re-enable the stats while either variable is "0". */
  isForcedOff(): boolean {
    return this.config.get<string>("TUGRA_STATS") === "0" || this.config.get<string>("TUGRA_TELEMETRY") === "0";
  }

  /** Effective state: on only when NOT env-forced-off AND the owner toggle is on (DB default true). */
  async isEnabled(): Promise<boolean> {
    if (this.isForcedOff()) return false;
    const s = await this.settings.get();
    return s.telemetryEnabled;
  }

  endpoint(): string {
    return this.config.get<string>("TUGRA_TELEMETRY_URL") || this.config.get<string>("TUGRA_STATS_URL")!;
  }

  intervalMin(): number {
    return this.config.get<number>("TUGRA_TELEMETRY_INTERVAL_MIN") ?? this.config.get<number>("TUGRA_STATS_INTERVAL_MIN") ?? 1440;
  }

  /** The hub identity, generated once on first use and persisted (public key plain, private key sealed with
   *  the secrets key). Race-safe: the loser of a concurrent first call re-reads the winner's key pair. */
  async getIdentity(): Promise<HubIdentity & { privateKey: KeyObject }> {
    const read = async () => {
      const s = await this.settings.get();
      if (!s.hubPublicKey || !s.hubPrivateKeyEnc) return null;
      const privateKey = createPrivateKey(this.crypto.decrypt(s.hubPrivateKeyEnc));
      return { ...identityFromRawPublicKey(Buffer.from(s.hubPublicKey, "base64url")), privateKey };
    };
    const have = await read();
    if (have) return have;
    const gen = this.generateIdentity();
    await this.prisma.instanceSettings.updateMany({
      where: { id: "singleton", hubPrivateKeyEnc: null },
      data: { hubPublicKey: gen.publicKey, hubPrivateKeyEnc: gen.privateKeyEnc },
    });
    const now = await read();
    if (!now) throw new Error("could not persist the hub identity");
    return now;
  }

  /** Replace the key pair with a fresh one (owner "reset identity" action). Returns the new hub id. */
  async resetIdentity(): Promise<string> {
    const gen = this.generateIdentity();
    await this.settings.update({ hubPublicKey: gen.publicKey, hubPrivateKeyEnc: gen.privateKeyEnc });
    return gen.hubId;
  }

  private generateIdentity(): HubIdentity & { privateKeyEnc: string } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    return { ...identityFromRawPublicKey(raw), privateKeyEnc: this.crypto.encrypt(pem) };
  }

  /** Build the exact payload that would be sent. Pure read; does not send. Pass `identity` to render a preview
   *  WITHOUT generating a key pair (e.g. status() before the first send); omit it on the real send path, where
   *  the identity is generated on first use. Compose stacks are counted as `services`, every other app as
   *  `applications`. */
  async buildPayload(identity?: HubIdentity): Promise<TelemetryPayload> {
    const [servers, applications, services, databases, deployments, teams, users, clusters, monitors] =
      await this.prisma.$transaction([
        this.prisma.server.count(),
        this.prisma.application.count({ where: { source: { not: "COMPOSE" } } }),
        this.prisma.application.count({ where: { source: "COMPOSE" } }),
        this.prisma.database.count(),
        this.prisma.deployment.count(),
        this.prisma.team.count(),
        this.prisma.user.count(),
        this.prisma.cluster.count(),
        this.prisma.monitor.count(),
      ]);
    const id = identity ?? (await this.getIdentity());
    const nodeMajor = Number(process.versions.node.split(".")[0]) || 0;
    return {
      v: STATS_REPORT_VERSION,
      hubId: id.hubId,
      publicKey: id.publicKey,
      sentAt: new Date().toISOString(),
      version: appVersion(),
      counts: { servers, applications, databases, services, teams, users },
      features: {
        channel: releaseChannel(),
        edition: currentEdition(),
        platform: process.platform,
        arch: process.arch,
        nodeMajor,
        deployments,
        clusters,
        monitors,
      },
    };
  }

  /** Serialize the payload once and sign those exact bytes (ed25519). The receiver verifies the signature
   *  over the raw request body, so the string that is signed is the string that is sent. */
  async signPayload(payload: TelemetryPayload): Promise<{ body: string; signature: string }> {
    const { privateKey } = await this.getIdentity();
    const body = JSON.stringify(payload);
    return { body, signature: sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64url") };
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
      const { body, signature } = await this.signPayload(payload);
      const res = await fetch(this.endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json", [STATS_SIGNATURE_HEADER]: signature },
        body,
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

  /** Owner-facing status + a live preview of the exact payload. Does NOT create the identity as a side effect:
   *  when none exists yet, the preview shows a placeholder, so merely opening Settings never creates one. */
  async status(): Promise<TelemetryStatus> {
    const s = await this.settings.get();
    const known = s.hubPublicKey ? identityFromRawPublicKey(Buffer.from(s.hubPublicKey, "base64url")) : null;
    const payload = await this.buildPayload(known ?? { hubId: PENDING_IDENTITY, publicKey: PENDING_IDENTITY });
    return {
      enabled: !this.isForcedOff() && s.telemetryEnabled,
      forcedOff: this.isForcedOff(),
      dbEnabled: s.telemetryEnabled,
      hubId: known?.hubId ?? null,
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
