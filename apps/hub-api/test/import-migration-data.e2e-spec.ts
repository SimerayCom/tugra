import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app-config";
import { PrismaService } from "../src/prisma/prisma.service";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// End-to-end DATA proof for S3: the source host (migration token) streams a DB dump to the hub, the hub
// restores it into the provisioned DB via the existing importFromUrl, and the TARGET agent fetches the
// signed dl URL. The agent is a FAKE ws peer that only ACKs commands, so no Docker is needed; assertions
// are on hub effects (Restore rows, tasks, audit, the served bytes). Routes run under /api/v1 (configureApp).
describe("Importer migration DATA ingest (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  let agent: WebSocket;
  const emailA = `mdA-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const emailB = `mdB-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  let tokenA = "";
  let tokenB = "";
  let userAId = "";
  let teamId = "";
  let serverId = "";
  let dbId = "";
  let opId = "";
  let migToken = "";
  const ITEM = "database:_:src-pg";

  const commands: string[] = [];
  const reply = { exitCode: 0, output: "" };
  let holdRestore = false;
  let held: { reqId: string } | null = null;

  const api = () => app.getHttpServer();
  const H = () => ({ Authorization: `Bearer ${migToken}` });

  async function seedOp() {
    const op = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId } } });
    await prisma.bulkTask.create({ data: { opId: op.id, serverId, kind: "database", itemRef: ITEM, status: "DONE", resourceType: "database", resourceId: dbId } });
    return op.id;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (api().address() as AddressInfo).port;

    const regA = await request(api()).post("/api/v1/auth/register").send({ email: emailA, password: "supersecret123", name: "A" }).expect(201);
    tokenA = regA.body.tokens.accessToken;
    userAId = regA.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId: userAId } }))!.teamId;
    const regB = await request(api()).post("/api/v1/auth/register").send({ email: emailB, password: "supersecret123", name: "B" }).expect(201);
    tokenB = regB.body.tokens.accessToken;

    const srv = await request(api()).post("/api/v1/servers").set("Authorization", `Bearer ${tokenA}`).send({ name: "md-node", teamId }).expect(201);
    serverId = srv.body.server.id;
    const enrollToken = srv.body.enrollToken;
    const { publicKey } = generateKeyPairSync("ed25519");
    const spkiB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    agent = new WebSocket(`ws://127.0.0.1:${port}/agent`);
    await new Promise<void>((resolve, reject) => {
      agent.on("error", reject);
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "challenge") {
          agent.send(JSON.stringify({ type: "enroll", protocol: 1, token: enrollToken, publicKey: spkiB64, agentVersion: "e2e", hostname: "h", fingerprint: "f" }));
        } else if (msg.type === "enrolled") {
          resolve();
        } else if (msg.type === "command") {
          commands.push(msg.command);
          if (holdRestore && /pg_restore/.test(msg.command)) {
            held = { reqId: msg.reqId }; // keep the restore in-flight so the dl window stays open (not the provision)
            return;
          }
          agent.send(JSON.stringify({ type: "command_result", reqId: msg.reqId, exitCode: reply.exitCode, output: reply.output }));
        }
      });
    });

    const dbRes = await request(api()).post("/api/v1/databases").set("Authorization", `Bearer ${tokenA}`).send({ name: "appdb", serverId, engine: "POSTGRES" }).expect(201);
    dbId = dbRes.body.id;
    opId = await seedOp();
    const mint = await request(api()).post(`/api/v1/import/operations/${opId}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(201);
    migToken = mint.body.token;
  });

  afterAll(async () => {
    agent?.close();
    await prisma.bulkOperation.deleteMany({ where: { actorId: userAId } }).catch(() => undefined);
    await prisma.database.deleteMany({ where: { id: dbId } }).catch(() => undefined);
    await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }).catch(() => undefined);
    await app.close();
  });

  const put = (body: Buffer, q = "gzip=0&format=custom") =>
    request(api()).put(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}?${q}`).set(H()).set("Content-Type", "application/octet-stream").send(body);
  const statusOf = () => request(api()).get(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/status`).set(H());
  async function waitState(want: string, tries = 60): Promise<void> {
    for (let i = 0; i < tries; i++) {
      const r = await statusOf();
      if (r.body.state === want) return;
      await sleep(50);
    }
    throw new Error(`state never became ${want}`);
  }

  it("lists DB targets without exposing any resource id or credential", async () => {
    const res = await request(api()).get("/api/v1/import/migration/targets").set(H()).expect(200);
    expect(res.body.targets).toEqual([expect.objectContaining({ itemRef: ITEM, kind: "database", engine: "POSTGRES" })]);
    expect(res.body.targets[0].dataPlane).toBeUndefined(); // POSTGRES is streamable → no unsupported marker
    expect(JSON.stringify(res.body)).not.toContain(dbId);
  });

  it("serves the per-engine dump recipes (secret-free) and the explicit unsupported set", async () => {
    const res = await request(api()).get("/api/v1/import/migration/recipes").set(H()).expect(200);
    expect(res.body.v).toBe(1);
    expect(Object.keys(res.body.recipes).sort()).toEqual(["DRAGONFLY", "KEYDB", "MARIADB", "MYSQL", "POSTGRES", "REDIS"]);
    for (const r of Object.values<{ command: string }>(res.body.recipes)) {
      expect(r.command.startsWith("docker exec ")).toBe(true);
      expect(r.command).not.toContain("TUGRA_SENT_"); // no sentinel leaked
      expect(r.command).not.toContain("TUGRA_SRC_PW"); // password never a host-expanded ref
    }
    expect(res.body.recipes.POSTGRES).toMatchObject({ format: "pg_custom", pgFormat: "custom", env: [{ name: "PGPASSWORD", from: "pw" }] });
    // ClickHouse + Mongo are explicitly flagged, not silently absent
    expect(res.body.unsupported).toMatchObject({ CLICKHOUSE: "requires-S4b", MONGO: "requires-S4b", LIBSQL: "no-logical-dump" });
    expect(res.body.recipes.MONGO).toBeUndefined();
  });

  it("marks an unstreamable engine's target dataPlane=unsupported so the source skips it explicitly", async () => {
    const mdb = (await request(api()).post("/api/v1/databases").set("Authorization", `Bearer ${tokenA}`).send({ name: "mongo-src", serverId, engine: "MONGO" }).expect(201)).body.id;
    const mop = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId } } });
    await prisma.bulkTask.create({ data: { opId: mop.id, serverId, kind: "database", itemRef: "database:_:mongo-src", status: "DONE", resourceType: "database", resourceId: mdb } });
    const mtok = (await request(api()).post(`/api/v1/import/operations/${mop.id}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(201)).body.token;
    const res = await request(api()).get("/api/v1/import/migration/targets").set("Authorization", `Bearer ${mtok}`).expect(200);
    expect(res.body.targets).toEqual([expect.objectContaining({ kind: "database", engine: "MONGO", dataPlane: "unsupported", reason: "requires-S4b" })]);
    // the contract is SERVER-ENFORCED, not just advertised: a non-conforming client cannot stage an unsupported engine
    await request(api())
      .put(`/api/v1/import/migration/artifacts/${encodeURIComponent("database:_:mongo-src")}?gzip=0&format=custom`)
      .set("Authorization", `Bearer ${mtok}`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("x"))
      .expect(400);
    await prisma.bulkOperation.deleteMany({ where: { id: mop.id } }).catch(() => undefined);
    await prisma.database.deleteMany({ where: { id: mdb } }).catch(() => undefined);
  });

  it("stages an artifact with the HUB-computed byte count + sha256 (never a host-claimed hash)", async () => {
    const body = Buffer.from("PGDMP\x00\x01 custom dump");
    const res = await put(body).expect(201);
    expect(res.body).toMatchObject({ itemRef: ITEM, bytes: body.length, sha256: sha(body), pgFormat: "custom" });
  });

  it("restores into the provisioned DB, serves the signed URL only during the window, and records it", async () => {
    const body = Buffer.from("PGDMP\x00\x01 custom dump"); // same bytes already staged
    commands.length = 0;
    holdRestore = true;
    await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore`).set(H()).expect(202);
    for (let i = 0; i < 100 && !held; i++) await sleep(20); // wait until the restore command reaches the (held) agent
    expect(held).not.toBeNull();
    expect((await statusOf()).body.state).toBe("restoring");

    // The restore command curls the hub-minted dl URL; fetch it WHILE the restore is in flight → 200 + bytes.
    const restoreCmd = commands.find((c) => c.includes("pg_restore"))!;
    expect(restoreCmd).toMatch(/pg_restore --no-owner --clean --if-exists --single-transaction/);
    const url = /curl -fsSL '([^']+)'/.exec(restoreCmd)![1];
    const u = new URL(url);
    const dl = await request(api()).get(u.pathname + u.search).expect(200);
    expect(Buffer.from(dl.body).length || dl.text.length).toBeGreaterThan(0);

    // Release the held restore → it completes.
    agent.send(JSON.stringify({ type: "command_result", reqId: held!.reqId, exitCode: 0, output: "" }));
    held = null;
    holdRestore = false;
    await waitState("restored");

    expect(commands.some((c) => /docker run/.test(c))).toBe(true); // provisioned the NEW db first
    const restore = await prisma.restore.findFirst({ where: { databaseId: dbId }, orderBy: { createdAt: "desc" } });
    expect(restore).toMatchObject({ kind: "IMPORT_URL", status: "SUCCESS", exitCode: 0, createdBy: userAId });
    expect((await prisma.database.findUnique({ where: { id: dbId } }))!.status).toBe("RUNNING");
    const dataTask = await prisma.bulkTask.findFirst({ where: { opId, itemRef: `data:${ITEM}` } });
    expect(dataTask).toMatchObject({ status: "DONE", kind: "data", resourceType: null });
    expect((dataTask!.result as { sha256?: string }).sha256).toBe(sha(body));
    expect(await prisma.auditLog.findFirst({ where: { action: "import.migration.ingest", target: opId } })).not.toBeNull();

    // The dl URL is dead once the restore window closed + the staged file was deleted.
    await request(api()).get(u.pathname + u.search).expect(404);
  });

  it("SSRF-safe: the agent download origin is the mint-captured base, never a forged ingest Host header", async () => {
    await put(Buffer.from("PGDMP\x00\x01 custom dump")).expect(201); // re-stage (the success above cleaned it up)
    commands.length = 0;
    holdRestore = true;
    await request(api())
      .post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore?resync=1`)
      .set(H())
      .set("X-Forwarded-Host", "evil.example")
      .set("X-Forwarded-Proto", "https")
      .expect(202);
    for (let i = 0; i < 100 && !held; i++) await sleep(20);
    expect(held).not.toBeNull();
    const url = /curl -fsSL '([^']+)'/.exec(commands.find((c) => c.includes("pg_restore"))!)![1];
    expect(new URL(url).host).toBe(`127.0.0.1:${port}`); // the trusted mint-captured base — NOT evil.example
    agent.send(JSON.stringify({ type: "command_result", reqId: held!.reqId, exitCode: 0, output: "" }));
    held = null;
    holdRestore = false;
    await waitState("restored");
  });

  it("is idempotent: re-staging the same bytes then re-restoring is a no-op, different bytes need resync=1", async () => {
    const same = Buffer.from("PGDMP\x00\x01 custom dump");
    commands.length = 0;
    await put(same).expect(201); // identical bytes → same sha (idempotent re-stage)
    const r = await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore`).set(H()).expect(202);
    expect(r.body).toMatchObject({ state: "restored", alreadyRestored: true }); // no-op: already restored, body carries it
    expect(commands.some((c) => c.includes("pg_restore"))).toBe(false); // no new restore ran

    await put(Buffer.from("PGDMP\x00\x02 DIFFERENT dump")).expect(201);
    await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore`).set(H()).expect(409); // different sha, no resync
    await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore?resync=1`).set(H()).expect(202);
    await waitState("restored");
  });

  it("surfaces a failed restore as state 'failed' with no leaked detail, then allows a fresh retry", async () => {
    await put(Buffer.from("PGDMP\x00 will fail")).expect(201);
    reply.exitCode = 1;
    reply.output = "pg_restore: error: boom";
    await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore?resync=1`).set(H()).expect(202);
    await waitState("failed");
    const st = await statusOf().expect(200);
    expect(st.body.state).toBe("failed");
    expect(JSON.stringify(st.body)).not.toContain("boom"); // coarse state only — no errorTail to the host
    reply.exitCode = 0;
    reply.output = "";
    await put(Buffer.from("PGDMP\x00 retry")).expect(201); // re-claimable after a failure
    await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/restore?resync=1`).set(H()).expect(202);
    await waitState("restored");
  });

  it("rejects a non-gzip body declared gzip=1 and an oversized artifact", async () => {
    await put(Buffer.from("PGDMP not gzip"), "gzip=1&format=custom").expect(415);
    process.env.MIGRATION_MAX_ARTIFACT_BYTES = "8";
    try {
      await put(Buffer.from("way more than eight bytes"), "gzip=0&format=custom").expect(413);
    } finally {
      delete process.env.MIGRATION_MAX_ARTIFACT_BYTES;
    }
  });

  it("enforces token auth, ownership, and resolves the op from the token alone", async () => {
    await request(api()).get("/api/v1/import/migration/targets").expect(401); // no token
    await request(api()).get("/api/v1/import/migration/targets").set("Authorization", `Bearer ${tokenA}`).expect(401); // a JWT is not a migration token
    await request(api()).get("/api/v1/import/migration/recipes").expect(401); // recipes are token-guarded too
    await request(api()).get("/api/v1/import/migration/recipes").set("Authorization", `Bearer ${tokenA}`).expect(401);
    // A different op owned by A, with its own token, cannot reach THIS op's item (dest resolved from the token's op).
    const otherDb = (await request(api()).post("/api/v1/databases").set("Authorization", `Bearer ${tokenA}`).send({ name: "other", serverId, engine: "POSTGRES" }).expect(201)).body.id;
    const otherOp = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId } } });
    await prisma.bulkTask.create({ data: { opId: otherOp.id, serverId, kind: "database", itemRef: "database:_:other", status: "DONE", resourceType: "database", resourceId: otherDb } });
    const otherTok = (await request(api()).post(`/api/v1/import/operations/${otherOp.id}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(201)).body.token;
    await request(api()).get(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/status`).set("Authorization", `Bearer ${otherTok}`).expect(404); // ITEM is not in otherOp
    await prisma.bulkOperation.deleteMany({ where: { id: otherOp.id } }).catch(() => undefined);
    await prisma.database.deleteMany({ where: { id: otherDb } }).catch(() => undefined);
  });

  it("gates volume ingest behind S7 (501) and leaks no token/url/sig anywhere", async () => {
    const vol = await request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/volumes/data`).set(H()).expect(501);
    expect(vol.body).toMatchObject({ requires: "S7" });
    const audits = await prisma.auditLog.findMany({ where: { target: opId } });
    expect(JSON.stringify(audits)).not.toContain(migToken);
    expect(JSON.stringify(audits)).not.toMatch(/sig=|\/dl\//);
  });
});
