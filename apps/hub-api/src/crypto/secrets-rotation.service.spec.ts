import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CryptoService } from "./crypto.service";
import { ENCRYPTED_COLUMNS, HMAC_COLUMNS, JSON_SINKS, NON_ENC_CIPHERTEXT_COLUMNS, SecretsRotationService } from "./secrets-rotation.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

const OLD = "old-passphrase-0123456789";
const NEW = "new-passphrase-9876543210";

async function crypto(current: string, previous?: string): Promise<CryptoService> {
  const svc = new CryptoService({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? current : k === "SECRETS_ENCRYPTION_KEY_PREVIOUS" ? previous : undefined) } as unknown as ConfigService);
  await svc.onModuleInit();
  return svc;
}
const legacy = (svc: CryptoService, v: string) => svc.encrypt(v).split(".")[2];

/** In-memory Prisma: id-cursor paging + CAS updateMany (where { id, [col]: old }). */
function fakePrisma(tables: Record<string, Array<Record<string, unknown>>>) {
  const delegate = (rows: Array<Record<string, unknown>>) => ({
    findMany: jest.fn(async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
      const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const start = args.cursor ? sorted.findIndex((r) => r.id === args.cursor!.id) + (args.skip ?? 0) : 0;
      return sorted.slice(start, start + args.take).map((r) => ({ ...r }));
    }),
    updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const hit = rows.filter((r) => Object.entries(args.where).every(([k, v]) => (v && typeof v === "object" && "equals" in (v as object) ? same(r[k], (v as { equals: unknown }).equals) : r[k] === v)));
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    }),
    count: jest.fn(async () => rows.length),
  });
  const p: Record<string, unknown> = {};
  for (const [m, rows] of Object.entries(tables)) p[m] = delegate(rows);
  return p;
}

describe("ENCRYPTED_COLUMNS registry — completeness against prisma/schema.prisma", () => {
  it("every *Enc column (and the known non-Enc ciphertext columns) in the schema is in the registry, and nothing extra", () => {
    const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    const expected = new Set<string>();
    for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const model = m[1].charAt(0).toLowerCase() + m[1].slice(1);
      for (const line of m[2].split("\n")) {
        const col = line.trim().split(/\s+/)[0];
        if (col && (col.endsWith("Enc") || NON_ENC_CIPHERTEXT_COLUMNS[model]?.includes(col))) expected.add(`${model}.${col}`);
      }
    }
    const actual = new Set(ENCRYPTED_COLUMNS.flatMap((e) => e.columns.map((c) => `${e.model}.${c}`)));
    expect([...actual].sort()).toEqual([...expected].sort());
    expect(HMAC_COLUMNS).toEqual([{ model: "twoFactorRecoveryCode", column: "codeHash" }]);
    expect(JSON_SINKS).toEqual([{ model: "bulkOperation", column: "meta", path: "remapUndo.apps[].priorEnc" }]);
  });

  it("the non-Enc ciphertext column list is exact: each entry is registered AND exists in the schema as a String column", () => {
    const src = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    // Every *Enc / known non-Enc column in the schema is registered (above); here: the non-Enc list itself is exact.
    for (const [model, cols] of Object.entries(NON_ENC_CIPHERTEXT_COLUMNS)) {
      const entry = ENCRYPTED_COLUMNS.find((e) => e.model === model);
      expect(entry).toBeDefined();
      for (const c of cols) {
        expect(entry!.columns).toContain(c);
        expect(src).toMatch(new RegExp(`^model ${model.charAt(0).toUpperCase()}${model.slice(1)} \\{[\\s\\S]*?^\\s+${c}\\s+String`, "m"));
      }
    }
  });
});

