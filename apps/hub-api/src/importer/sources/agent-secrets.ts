import type { CoolifySecretClass, UnreadableValue } from "@tugra/shared";

/**
 * The secret values an agent-path import carries, held the way the rest of the hub holds a secret: encrypted (`tk1.`), in memory only,
 * one function away from plaintext. The agent opens Coolify's encrypted values on its own host and seals them to this hub's per-run key;
 * the sealed secrets service opens the envelope and hands back `CryptoService` ciphertext (`fetchEncrypted`). Nothing in this file keeps,
 * logs or returns a plaintext: `get` decrypts one value for the caller that needs it right now (a setter on its way to the database).
 */

/** What the view of the read can say about the secrets of the Coolify it describes: which `kind:id` refs exist, per consent class. */
export type SecretRefPlan = Partial<Record<CoolifySecretClass, string[]>>;

/** Read access to opened values. `undefined` = NULL, never asked for, not consented, or could not be opened. */
export interface SecretOverlay {
  get(ref: string, field: string): string | undefined;
}
export const NO_OVERLAY: SecretOverlay = { get: () => undefined };

/** The part of the sealed secrets service this import path uses (see CoolifySecretsService / CoolifyHostGrantService). */
export interface AgentSecretsPort {
  /** The consent classes of the active grant that belongs to `runId` on this Coolify host, or null when there is none. */
  grantedClasses(serverId: string, runId: string): Promise<CoolifySecretClass[] | null>;
  /** One sealed read, kept as `tk1.` ciphertext. A value that could not be opened is counted in `unreadable` with a fixed code. */
  fetchEncrypted(input: { serverId: string; runId: string; refs: string[]; classes: CoolifySecretClass[]; userId: string }): Promise<{
    values: Array<{ ref: string; field: string; cls: CoolifySecretClass; enc: string }>;
    unreadable: UnreadableValue[];
    incomplete?: { code: string; remainingRefs: string[] };
  }>;
  /** The import is over: end the consent of this run (the capability and the run key go with it). */
  finishRun(serverId: string, runId: string): Promise<void>;
  /** Open one `tk1.` value. Only {@link AgentSecretStore.get} calls it. */
  decrypt(enc: string): string;
}

export type EnsureOutcome = "loaded" | "not_consented" | "incomplete";

const SEP = "\u0000";
const slot = (ref: string, field: string): string => `${ref}${SEP}${field}`;

/** A database password is sealed together with the engine's config text (one table, one class) but nothing here carries it: it is dropped on arrival. */
const dropped = (ref: string, field: string): boolean => ref.startsWith("database:") && /password/.test(field);

/**
 * The opened values of one import session. A class is read once (single flight) and only for refs not asked for before, so the plan, a
 * preview and the apply of one session share one read instead of repeating it. `reset` forgets everything read (the apply starts from a
 * fresh read), and `forget` ends the store.
 */
export class AgentSecretStore implements SecretOverlay {
  private readonly enc = new Map<string, string>();
  private readonly codes = new Map<string, UnreadableValue["code"]>();
  private readonly asked = new Map<CoolifySecretClass, Set<string>>();
  private readonly inflight = new Map<CoolifySecretClass, Promise<EnsureOutcome>>();
  private incompleteClasses = new Set<CoolifySecretClass>();
  lastUsed = Date.now();

  constructor(
    private readonly port: AgentSecretsPort,
    readonly serverId: string,
    readonly runId: string,
    private readonly userId: string,
    private readonly onFinish?: () => void,
  ) {}

  /** The classes the owner's consent for this run covers right now (empty when there is none). */
  async consentedClasses(): Promise<CoolifySecretClass[]> {
    return (await this.port.grantedClasses(this.serverId, this.runId)) ?? [];
  }

  /**
   * Read the values of these classes that were not read yet. A class the consent does not cover is `not_consented` and nothing is asked
   * for it. Never throws for a refusal: the values stay absent and the item that needs one is the one that is held back. A failure of
   * the consent itself (it ended mid-read) ends up as `not_consented`/`incomplete` too.
   */
  async ensure(classes: readonly CoolifySecretClass[], refsOf: () => SecretRefPlan): Promise<Record<string, EnsureOutcome>> {
    this.lastUsed = Date.now();
    const granted = new Set(await this.consentedClasses());
    const out: Record<string, EnsureOutcome> = {};
    await Promise.all(
      classes.map(async (cls) => {
        if (!granted.has(cls)) {
          out[cls] = "not_consented";
          return;
        }
        const running = this.inflight.get(cls);
        const wanted = (refsOf()[cls] ?? []).filter((r) => !(this.asked.get(cls) ?? new Set()).has(r));
        if (wanted.length === 0 && !running) {
          out[cls] = this.incompleteClasses.has(cls) ? "incomplete" : "loaded";
          return;
        }
        // queue behind a read of the same class that is running, then read what is still missing
        const next = (running ?? Promise.resolve("loaded" as EnsureOutcome)).then(() => this.readClass(cls, refsOf));
        this.inflight.set(cls, next);
        try {
          out[cls] = await next;
        } finally {
          if (this.inflight.get(cls) === next) this.inflight.delete(cls);
        }
      }),
    );
    return out;
  }

