import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService, SecretsKeyUnavailableError } from "./crypto.service";

/**
 * Every column that holds a CryptoService ciphertext. The registry is the single source for the rotation job
 * AND is pinned by a spec that parses prisma/schema.prisma (every `*Enc` column + the known non-`Enc` ones must
 * appear here), so a new encrypted column can never be forgotten by a rotation.
 */
export const ENCRYPTED_COLUMNS: ReadonlyArray<{ model: string; columns: string[] }> = [
  { model: "user", columns: ["twoFaSecret"] },
  { model: "backupDestination", columns: ["s3AccessKey", "s3SecretKey", "encryptionKey"] },
  { model: "sharedVariable", columns: ["valueEnc"] },
  { model: "server", columns: ["dnsCredsEnc"] },
  { model: "logDrain", columns: ["authTokenEnc"] },
  { model: "serverTunnel", columns: ["cfApiTokenEnc", "cfTunnelTokenEnc"] },
  { model: "notificationChannel", columns: ["configEnc"] },
  { model: "gitSource", columns: ["clientSecretEnc", "privateKeyEnc", "webhookSecretEnc", "tokenEnc"] },
  { model: "registry", columns: ["passwordEnc"] },
  { model: "cloudCredential", columns: ["apiTokenEnc"] },
  { model: "dnsCredential", columns: ["apiTokenEnc"] },
  { model: "importSession", columns: ["tokenEnc"] },
  { model: "application", columns: ["gitTokenEnc", "gitSshKeyEnc", "registryAuthEnc", "envEnc", "buildArgsEnc", "buildSecretsEnc", "certKeyEnc", "webhookSecret"] },
  { model: "secretProvider", columns: ["tokenEnc"] },
  { model: "database", columns: ["credentials", "envEnc"] },
  { model: "instanceSettings", columns: ["oidcClientSecretEnc", "mailPassEnc", "mailResendKeyEnc"] },
];

/** Ciphertext columns whose name does not end in `Enc` (the completeness spec needs the list; a new one must be
 *  added here AND in ENCRYPTED_COLUMNS). */
export const NON_ENC_CIPHERTEXT_COLUMNS: Readonly<Record<string, string[]>> = {
  user: ["twoFaSecret"],
  application: ["webhookSecret"],
  database: ["credentials"],
  backupDestination: ["s3AccessKey", "s3SecretKey", "encryptionKey"],
};

/**
 * Ciphertext stored INSIDE a Json column: the import env-remap undo snapshots (`BulkOperation.meta.remapUndo
 * .apps[].priorEnc`, written by the import executor, dropped on full undo). Rewritten with a CAS on the whole
 * JSON value (`meta: { equals: before }`), the same guard the executor itself uses.
 */
export const JSON_SINKS: ReadonlyArray<{ model: string; column: string; path: string }> = [{ model: "bulkOperation", column: "meta", path: "remapUndo.apps[].priorEnc" }];

/** Columns holding a keyed MAC (not a ciphertext): the plaintext is gone, so a rotation cannot rewrite them —
 *  they keep matching while the previous key is configured (CryptoService.hmacCandidates) and are reported. */
export const HMAC_COLUMNS: ReadonlyArray<{ model: string; column: string }> = [{ model: "twoFactorRecoveryCode", column: "codeHash" }];

const PAGE = 200;

export interface RotationCounts {
  /** Rows (any column) already under the current key in the versioned format. */
  current: number;
  /** Rows still readable only through a previous key, or in the legacy unprefixed format. */
  stale: number;
  /** Rows no configured key can open (the key they were written under is gone). */
  unreadable: number;
}

export interface RotationStatus {
  currentKeyId: string;
  previousKeyIds: string[];
  /** Per model: how many encrypted VALUES are current / stale / unreadable (a row with 3 columns counts 3). */
  models: Array<{ model: string } & RotationCounts>;
  totals: RotationCounts;
  /** Recovery-code MACs that were written under a key other than the current one (cannot be rewritten). */
  hmacRowsOnOldKeys: Array<{ model: string; column: string; count: number | null }>;
  /** True when every stored secret is under the current key → SECRETS_ENCRYPTION_KEY_PREVIOUS can be removed. */
  previousKeyRemovable: boolean;
  running: boolean;
  lastRun: RotationRun | null;
}

export interface RotationRun {
  startedAt: Date;
  finishedAt: Date | null;
  actor: string;
  rewritten: number;
  alreadyCurrent: number;
  unreadable: number;
  /** A concurrent legitimate write changed the value between read and rewrite → left for the next run. */
  skipped: number;
  errors: number;
  /** Rows no key could open, so the operator can find them: `<model>:<id>:<column>` (capped). */
  unreadableRefs: string[];
  error: string | null;
}

type Delegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  count: (args?: Record<string, unknown>) => Promise<number>;
};