describe("SecretsRotationService", () => {
  async function make(opts: { current: string; previous?: string; seed: (old: CryptoService) => Record<string, Array<Record<string, unknown>>> }) {
    const old = await crypto(OLD);
    const tables = opts.seed(old);
    // every registry model exists (empty) so the scan is total
    for (const e of ENCRYPTED_COLUMNS) tables[e.model] ??= [];
    for (const h of HMAC_COLUMNS) tables[h.model] ??= [];
    for (const j of JSON_SINKS) tables[j.model] ??= [];
    const prisma = fakePrisma(tables);
    const cur = await crypto(opts.current, opts.previous);
    const audit = jest.fn().mockResolvedValue(undefined);
    const svc = new SecretsRotationService(prisma as unknown as PrismaService, cur, { log: audit } as unknown as AuditService);
    return { svc, cur, old, tables, prisma, audit };
  }

  it("status counts current / stale (legacy or previous-key) / unreadable values per model without decrypting", async () => {
    const m = await make({
      current: NEW,
      previous: OLD,
      seed: (old) => ({
        application: [
          { id: "a1", envEnc: old.encrypt("E"), gitTokenEnc: legacy(old, "T"), buildArgsEnc: null, buildSecretsEnc: null, gitSshKeyEnc: null, registryAuthEnc: null, certKeyEnc: null, webhookSecret: null },
          { id: "a2", envEnc: "tk1.ffffffffffffffff.AAAA", gitTokenEnc: null, buildArgsEnc: null, buildSecretsEnc: null, gitSshKeyEnc: null, registryAuthEnc: null, certKeyEnc: null, webhookSecret: null },
        ],
        twoFactorRecoveryCode: [{ id: "c1", codeHash: "x" }, { id: "c2", codeHash: "y" }],
      }),
    });
    // one value already current
    m.tables.application[1].webhookSecret = m.cur.encrypt("W");
    const s = await m.svc.status();
    expect(s.currentKeyId).toBe(m.cur.currentKeyId);
    expect(s.previousKeyIds).toEqual([m.old.currentKeyId]);
    const app = s.models.find((x) => x.model === "application")!;
    expect(app).toMatchObject({ current: 1, stale: 2, unreadable: 1 });
    expect(s.totals).toMatchObject({ current: 1, stale: 2, unreadable: 1 });
    expect(s.hmacRowsOnOldKeys).toEqual([{ model: "twoFactorRecoveryCode", column: "codeHash", count: 2 }]);
    expect(s.previousKeyRemovable).toBe(false);
    expect(s.running).toBe(false);
  });

  it("re-encrypts every stale value under the current key with a CAS on the old ciphertext, leaves unreadable ones, is idempotent, and audits counts only", async () => {
    const m = await make({
      current: NEW,
      previous: OLD,
      seed: (old) => ({
        application: [{ id: "a1", envEnc: old.encrypt('{"K":"v"}'), gitTokenEnc: legacy(old, "ghs_x"), buildArgsEnc: null, buildSecretsEnc: null, gitSshKeyEnc: null, registryAuthEnc: null, certKeyEnc: null, webhookSecret: null }],
        registry: [{ id: "r1", passwordEnc: "tk1.ffffffffffffffff.AAAA" }],
        instanceSettings: [{ id: "singleton", oidcClientSecretEnc: null, mailPassEnc: legacy(old, "pw"), mailResendKeyEnc: null }],
      }),
    });
    const run = await m.svc.runNow("owner1");
    expect(run).toMatchObject({ rewritten: 3, alreadyCurrent: 0, unreadable: 1, skipped: 0, errors: 0, error: null });
    expect(run.unreadableRefs).toEqual(["registry:r1:passwordEnc"]);
    expect(run.finishedAt).not.toBeNull();
    // values readable under the NEW key alone, plaintext intact
    const fresh = await crypto(NEW);
    expect(fresh.decrypt(m.tables.application[0].envEnc as string)).toBe('{"K":"v"}');
    expect(fresh.decrypt(m.tables.application[0].gitTokenEnc as string)).toBe("ghs_x");
    expect(fresh.decrypt(m.tables.instanceSettings[0].mailPassEnc as string)).toBe("pw");
    expect(m.tables.registry[0].passwordEnc).toBe("tk1.ffffffffffffffff.AAAA"); // untouched
    // CAS shape: WHERE id AND column = old ciphertext
    const call = (m.prisma.application as { updateMany: jest.Mock }).updateMany.mock.calls[0][0];
    expect(Object.keys(call.where)).toEqual(["id", "gitTokenEnc"]); // registry order; the old ciphertext is the guard
    expect(call.where.gitTokenEnc).toMatch(/^[A-Za-z0-9+/=]+$/); // the legacy value it read
    expect(call.data.gitTokenEnc).toMatch(/^tk1\./);
    // audit carries counts, never a value
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.secrets_key.reencrypt", actor: "owner1", meta: expect.objectContaining({ rewritten: 3, unreadable: 1 }) }));
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain("ghs_x");
    // second run: nothing left to rewrite
    const again = await m.svc.runNow("owner1");
    expect(again).toMatchObject({ rewritten: 0, alreadyCurrent: 3, unreadable: 1 });
    const s = await m.svc.status();
    expect(s.totals).toMatchObject({ current: 3, stale: 0, unreadable: 1 });
    expect(s.previousKeyRemovable).toBe(false); // the unreadable one still needs its key
  });

  it("a value a user changed between the read and the rewrite is never clobbered (CAS misses → skipped); previousKeyRemovable once all is current", async () => {
    const m = await make({ current: NEW, previous: OLD, seed: (old) => ({ sharedVariable: [{ id: "s1", valueEnc: old.encrypt("old-value") }] }) });
    const d = m.prisma.sharedVariable as { findMany: jest.Mock; updateMany: jest.Mock };
    const realUpdate = d.updateMany.getMockImplementation()!;
    d.updateMany.mockImplementationOnce(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      // concurrent legitimate write lands first
      m.tables.sharedVariable[0].valueEnc = m.cur.encrypt("user-changed");
      return realUpdate(args);
    });
    const run = await m.svc.runNow("o");
    expect(run).toMatchObject({ rewritten: 0, skipped: 1 });
    expect(m.cur.decrypt(m.tables.sharedVariable[0].valueEnc as string)).toBe("user-changed");
    const s = await m.svc.status();
    expect(s.totals).toMatchObject({ current: 1, stale: 0, unreadable: 0 });
    expect(s.previousKeyRemovable).toBe(true);
  });

  it("pages by id cursor (take 200) and refuses a second concurrent run (409)", async () => {
    const m = await make({ current: NEW, previous: OLD, seed: (old) => ({ sharedVariable: Array.from({ length: 450 }, (_, i) => ({ id: `s${String(i).padStart(4, "0")}`, valueEnc: old.encrypt(`v${i}`) })) }) });
    const run = m.svc.start("o");
    expect(() => m.svc.start("o")).toThrow(ConflictException);
    while ((await m.svc.status()).running) await new Promise((r) => setTimeout(r, 5));
    expect(run.rewritten).toBe(450);
    const d = m.prisma.sharedVariable as { findMany: jest.Mock };
    const paged = d.findMany.mock.calls.map((c) => c[0]).filter((a) => a.cursor); // status() polls interleave
    expect(paged).toEqual(expect.arrayContaining([expect.objectContaining({ take: 200, skip: 1, cursor: { id: "s0199" } }), expect.objectContaining({ take: 200, skip: 1, cursor: { id: "s0399" } })]));
    expect(d.findMany.mock.calls[0][0]).toMatchObject({ take: 200, orderBy: { id: "asc" }, select: { id: true, valueEnc: true } });
  });

  it("rewrites priorEnc snapshots INSIDE BulkOperation.meta with a CAS on the whole JSON, and counts them in status", async () => {
    const m = await make({
      current: NEW,
      previous: OLD,
      seed: (old) => ({
        bulkOperation: [
          { id: "op1", meta: { source: "coolify", remapUndo: { appliedAt: "t", planHash: "h", apps: [{ appId: "a", name: "x", priorEnc: old.encrypt('{"A":"1"}'), keys: ["A"] }, { appId: "b", name: "y", priorEnc: legacy(old, '{"B":"2"}'), keys: ["B"] }] } } },
          { id: "op2", meta: { source: "coolify" } },
          { id: "op3", meta: null },
        ],
      }),
    });
    const before = await m.svc.status();
    expect(before.models.find((x) => x.model === "bulkOperation.meta")).toMatchObject({ current: 0, stale: 2, unreadable: 0 });
    const run = await m.svc.runNow("o");
    expect(run).toMatchObject({ rewritten: 2, skipped: 0, unreadable: 0, errors: 0 });
    const d = m.prisma.bulkOperation as { updateMany: jest.Mock };
    expect(d.updateMany).toHaveBeenCalledTimes(1);
    expect(d.updateMany.mock.calls[0][0].where).toMatchObject({ id: "op1", meta: { equals: expect.objectContaining({ source: "coolify" }) } });
    const meta = m.tables.bulkOperation[0].meta as { source: string; remapUndo: { appliedAt: string; apps: Array<{ priorEnc: string; keys: string[] }> } };
    expect(meta.source).toBe("coolify");
    expect(meta.remapUndo.appliedAt).toBe("t");
    const fresh = await crypto(NEW);
    expect(fresh.decrypt(meta.remapUndo.apps[0].priorEnc)).toBe('{"A":"1"}');
    expect(fresh.decrypt(meta.remapUndo.apps[1].priorEnc)).toBe('{"B":"2"}');
    expect(meta.remapUndo.apps[1].keys).toEqual(["B"]);
    expect((await m.svc.status()).totals).toMatchObject({ current: 2, stale: 0, unreadable: 0 });
  });
});