  private async readClass(cls: CoolifySecretClass, refsOf: () => SecretRefPlan): Promise<EnsureOutcome> {
    const asked = this.asked.get(cls) ?? new Set<string>();
    this.asked.set(cls, asked);
    const refs = (refsOf()[cls] ?? []).filter((r) => !asked.has(r));
    if (refs.length === 0) return this.incompleteClasses.has(cls) ? "incomplete" : "loaded";
    let res: Awaited<ReturnType<AgentSecretsPort["fetchEncrypted"]>>;
    try {
      res = await this.port.fetchEncrypted({ serverId: this.serverId, runId: this.runId, refs, classes: [cls], userId: this.userId });
    } catch {
      // consent ended, agent gone, key lost: nothing of this class is held, and what asks for it sees "absent"
      return "not_consented";
    }
    const remaining = new Set(res.incomplete?.remainingRefs ?? []);
    for (const r of refs) if (!remaining.has(r)) asked.add(r);
    for (const v of res.values) {
      if (dropped(v.ref, v.field)) continue;
      this.enc.set(slot(v.ref, v.field), v.enc);
    }
    for (const u of res.unreadable) this.codes.set(slot(u.itemRef, u.field), u.code);
    if (res.incomplete) this.incompleteClasses.add(cls);
    else this.incompleteClasses.delete(cls);
    return res.incomplete ? "incomplete" : "loaded";
  }

  get(ref: string, field: string): string | undefined {
    const e = this.enc.get(slot(ref, field));
    return e === undefined ? undefined : this.port.decrypt(e);
  }

  /** Why a value is absent when it is not NULL: the fixed code of the agent, or undefined. */
  codeOf(ref: string, field: string): UnreadableValue["code"] | undefined {
    return this.codes.get(slot(ref, field));
  }

  /** How many values could not be opened (counts only: the review shows them). */
  unreadableCount(): number {
    return this.codes.size;
  }

  /** Forget every value and every read: the next `ensure` reads again. */
  reset(): void {
    this.enc.clear();
    this.codes.clear();
    this.asked.clear();
    this.incompleteClasses.clear();
  }

  /** The values that could not be opened, with their fixed codes (names and codes only), capped. */
  unreadable(limit = 200): UnreadableValue[] {
    const out: UnreadableValue[] = [];
    for (const [k, code] of this.codes) {
      if (out.length >= limit) break;
      const [itemRef, field] = k.split(SEP);
      out.push({ itemRef, field, code });
    }
    return out;
  }

  /** The run is over: forget every value and end the owner's consent for it. Idempotent. */
  async finish(): Promise<void> {
    this.reset();
    this.onFinish?.();
    await this.port.finishRun(this.serverId, this.runId);
  }

  /** A view that only gives out these fields (the plan sees compose text and nothing else). */
  onlyFields(fields: ReadonlySet<string>): SecretOverlay {
    return { get: (ref, field) => (fields.has(field) ? this.get(ref, field) : undefined) };
  }
}

const IDLE_MS = 30 * 60_000;

/**
 * The stores of the import sessions that are in use, one per (session) run. In memory only, dropped when the run ends or after 30 idle
 * minutes. A store holds ciphertext, never a plaintext, and goes with the process.
 */
export class AgentSecretStores {
  private readonly stores = new Map<string, AgentSecretStore>();

  constructor(private readonly port: AgentSecretsPort) {}

  forRun(serverId: string, runId: string, userId: string): AgentSecretStore {
    const now = Date.now();
    for (const [id, s] of this.stores) if (now - s.lastUsed > IDLE_MS) this.stores.delete(id);
    const key = `${serverId}${SEP}${runId}`;
    let s = this.stores.get(key);
    if (!s) {
      s = new AgentSecretStore(this.port, serverId, runId, userId, () => this.stores.delete(key));
      this.stores.set(key, s);
    }
    s.lastUsed = now;
    return s;
  }

  /** End the run (a session ended before an apply finished it): forget what was read and end the consent. Idempotent. */
  async finish(serverId: string, runId: string): Promise<void> {
    const s = this.stores.get(`${serverId}${SEP}${runId}`);
    if (s) await s.finish();
    else await this.port.finishRun(serverId, runId);
  }

  get size(): number {
    return this.stores.size;
  }
}