/**
 * Master-key rotation: rewrites every stored ciphertext under the CURRENT key. Runs detached (owner-triggered),
 * page by page, and every rewrite is a compare-and-set on the OLD ciphertext (`WHERE id AND column = old`), so a
 * value a user legitimately changed meanwhile is never clobbered — it is simply current already. Idempotent and
 * resumable: re-running after a crash picks up exactly the rows that are still stale. Values no configured key
 * can open are counted and listed, never touched (the operator restores the missing key to PREVIOUS and re-runs).
 * Single in-flight run per hub (single-hub design like the other in-process locks).
 */
@Injectable()
export class SecretsRotationService {
  private readonly logger = new Logger(SecretsRotationService.name);
  private running = false;
  private lastRun: RotationRun | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  private delegate(model: string): Delegate {
    return (this.prisma as unknown as Record<string, Delegate>)[model];
  }

  /** Owner status: what is still under an old key. Pure string inspection per value — never decrypts. */
  async status(): Promise<RotationStatus> {
    const models: RotationStatus["models"] = [];
    const totals: RotationCounts = { current: 0, stale: 0, unreadable: 0 };
    const known = new Set([this.crypto.currentKeyId, ...this.crypto.previousKeyIds]);
    for (const entry of ENCRYPTED_COLUMNS) {
      const counts: RotationCounts = { current: 0, stale: 0, unreadable: 0 };
      await this.forEachPage(entry.model, entry.columns, (rows) => {
        for (const row of rows) {
          for (const col of entry.columns) {
            const v = row[col];
            if (typeof v !== "string" || !v) continue;
            if (this.crypto.isCurrent(v)) counts.current++;
            else {
              const id = this.crypto.keyIdOf(v);
              // A versioned ciphertext under an unknown key is unreadable for sure; a legacy one can only be
              // judged by decrypting (the run does that) — count it stale here.
              if (id && !known.has(id)) counts.unreadable++;
              else counts.stale++;
            }
          }
        }
      });
      models.push({ model: entry.model, ...counts });
      totals.current += counts.current;
      totals.stale += counts.stale;
      totals.unreadable += counts.unreadable;
    }
    for (const sink of JSON_SINKS) {
      const counts: RotationCounts = { current: 0, stale: 0, unreadable: 0 };
      await this.forEachPage(sink.model, [sink.column], (rows) => {
        for (const row of rows) {
          for (const v of this.sinkValues(row[sink.column])) {
            if (this.crypto.isCurrent(v)) counts.current++;
            else {
              const id = this.crypto.keyIdOf(v);
              if (id && !known.has(id)) counts.unreadable++;
              else counts.stale++;
            }
          }
        }
      });
      models.push({ model: `${sink.model}.${sink.column}`, ...counts });
      totals.current += counts.current;
      totals.stale += counts.stale;
      totals.unreadable += counts.unreadable;
    }
    // MAC rows cannot carry a key id; while a previous key is configured, report the live count as "may be on an
    // old key" (null when no rotation is in progress — nothing to say).
    const hmacRowsOnOldKeys = await Promise.all(
      HMAC_COLUMNS.map(async (h) => ({
        model: h.model,
        column: h.column,
        count: this.crypto.previousKeyIds.length ? await this.delegate(h.model).count({ where: {} }).catch(() => null) : 0,
      })),
    );
    return {
      currentKeyId: this.crypto.currentKeyId,
      previousKeyIds: this.crypto.previousKeyIds,
      models,
      totals,
      hmacRowsOnOldKeys,
      previousKeyRemovable: totals.stale === 0 && totals.unreadable === 0 && !this.running, // from the data alone (survives a restart)
      running: this.running,
      lastRun: this.lastRun,
    };
  }

  /** Start a re-encrypt run (detached). 409 while one is already running. */
  start(actor: string): RotationRun {
    if (this.running) throw new ConflictException("a secrets re-encryption is already running");
    this.running = true;
    const run: RotationRun = { startedAt: new Date(), finishedAt: null, actor, rewritten: 0, alreadyCurrent: 0, unreadable: 0, skipped: 0, errors: 0, unreadableRefs: [], error: null };
    this.lastRun = run;
    void this.execute(run)
      .catch((e) => {
        run.error = e instanceof Error ? e.message : String(e);
        this.logger.error(`secrets re-encryption failed: ${run.error}`);
      })
      .finally(async () => {
        run.finishedAt = new Date();
        this.running = false;
        try {
          await this.audit.log({
            actor,
            action: "instance.secrets_key.reencrypt",
            target: "singleton",
            meta: { currentKeyId: this.crypto.currentKeyId, rewritten: run.rewritten, alreadyCurrent: run.alreadyCurrent, unreadable: run.unreadable, skipped: run.skipped, errors: run.errors, error: run.error },
          });
        } catch {
          /* best-effort */
        }
      });
    return run;
  }

  /** Synchronous variant for specs / CLI: runs to completion and returns the run. */
  async runNow(actor: string): Promise<RotationRun> {
    const run = this.start(actor);
    while (this.running) await new Promise((r) => setTimeout(r, 5));
    return run;
  }

