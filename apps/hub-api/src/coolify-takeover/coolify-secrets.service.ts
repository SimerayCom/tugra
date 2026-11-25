import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import {
  COOLIFY_SECRET_CLASSES,
  COOLIFY_SECRET_REF_RE,
  COOLIFY_SECRET_WIRE_CODES,
  COOLIFY_SECRETS_MAX_REFS_PER_FRAME,
  type CoolifySecretClass,
  type CoolifySecretRecord,
  type CoolifySecretWireCode,
  type UnreadableValue,
} from "@tugra/shared";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CryptoService } from "../crypto/crypto.service";
import { CoolifyHostGrantService } from "./coolify-host-grant.service";
import { SealedChannelService } from "./sealed-channel.service";

const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** One value, already opened. The plaintext string lives only for the duration of the sink call. */
export interface OpenedSecret {
  ref: string;
  field: string;
  cls: CoolifySecretClass;
  value: string;
}

/** One value as it is stored: `enc` is a CryptoService `tk1.` ciphertext (the hub's normal secret-at-rest format). */
export interface StoredSecret {
  ref: string;
  field: string;
  cls: CoolifySecretClass;
  enc: string;
}

export interface FetchSecretsInput {
  /** The agent server that runs Coolify. */
  serverId: string;
  /** `kind:id` refs (see COOLIFY_SECRET_REF_RE). */
  refs: string[];
  /** Subset of the grant's classes to read; default: all of them. */
  classes?: CoolifySecretClass[];
  /** Who asked (audit). Omit for the system. */
  userId?: string;
}

export interface FetchSecretsResult {
  /** Values opened and handed to the sink. */
  read: number;
  /** Values the agent could not read, with a fixed code. Counted and shown to the owner, never skipped silently. */
  unreadable: UnreadableValue[];
  /** At least one value only opened with APP_PREVIOUS_KEYS (the Coolify app key was rotated). Informational. */
  usedPreviousKey: boolean;
}

function chunk<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

const WIRE_CODES = new Set<string>(COOLIFY_SECRET_WIRE_CODES);

/**
 * Reads Coolify's secret values through the agent, sealed (Coolify hub takeover, lane B). The only place a plaintext exists on the hub:
 * `fetch` opens each envelope and hands the value to the caller's sink, which must encrypt or use it at once; `fetchEncrypted` is the
 * sink that does exactly that (CryptoService `tk1.`, the same at-rest format every other secret has). Nothing is cached, logged,
 * audited or returned: the audit row carries counts and codes only.
 *
 * Every request re-checks that the owner's grant is still active (a revoked or lapsed grant stops the read between two chunks), asks
 * for no class the grant does not cover, and accepts back only refs that were asked for, classes that were consented to, and envelopes
 * that open under THIS run's key with THIS run's context.
 */
