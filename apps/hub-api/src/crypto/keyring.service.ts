import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService, type KeySource } from "./crypto.service";
import { KEYRING_STORE, type KeyringStore } from "./keyring.store";
import { SecretsRotationService, type RotationStatus } from "./secrets-rotation.service";

/** How long after a key was demoted to decrypt-only it must wait before it can be retired: covers a lagging process
 *  that is still writing under the previous key until its next epoch poll. */
export const RETIRE_GRACE_MS = 90_000;
const EPOCH_POLL_MS = 15_000;
const UNKNOWN_KEY_REFRESH_MIN_MS = 2_000;

export type RotateTarget = "new-key" | "env-root";
export type KeyRole = "active" | "decrypt-only" | "root" | "retired";
export type RetireBlockedReason = "referenced" | "grace" | "running" | "degraded";

export interface KeyView {
  id: string;
  source: KeySource;
  role: KeyRole;
  createdAt: Date | null;
  activatedAt: Date | null;
  demotedAt: Date | null;
  retiredAt: Date | null;
  /** How many stored secrets carry this key id. */
  referenced: number;
  retirable: boolean;
  retireBlockedReason: RetireBlockedReason | null;
}

export interface SecretsKeyStatusView extends RotationStatus {
  epoch: number;
  degraded: string | null;
  keys: KeyView[];
  /** True when no stored secret is under a keyring data key: an older release without the keyring can read all of it. */
  downgradeSafe: boolean;
}

const conflict = (code: string, message: string) => new ConflictException({ code, message });

/**
 * Online secrets-key rotation without a hub restart. Random data keys live in Postgres, wrapped under the unchanged
 * .env root key; this service owns every mutation of that keyring and refreshes the in-memory ring (CryptoService).
 *
 * STATE MACHINE (per data key): ACTIVE -> DECRYPT_ONLY (a newer key was activated, or "Back to .env key") ->
 * RETIRED (nothing references it, 90 s grace passed) -> DECRYPT_ONLY (Restore). At most one ACTIVE: every mutation
 * runs in one transaction that first bumps `SecretsKeyring.epoch` (an UPDATE, so it takes the row lock and
 * serialises concurrent mutations) and then compares the live ACTIVE key with the caller's `expectedCurrentKeyId`.
 * Other processes notice through the epoch (15 s poll, plus a debounced refresh on an unknown key id). Single hub
 * remains the supported topology; the lock/CAS/poll are safety nets, not multi-hub support.
 */