  private async execute(run: RotationRun): Promise<void> {
    for (const entry of ENCRYPTED_COLUMNS) {
      await this.forEachPage(entry.model, entry.columns, async (rows) => {
        for (const row of rows) {
          for (const col of entry.columns) {
            const old = row[col];
            if (typeof old !== "string" || !old) continue;
            if (this.crypto.isCurrent(old)) {
              run.alreadyCurrent++;
              continue;
            }
            let plaintext: string;
            try {
              plaintext = this.crypto.decryptMeta(old).plaintext;
            } catch (e) {
              if (e instanceof SecretsKeyUnavailableError) {
                run.unreadable++;
                if (run.unreadableRefs.length < 200) run.unreadableRefs.push(`${entry.model}:${String(row.id)}:${col}`);
              } else {
                run.errors++;
                this.logger.warn(`re-encrypt ${entry.model}.${col} ${String(row.id)}: ${e instanceof Error ? e.message : e}`);
              }
              continue;
            }
            try {
              const { count } = await this.delegate(entry.model).updateMany({
                where: { id: row.id, [col]: old }, // CAS on the old ciphertext: a concurrent legit write wins
                data: { [col]: this.crypto.encrypt(plaintext) },
              });
              if (count === 1) run.rewritten++;
              else run.skipped++;
            } catch (e) {
              run.errors++;
              this.logger.warn(`re-encrypt ${entry.model}.${col} ${String(row.id)}: ${e instanceof Error ? e.message : e}`);
            }
          }
        }
      });
    }
    for (const sink of JSON_SINKS) {
      await this.forEachPage(sink.model, [sink.column], async (rows) => {
        for (const row of rows) await this.reencryptJsonSink(run, sink, row);
      });
    }
  }

  /** The `remapUndo.apps[].priorEnc` strings inside an import operation's meta (empty for anything else). */
  private sinkValues(meta: unknown): string[] {
    const undo = (meta as { remapUndo?: { apps?: Array<{ priorEnc?: unknown }> } } | null)?.remapUndo;
    if (!undo || !Array.isArray(undo.apps)) return [];
    return undo.apps.map((a) => a.priorEnc).filter((v): v is string => typeof v === "string" && v.length > 0);
  }

  /** Rewrite stale `priorEnc` values inside one JSON meta with a CAS on the whole previous JSON value. */
  private async reencryptJsonSink(run: RotationRun, sink: { model: string; column: string }, row: Record<string, unknown>): Promise<void> {
    const before = row[sink.column];
    const undo = (before as { remapUndo?: { apps?: Array<{ priorEnc?: unknown }> } } | null)?.remapUndo;
    if (!undo || !Array.isArray(undo.apps)) return;
    const priorApps = undo.apps;
    let changed = false;
    const apps = priorApps.map((a, i) => {
      const old = a.priorEnc;
      if (typeof old !== "string" || !old) return a;
      if (this.crypto.isCurrent(old)) {
        run.alreadyCurrent++;
        return a;
      }
      try {
        const plaintext = this.crypto.decryptMeta(old).plaintext;
        changed = true;
        return { ...a, priorEnc: this.crypto.encrypt(plaintext) };
      } catch (e) {
        if (e instanceof SecretsKeyUnavailableError) {
          run.unreadable++;
          if (run.unreadableRefs.length < 200) run.unreadableRefs.push(`${sink.model}:${String(row.id)}:${sink.column}.remapUndo.apps[${i}].priorEnc`);
        } else {
          run.errors++;
          this.logger.warn(`re-encrypt ${sink.model}.${sink.column} ${String(row.id)}: ${e instanceof Error ? e.message : e}`);
        }
        return a;
      }
    });
    if (!changed) return;
    const rewritten = apps.filter((a, i) => a !== priorApps[i]).length;
    try {
      const after = { ...(before as Record<string, unknown>), remapUndo: { ...undo, apps } };
      const { count } = await this.delegate(sink.model).updateMany({
        where: { id: row.id, [sink.column]: { equals: before } }, // CAS on the whole JSON: the executor's own guard
        data: { [sink.column]: after },
      });
      if (count === 1) run.rewritten += rewritten;
      else run.skipped += rewritten;
    } catch (e) {
      run.errors++;
      this.logger.warn(`re-encrypt ${sink.model}.${sink.column} ${String(row.id)}: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Cursor-paged scan by id over one model, selecting only id + the encrypted columns. */
  private async forEachPage(model: string, columns: string[], fn: (rows: Array<Record<string, unknown>>) => void | Promise<void>): Promise<void> {
    const d = this.delegate(model);
    if (!d) return;
    const select = Object.fromEntries([["id", true], ...columns.map((c) => [c, true])]);
    let cursor: string | null = null;
    for (;;) {
      const rows = await d.findMany({
        select,
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) return;
      await fn(rows);
      if (rows.length < PAGE) return;
      cursor = String(rows[rows.length - 1].id);
    }
  }
}
