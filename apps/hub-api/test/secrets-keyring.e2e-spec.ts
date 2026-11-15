import { Global, INestApplication, Injectable, Module, OnModuleInit } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PrismaModule } from "../src/prisma/prisma.module";
import { AuditService } from "../src/audit/audit.service";
import { CryptoModule } from "../src/crypto/crypto.module";
import { CryptoService } from "../src/crypto/crypto.service";
import { PrismaKeyringStore } from "../src/crypto/keyring.store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Real Postgres: the keyring migration, an owner rotating over HTTP with NO restart, a simulated restart (a fresh
// CryptoService on the same DB), the re-encrypt job, retire/restore and the "Back to .env key" downgrade path.
// The shared e2e DB is restored at the end: every value is back under the .env key and the keyring rows are removed.
describe("secrets keyring (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  const password = "supersecret123";
  const mk = () => `kr-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const emails = [mk(), mk()];
  let jwt = "";
  let jwt2 = "";
  let userId = "";
  let teamId = "";
  const srv = () => app.getHttpServer();
  const auth = (t = jwt) => ({ Authorization: `Bearer ${t}` });
  const status = async () => (await request(srv()).get("/instance/secrets-key").set(auth()).expect(200)).body;
  const waitIdle = async () => {
    for (let i = 0; i < 200; i++) {
      const s = await status();
      if (!s.running) return s;
      await sleep(50);
    }
    throw new Error("re-encrypt never finished");
  };
  const wipeKeyring = async () => {
    await prisma.secretsKey.deleteMany({});
    await prisma.secretsKeyring.update({ where: { id: "singleton" }, data: { epoch: 0 } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    crypto = app.get(CryptoService);
    await app.listen(0);
    await wipeKeyring(); // deterministic start, then reload the ring
    await crypto.applyRing(await new PrismaKeyringStore(prisma).load());
    const reg = await request(srv()).post("/auth/register").send({ email: emails[0], password, name: "Ring" }).expect(201);
    jwt = reg.body.tokens.accessToken;
    userId = reg.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId } }))!.teamId;
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: true } });
    const reg2 = await request(srv()).post("/auth/register").send({ email: emails[1], password, name: "Plain" }).expect(201);
    jwt2 = reg2.body.tokens.accessToken;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: emails } } }).catch(() => undefined);
    await app.close();
  });

  it("the migration created the three tables with the singleton row, and a fresh install has an env-only ring", async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_name IN ('SecretsKey','SecretsKeyWrap','SecretsKeyring') ORDER BY 1`;
    expect(tables.map((t) => t.table_name)).toEqual(["SecretsKey", "SecretsKeyWrap", "SecretsKeyring"]);
    const ring = await prisma.secretsKeyring.findUnique({ where: { id: "singleton" } });
    expect(ring?.epoch).toBe(0);
    const s = await status();
    expect(s.epoch).toBe(0);
    expect(s.degraded).toBeNull();
    expect(s.downgradeSafe).toBe(true);
    expect(s.keys.every((k: { source: string }) => k.source === "env")).toBe(true);
    expect(s.keys[0]).toMatchObject({ id: s.currentKeyId, role: "active" });
    // previous (pre-keyring) fields are all still there
    for (const f of ["currentKeyId", "previousKeyIds", "models", "totals", "hmacRowsOnOldKeys", "previousKeyRemovable", "running", "lastRun"]) expect(s).toHaveProperty(f);
  });

  it("is owner-only and session-only", async () => {
    await request(srv()).post("/instance/secrets-key/rotate").set(auth(jwt2)).send({ expectedCurrentKeyId: "0123456789abcdef" }).expect(403);
    await request(srv()).get("/instance/secrets-key").set(auth(jwt2)).expect(403);
    await request(srv()).post("/instance/secrets-key/rotate").send({ expectedCurrentKeyId: "0123456789abcdef" }).expect(401);
    await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: "short" }).expect(400);
    await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: "0123456789abcdef", key: "x" }).expect(400);
    await request(srv()).post("/instance/secrets-key/keys/not-hex/retire").set(auth()).expect(400);
  });

  let envKeyId = "";
  let dk1 = "";
  let dk2 = "";
  const varRow = async (key: string) => (await prisma.sharedVariable.findFirst({ where: { teamId, key } }))!;
  const addVar = (key: string, value: string) => request(srv()).post("/shared-variables").set(auth()).send({ teamId, key, value }).expect(201);

  it("rotate: no restart, new writes carry the new key id, old rows still decrypt, a stale page is a 409", async () => {
    const s0 = await status();
    envKeyId = s0.currentKeyId;
    await addVar("BEFORE", "old-secret");
    expect(crypto.keyIdOf((await varRow("BEFORE")).valueEnc)).toBe(envKeyId);

    const res = await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: envKeyId, reencrypt: false }).expect(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    dk1 = res.body.keyId;
    expect(dk1).not.toBe(envKeyId);
    expect(res.body).toMatchObject({ epoch: 1, reencryptStarted: false });
    expect(JSON.stringify(res.body)).not.toMatch(/wrapped|tk1\./);

    await addVar("AFTER", "new-secret");
    expect(crypto.keyIdOf((await varRow("AFTER")).valueEnc)).toBe(dk1);
    expect(crypto.decrypt((await varRow("BEFORE")).valueEnc)).toBe("old-secret"); // env-key row still readable
    expect(crypto.decrypt((await varRow("AFTER")).valueEnc)).toBe("new-secret");

    const stale = await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: envKeyId }).expect(409);
    expect(stale.body.code).toBe("stale_current");

    const s = await status();
    expect(s.currentKeyId).toBe(dk1);
    expect(s.keys.find((k: { id: string }) => k.id === dk1)).toMatchObject({ source: "ring", role: "active" });
    expect(s.keys.find((k: { id: string }) => k.id === envKeyId)).toMatchObject({ source: "env", role: "root" });
    expect(s.downgradeSafe).toBe(false); // AFTER lives under the data key
  });

  it("the database alone holds no usable key: wraps are secretbox ciphertext, and without the .env root they open nothing", async () => {
    const wraps = await prisma.secretsKeyWrap.findMany({ where: { keyId: dk1 } });
    expect(wraps).toHaveLength(1); // one env root configured in the e2e env
    expect(wraps[0].rootKeyId).toBe(envKeyId);
    const wrongRoot = new CryptoService({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? "a-different-root-passphrase-000" : undefined) } as unknown as ConfigService, new PrismaKeyringStore(prisma));
    await wrongRoot.onModuleInit();
    expect(wrongRoot.ringDegraded).toContain(dk1); // cannot unwrap: degraded, not usable
    expect(() => wrongRoot.decrypt(crypto.encrypt("probe"))).toThrow(); // and it reads nothing written under the data key
  });

  it("a restart (a FRESH CryptoService on the same DB) reads old and new secrets; so does a real Nest module consumer's onModuleInit", async () => {
    const fresh = new CryptoService(app.get(ConfigService), new PrismaKeyringStore(prisma));
    await fresh.onModuleInit();
    expect(fresh.currentKeyId).toBe(dk1);
    expect(fresh.decrypt((await varRow("BEFORE")).valueEnc)).toBe("old-secret");
    expect(fresh.decrypt((await varRow("AFTER")).valueEnc)).toBe("new-secret");

    const seen: string[] = [];
    const afterValue = (await varRow("AFTER")).valueEnc;
    @Injectable()
    class EarlyConsumer implements OnModuleInit {
      constructor(private readonly c: CryptoService) {}
      onModuleInit() {
        seen.push(this.c.decrypt(afterValue)); // runs in the first onModuleInit pass, before any keyring service hook
      }
    }
    @Module({ imports: [CryptoModule], providers: [EarlyConsumer] })
    class ConsumerModule {}
    @Global()
    @Module({ providers: [{ provide: AuditService, useValue: { log: async () => undefined } }], exports: [AuditService] })
    class StubAuditModule {}
    const m = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, StubAuditModule, ConsumerModule] }).compile();
    await m.init();
    try {
      expect(seen).toEqual(["new-secret"]);
    } finally {
      await m.close();
    }
  });

  it("rotate again with the re-encrypt job: the job moves everything under the new key, then the old key can be retired (grace first) and restored", async () => {
    const res = await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: dk1, reencrypt: true }).expect(202);
    dk2 = res.body.keyId;
    expect(res.body.reencryptStarted).toBe(true);
    const idle = await waitIdle();
    expect(idle.currentKeyId).toBe(dk2);
    expect(idle.totals.unreadable).toBe(0);
    expect(idle.byKey[dk1] ?? 0).toBe(0);
    expect(crypto.keyIdOf((await varRow("BEFORE")).valueEnc)).toBe(dk2);
    const row1 = idle.keys.find((k: { id: string }) => k.id === dk1);
    expect(row1).toMatchObject({ role: "decrypt-only", referenced: 0, retirable: false, retireBlockedReason: "grace" });

    let r = await request(srv()).post(`/instance/secrets-key/keys/${dk1}/retire`).set(auth()).expect(409);
    expect(r.body.code).toBe("grace");
    await prisma.secretsKey.update({ where: { id: dk1 }, data: { demotedAt: new Date(Date.now() - 120_000) } });
    r = await request(srv()).post(`/instance/secrets-key/keys/${dk1}/retire`).set(auth()).expect(200);
    expect(r.body).toEqual({ keyId: dk1, state: "RETIRED" });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(crypto.describeKeys().map((k) => k.id)).not.toContain(dk1);
    // env keys are not retired here
    const unknown = await request(srv()).post(`/instance/secrets-key/keys/${envKeyId}/retire`).set(auth()).expect(404);
    expect(unknown.body.code).toBe("unknown_key");
    r = await request(srv()).post(`/instance/secrets-key/keys/${dk1}/restore`).set(auth()).expect(200);
    expect(r.body).toEqual({ keyId: dk1, state: "DECRYPT_ONLY" });
    expect(crypto.describeKeys().map((k) => k.id)).toContain(dk1);
  });

  it("Back to .env key: the .env key encrypts again and, once the job finishes, nothing needs a data key (downgradeSafe)", async () => {
    const res = await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: dk2, target: "env-root", reencrypt: true }).expect(202);
    expect(res.body.keyId).toBe(envKeyId);
    const idle = await waitIdle();
    expect(idle.currentKeyId).toBe(envKeyId);
    expect(idle.downgradeSafe).toBe(true);
    expect(idle.keys.find((k: { id: string }) => k.id === envKeyId)).toMatchObject({ role: "active" });
    expect(crypto.keyIdOf((await varRow("AFTER")).valueEnc)).toBe(envKeyId);
    const again = await request(srv()).post("/instance/secrets-key/rotate").set(auth()).send({ expectedCurrentKeyId: envKeyId, target: "env-root" }).expect(409);
    expect(again.body.code).toBe("already_env_root");
  });

  it("the rotate/retire audit trail carries ids only", async () => {
    const rows = await prisma.auditLog.findMany({ where: { actor: userId, action: { startsWith: "instance.secrets_key." } }, orderBy: { createdAt: "asc" } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["instance.secrets_key.rotate", "instance.secrets_key.retire", "instance.secrets_key.restore"]));
    const blob = JSON.stringify(rows.map((r) => r.meta));
    expect(blob).not.toMatch(/tk1\.|wrapped/);
    // leave the shared DB as we found it: no data keys, epoch 0 (every value is back under the .env key already)
    await wipeKeyring();
    await crypto.applyRing(await new PrismaKeyringStore(prisma).load());
    expect(crypto.currentKeyId).toBe(envKeyId);
  });
});