@Injectable()
export class CoolifySecretsService {
  constructor(
    private readonly grants: CoolifyHostGrantService,
    private readonly sealed: SealedChannelService,
    private readonly agentWs: AgentWsServer,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  /** Read and keep encrypted: values come back as `tk1.` ciphertext, ready to store. */
  async fetchEncrypted(input: FetchSecretsInput): Promise<{ values: StoredSecret[] } & FetchSecretsResult> {
    const values: StoredSecret[] = [];
    const r = await this.fetch(input, (s) => {
      values.push({ ref: s.ref, field: s.field, cls: s.cls, enc: this.crypto.encrypt(s.value) });
    });
    return { values, ...r };
  }

  async fetch(input: FetchSecretsInput, sink: (s: OpenedSecret) => void | Promise<void>): Promise<FetchSecretsResult> {
    const refs = [...new Set(input.refs)];
    if (refs.length === 0) throw new BadRequestException("no refs");
    for (const r of refs) if (!COOLIFY_SECRET_REF_RE.test(r)) throw new BadRequestException("invalid ref");

    let grant = await this.requireGrant(input.serverId);
    const classes = input.classes ?? grant.classes;
    for (const c of classes) {
      if (!(COOLIFY_SECRET_CLASSES as readonly string[]).includes(c) || !grant.classes.includes(c)) {
        throw new ForbiddenException({ statusCode: 403, code: "class_not_granted", message: "the owner did not consent to this class" });
      }
    }
    if (classes.length === 0) throw new BadRequestException("no classes");
    const key = this.sealed.loadRunKey(grant.recipientKeyEnc);

    const unreadable: UnreadableValue[] = [];
    let read = 0;
    let usedPreviousKey = false;
    const codeCounts: Record<string, number> = {};
    try {
      for (const refsChunk of chunk(refs, COOLIFY_SECRETS_MAX_REFS_PER_FRAME)) {
        grant = await this.requireGrant(input.serverId); // revoked or lapsed between two chunks: stop here
        const asked = new Set(refsChunk);
        const records = await this.agentWs.sendCoolifySecrets(input.serverId, { runId: grant.runId, classes, refs: refsChunk, recipientKey: grant.recipientPublicKey }, REQUEST_TIMEOUT_MS);
        for (const rec of records) {
          const done = await this.takeRecord(rec, asked, classes, grant.runId, key, input.serverId, sink);
          if (done.kind === "read") read++;
          else if (done.kind === "previous") usedPreviousKey = true;
          else if (done.kind === "unreadable") {
            unreadable.push(done.value);
            codeCounts[done.value.code] = (codeCounts[done.value.code] ?? 0) + 1;
          }
        }
      }
    } catch (e) {
      await this.audit.log({ actor: input.userId ?? "system", action: "coolify.secrets.read", target: input.serverId, meta: { refs: refs.length, read, failure: errorClass(e) } });
      throw e;
    }
    // Counts and codes only: no ref, no field, no value, no envelope.
    await this.audit.log({ actor: input.userId ?? "system", action: "coolify.secrets.read", target: input.serverId, meta: { refs: refs.length, read, unreadable: unreadable.length, codes: codeCounts, previousKey: usedPreviousKey } });
    return { read, unreadable, usedPreviousKey };
  }

  private async requireGrant(serverId: string) {
    const g = await this.grants.activeSecretsGrant(serverId);
    if (!g) throw new ForbiddenException({ statusCode: 403, code: "no_active_grant", message: "no active consent for reading secrets on this server" });
    return g;
  }

  private async takeRecord(
    rec: CoolifySecretRecord,
    asked: Set<string>,
    classes: CoolifySecretClass[],
    runId: string,
    key: ReturnType<SealedChannelService["loadRunKey"]>,
    serverId: string,
    sink: (s: OpenedSecret) => void | Promise<void>,
  ): Promise<{ kind: "read" | "previous" | "dropped" } | { kind: "unreadable"; value: UnreadableValue }> {
    // An agent is untrusted input: a ref nobody asked for, an unknown field shape or a class outside the consent is dropped.
    if (!rec || typeof rec.ref !== "string" || typeof rec.field !== "string" || !asked.has(rec.ref) || !/^[a-z0-9_]{1,64}$|^\*$/.test(rec.field)) return { kind: "dropped" };
    if ("env" in rec && typeof rec.env === "string" && rec.env !== "") {
      const cls = rec.class;
      if (!classes.includes(cls)) return { kind: "dropped" };
      let value: string;
      try {
        value = this.sealed.open(key, rec.env, { runId, serverId, ref: rec.ref, field: rec.field, cls });
      } catch {
        // An envelope that does not open under this run's key and context: reported as unreadable, with a fixed code.
        return { kind: "unreadable", value: { itemRef: rec.ref, field: rec.field, code: "bad_payload" } };
      }
      await sink({ ref: rec.ref, field: rec.field, cls, value });
      return { kind: "read" };
    }
    const code = (rec as { code?: unknown }).code;
    if (typeof code !== "string" || !WIRE_CODES.has(code) || code === "ok") return { kind: "dropped" };
    if (code === "key_prev") return { kind: "previous" };
    return { kind: "unreadable", value: { itemRef: rec.ref, field: rec.field, code: code as Exclude<CoolifySecretWireCode, "ok"> } };
  }
}

function errorClass(e: unknown): string {
  return e instanceof Error ? e.constructor.name : "unknown";
}
