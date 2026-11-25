import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { CryptoService } from "../crypto/crypto.service";
import { SealedChannelService, SealOpenError, type SealContext } from "./sealed-channel.service";
import { sealForTest } from "./sealed-channel.testing";

async function make(): Promise<{ svc: SealedChannelService; crypto: CryptoService }> {
  const config = { get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? "test-passphrase-1234567890" : undefined) } as unknown as ConfigService;
  const crypto = new CryptoService(config);
  await crypto.onModuleInit();
  return { svc: new SealedChannelService(crypto), crypto };
}

const ctx: SealContext = { runId: "run-1", serverId: "srv-1", ref: "env:abc", field: "value", cls: "env" };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SealOpenError) return e.code;
    throw e;
  }
  return "none";
}

describe("SealedChannelService: per-run key", () => {
  it("makes a fresh key pair per run and wraps the private half with tk1", async () => {
    const { svc } = await make();
    const a = svc.newRunKey();
    const b = svc.newRunKey();
    expect(a.publicKeyB64).not.toBe(b.publicKeyB64);
    expect(Buffer.from(a.publicKeyB64, "base64")).toHaveLength(32);
    expect(a.privateKeyEnc).toMatch(/^tk1\.[0-9a-f]{16}\./);
    expect(a.privateKeyEnc).not.toContain(a.publicKeyB64);
    const loaded = svc.loadRunKey(a.privateKeyEnc);
    expect(loaded.publicKeyB64).toBe(a.publicKeyB64); // the wrapped private half is the pair of the published public half
  });

  it("opens what was sealed to the public half, and nothing else can", async () => {
    const { svc } = await make();
    const run = svc.newRunKey();
    const other = svc.newRunKey();
    const env = sealForTest(run.publicKeyB64, ctx, "postgres://app:p@db/app");
    expect(svc.open(svc.loadRunKey(run.privateKeyEnc), env, ctx)).toBe("postgres://app:p@db/app");
    expect(codeOf(() => svc.open(svc.loadRunKey(other.privateKeyEnc), env, ctx))).toBe("auth_failed");
  });

  it("cannot unwrap a key that was cleared or damaged (forward secrecy: a destroyed run key opens nothing)", async () => {
    const { svc } = await make();
    expect(codeOf(() => svc.loadRunKey(""))).toBe("bad_key");
    expect(codeOf(() => svc.loadRunKey("tk1.0000000000000000.AAAA"))).toBe("bad_key");
    const run = svc.newRunKey();
    expect(codeOf(() => svc.loadRunKey(run.privateKeyEnc.slice(0, -4) + "AAAA"))).toBe("bad_key");
  });

  it("wraps under the CURRENT key only through CryptoService (a different passphrase cannot unwrap)", async () => {
    const { svc } = await make();
    const run = svc.newRunKey();
    const other = new CryptoService({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? "another-passphrase-0987654321" : undefined) } as unknown as ConfigService);
    await other.onModuleInit();
    expect(codeOf(() => new SealedChannelService(other).loadRunKey(run.privateKeyEnc))).toBe("bad_key");
  });
});

describe("SealedChannelService: envelope checks", () => {
  it("binds the value to run, agent, ref, field and class (an envelope moved anywhere else fails)", async () => {
    const { svc } = await make();
    const run = svc.newRunKey();
    const key = svc.loadRunKey(run.privateKeyEnc);
    const env = sealForTest(run.publicKeyB64, ctx, "secret-value");
    const moves: Array<[string, Partial<SealContext>]> = [
      ["run", { runId: "run-2" }], ["agent", { serverId: "srv-2" }], ["ref", { ref: "env:other" }], ["field", { field: "other" }], ["class", { cls: "s3" }],
    ];
    for (const [name, change] of moves) expect([name, codeOf(() => svc.open(key, env, { ...ctx, ...change }))]).toEqual([name, "auth_failed"]);
  });

  it("rejects a tampered, truncated or foreign envelope with a fixed code", async () => {
    const { svc } = await make();
    const run = svc.newRunKey();
    const key = svc.loadRunKey(run.privateKeyEnc);
    const env = sealForTest(run.publicKeyB64, ctx, "secret-value");
    const body = Buffer.from(env.slice(5), "base64url");
    for (const i of [0, 31, 32, 44, body.length - 1]) {
      const b = Buffer.from(body);
      b[i] ^= 1;
      expect([i, codeOf(() => svc.open(key, "tse1." + b.toString("base64url"), ctx))]).toEqual([i, "auth_failed"]);
    }
    expect(codeOf(() => svc.open(key, "tse1." + body.subarray(0, 40).toString("base64url"), ctx))).toBe("bad_envelope");
    expect(codeOf(() => svc.open(key, "tse2." + body.toString("base64url"), ctx))).toBe("bad_envelope");
    expect(codeOf(() => svc.open(key, "plaintext", ctx))).toBe("bad_envelope");
    expect(codeOf(() => svc.open(key, "", ctx))).toBe("bad_envelope");
    expect(codeOf(() => svc.open(key, env, { ...ctx, field: "" }))).toBe("bad_context");
    expect(codeOf(() => svc.open(key, env, { ...ctx, ref: "env:a\u0000b" }))).toBe("bad_context");
  });

  it("refuses a small-order ephemeral key", async () => {
    const { svc } = await make();
    const run = svc.newRunKey();
    const key = svc.loadRunKey(run.privateKeyEnc);
    const env = sealForTest(run.publicKeyB64, ctx, "x");
    const body = Buffer.from(env.slice(5), "base64url");
    Buffer.alloc(32).copy(body, 0); // u = 0
    expect(codeOf(() => svc.open(key, "tse1." + body.toString("base64url"), ctx))).toBe("auth_failed");
  });

  it("pads short values to the same envelope length and round-trips edge values", async () => {
    const { svc } = await make();
    const run = svc.newRunKey();
    const key = svc.loadRunKey(run.privateKeyEnc);
    expect(sealForTest(run.publicKeyB64, ctx, "a")).toHaveLength(sealForTest(run.publicKeyB64, ctx, "a".repeat(50)).length);
    for (const v of ["", "é€🔑", "line1\nline2 \"q\"", "x".repeat(60), "x".repeat(61), "y".repeat(100_000)]) {
      expect(svc.open(key, sealForTest(run.publicKeyB64, ctx, v), ctx)).toBe(v);
    }
  });
});

describe("SealedChannelService: interop with the agent (Go) vectors", () => {
  // The file is made by an independent Node implementation and the Go agent test asserts that it produces the SAME bytes, so this proves
  // the hub opens exactly what the agent seals.
  const file = join(__dirname, "../../../../agent/internal/coolify/seal/testdata/tse1-vectors.json");
  const vectors = JSON.parse(readFileSync(file, "utf8")) as {
    recipientPrivHex: string; runId: string; serverId: string;
    vectors: Array<{ name: string; ref: string; field: string; class: string; plainB64: string; env: string }>;
  };

  it.each(vectors.vectors.map((v) => [v.name, v] as const))("opens the %s vector", async (_n, v) => {
    const { svc, crypto } = await make();
    const key = svc.loadRunKey(crypto.encrypt(Buffer.from(vectors.recipientPrivHex, "hex").toString("base64")));
    const out = svc.open(key, v.env, { runId: vectors.runId, serverId: vectors.serverId, ref: v.ref, field: v.field, cls: v.class });
    expect(out).toBe(Buffer.from(v.plainB64, "base64").toString("utf8"));
  });
});