@Injectable()
export class KeyRingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KeyRingService.name);
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastUnknownRefreshAt = 0;

  constructor(
    private readonly crypto: CryptoService,
    @Inject(KEYRING_STORE) private readonly store: KeyringStore,
    private readonly prisma: PrismaService,
    private readonly rotation: SecretsRotationService,
    private readonly audit: AuditService,
  ) {
    this.crypto.onUnknownKey = () => this.refreshOnUnknownKey();
  }

  async onApplicationBootstrap(): Promise<void> {
    // The boot ring was built inside the CryptoService factory (its wrapsToAdd was dropped); re-apply once now so the
    // auto-wrap under the current root is persisted (this is what completes a manual .env passphrase rotation).
    try {
      await this.refresh(true);
    } catch (e) {
      this.logger.error(`secrets keyring boot refresh failed: ${e instanceof Error ? e.message : e}`);
    }
    this.timer = setInterval(() => {
      void this.pollEpoch();
    }, EPOCH_POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One epoch check (the interval body; exposed for specs). Errors are swallowed: the next tick retries. */
  async pollEpoch(): Promise<void> {
    try {
      const epoch = await this.store.readEpoch();
      if (epoch !== this.crypto.ringEpoch) await this.refresh();
    } catch (e) {
      this.logger.warn(`secrets keyring epoch poll failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private refreshOnUnknownKey(): void {
    const now = Date.now();
    if (now - this.lastUnknownRefreshAt < UNKNOWN_KEY_REFRESH_MIN_MS) return;
    this.lastUnknownRefreshAt = now;
    this.refresh().catch((e) => this.logger.warn(`secrets keyring refresh on unknown key failed: ${e instanceof Error ? e.message : e}`));
  }

  /** Reload the ring from Postgres. Without `force`, a no-op when the epoch is unchanged and the ring is healthy.
   *  Serialised, so an older snapshot can never overwrite a newer one. */
  refresh(force = false): Promise<void> {
    const run = this.chain.then(async () => {
      const snap = await this.store.load();
      if (!force && snap.epoch === this.crypto.ringEpoch && !this.crypto.ringDegraded) return;
      const { wrapsToAdd } = this.crypto.applyRing(snap);
      if (wrapsToAdd.length === 0) return;
      try {
        await this.prisma.secretsKeyWrap.createMany({ data: wrapsToAdd, skipDuplicates: true });
      } catch (e) {
        // never block the ring on a wrap write; log ids only
        this.logger.warn(`secrets keyring: could not persist ${wrapsToAdd.length} wrap(s) for key(s) ${wrapsToAdd.map((w) => w.keyId).join(", ")}: ${e instanceof Error ? e.message : e}`);
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Make a new random data key ACTIVE (or, with target "env-root", demote the active key so the .env key encrypts
   *  again), then optionally start the re-encrypt job. No restart, no .env change. */
  async rotate(actor: string, input: { expectedCurrentKeyId: string; target: RotateTarget; reencrypt: boolean }): Promise<{ keyId: string; epoch: number; reencryptStarted: boolean }> {
    if (this.crypto.ringDegraded) throw conflict("ring_degraded", "the key ring is degraded; fix the root key first");
    if (this.rotation.isRunning()) throw conflict("rotation_running", "a secrets re-encryption is running");
    const now = new Date();
    const out = await this.prisma.$transaction(async (tx) => {
      // The UPDATE takes the row lock: concurrent rotates serialise here and the loser sees the new ACTIVE below.
      const ring = await tx.secretsKeyring.upsert({ where: { id: "singleton" }, update: { epoch: { increment: 1 } }, create: { id: "singleton", epoch: 1 }, select: { epoch: true } });
      const active = await tx.secretsKey.findFirst({ where: { state: "ACTIVE" }, select: { id: true } });
      const currentId = active?.id ?? this.crypto.envCurrentKeyId;
      if (currentId !== input.expectedCurrentKeyId) throw conflict("stale_current", "the active key changed; reload and try again");
      if (input.target === "env-root") {
        if (!active) throw conflict("already_env_root", "the .env key is already the encryption key");
        await tx.secretsKey.update({ where: { id: active.id }, data: { state: "DECRYPT_ONLY", demotedAt: now } });
        return { epoch: ring.epoch, previousKeyId: currentId, newKeyId: this.crypto.envCurrentKeyId };
      }
      const dk = this.crypto.generateDataKey();
      try {
        if (active) await tx.secretsKey.update({ where: { id: active.id }, data: { state: "DECRYPT_ONLY", demotedAt: now } });
        await tx.secretsKey.create({ data: { id: dk.id, state: "ACTIVE", createdBy: actor, activatedAt: now } });
        await tx.secretsKeyWrap.createMany({ data: this.crypto.wrapForRoots(dk.key).map((w) => ({ keyId: dk.id, ...w })) });
      } finally {
        dk.key.fill(0); // the ring reloads the key from its wraps below; the transient copy never lingers
      }
      return { epoch: ring.epoch, previousKeyId: currentId, newKeyId: dk.id };
    });
    await this.refresh(true);
    let reencryptStarted = false;
    if (input.reencrypt) {
      try {
        this.rotation.start(actor);
        reencryptStarted = true;
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e; // a run already started elsewhere is fine; anything else is a bug
      }
    }
    await this.auditSafe(actor, "instance.secrets_key.rotate", { newKeyId: out.newKeyId, previousKeyId: out.previousKeyId, target: input.target, reencrypt: input.reencrypt });
    return { keyId: this.crypto.currentKeyId, epoch: out.epoch, reencryptStarted };
  }

  /** DECRYPT_ONLY -> RETIRED: the key is no longer loaded. Only when nothing references it and the grace has passed. */
  async retire(actor: string, keyId: string): Promise<{ keyId: string; state: "RETIRED" }> {
    const row = await this.prisma.secretsKey.findUnique({ where: { id: keyId }, select: { id: true, state: true, demotedAt: true } });
    if (!row) throw new NotFoundException({ code: "unknown_key", message: "no such data key (keys from .env are managed there)" });
    if (this.crypto.ringDegraded) throw conflict("ring_degraded", "the key ring is degraded; fix the root key first");
    if (row.state !== "DECRYPT_ONLY") throw conflict("not_decrypt_only", "only a decrypt-only key can be retired");
    if (this.rotation.isRunning()) throw conflict("rotation_running", "a secrets re-encryption is running");
    const status = await this.rotation.status();
    if ((status.byKey[keyId] ?? 0) > 0) throw conflict("referenced", "stored secrets still use this key; re-encrypt first");
    if (row.demotedAt && Date.now() - row.demotedAt.getTime() < RETIRE_GRACE_MS) throw conflict("grace", "this key was demoted moments ago; wait a minute so every process has switched");
    await this.prisma.$transaction(async (tx) => {
      await tx.secretsKeyring.upsert({ where: { id: "singleton" }, update: { epoch: { increment: 1 } }, create: { id: "singleton", epoch: 1 } });
      const { count } = await tx.secretsKey.updateMany({ where: { id: keyId, state: "DECRYPT_ONLY" }, data: { state: "RETIRED", retiredAt: new Date() } });
      if (count === 0) throw conflict("not_decrypt_only", "the key changed state; reload and try again");
    });
    await this.refresh(true);
    await this.auditSafe(actor, "instance.secrets_key.retire", { keyId });
    return { keyId, state: "RETIRED" };
  }

  /** RETIRED -> DECRYPT_ONLY, when a configured root key can still unwrap it. */
  async restore(actor: string, keyId: string): Promise<{ keyId: string; state: "DECRYPT_ONLY" }> {
    const row = await this.prisma.secretsKey.findUnique({ where: { id: keyId }, select: { id: true, state: true, wraps: { select: { rootKeyId: true, wrapped: true } } } });
    if (!row) throw new NotFoundException({ code: "unknown_key", message: "no such data key" });
    if (row.state !== "RETIRED") throw conflict("not_retired", "only a retired key can be restored");
    if (!this.crypto.canUnwrap(row.wraps, keyId)) throw conflict("no_root", "no configured root key can unwrap this key; put the old root key back in SECRETS_ENCRYPTION_KEY_PREVIOUS");
    await this.prisma.$transaction(async (tx) => {
      await tx.secretsKeyring.upsert({ where: { id: "singleton" }, update: { epoch: { increment: 1 } }, create: { id: "singleton", epoch: 1 } });
      const { count } = await tx.secretsKey.updateMany({ where: { id: keyId, state: "RETIRED" }, data: { state: "DECRYPT_ONLY" } }); // demotedAt unchanged
      if (count === 0) throw conflict("not_retired", "the key changed state; reload and try again");
    });
    await this.refresh(true);
    await this.auditSafe(actor, "instance.secrets_key.restore", { keyId });
    return { keyId, state: "DECRYPT_ONLY" };
  }

  /** Owner view: the previous rotation status plus the keyring (additive fields only). Never any key material. */
  async statusView(): Promise<SecretsKeyStatusView> {
    const status = await this.rotation.status();
    const rows = await this.prisma.secretsKey.findMany({ orderBy: { activatedAt: "desc" }, select: { id: true, state: true, createdAt: true, activatedAt: true, demotedAt: true, retiredAt: true } });
    const degraded = this.crypto.ringDegraded;
    const running = this.rotation.isRunning();
    const ref = (id: string) => status.byKey[id] ?? 0;
    const ringActive = this.crypto.describeKeys()[0]?.source === "ring";
    const envKeys: KeyView[] = this.crypto
      .describeKeys()
      .filter((k) => k.source === "env")
      .map((k) => ({
        id: k.id,
        source: "env" as const,
        // The env current key is the root of trust while a data key encrypts; otherwise it is the active key.
        role: k.id === this.crypto.envCurrentKeyId ? (ringActive ? "root" : "active") : "decrypt-only",
        createdAt: null,
        activatedAt: null,
        demotedAt: null,
        retiredAt: null,
        referenced: ref(k.id),
        retirable: false,
        retireBlockedReason: null,
      }));
    const ringKeys: KeyView[] = rows.map((r) => {
      const referenced = ref(r.id);
      let reason: RetireBlockedReason | null = null;
      if (r.state === "DECRYPT_ONLY") {
        if (degraded) reason = "degraded";
        else if (running) reason = "running";
        else if (referenced > 0) reason = "referenced";
        else if (r.demotedAt && Date.now() - r.demotedAt.getTime() < RETIRE_GRACE_MS) reason = "grace";
      }
      return {
        id: r.id,
        source: "ring" as const,
        role: r.state === "ACTIVE" ? "active" : r.state === "DECRYPT_ONLY" ? "decrypt-only" : "retired",
        createdAt: r.createdAt,
        activatedAt: r.activatedAt,
        demotedAt: r.demotedAt,
        retiredAt: r.retiredAt,
        referenced,
        retirable: r.state === "DECRYPT_ONLY" && reason === null,
        retireBlockedReason: reason,
      };
    });
    const dbIds = rows.map((r) => r.id);
    return {
      ...status,
      epoch: this.crypto.ringEpoch,
      degraded,
      keys: [...ringKeys.filter((k) => k.role !== "retired"), ...envKeys, ...ringKeys.filter((k) => k.role === "retired")],
      downgradeSafe: dbIds.reduce((n, id) => n + ref(id), 0) === 0,
    };
  }

  private async auditSafe(actor: string, action: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.audit.log({ actor, action, target: "singleton", meta });
    } catch {
      /* best-effort: never turn a completed change into a 500 */
    }
  }
}
