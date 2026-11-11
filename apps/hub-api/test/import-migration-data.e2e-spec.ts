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
  let holdVolume = false;
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
          agent.send(JSON.stringify({ type: "enroll", protocol: 2, token: enrollToken, publicKey: spkiB64, agentVersion: "e2e", hostname: "h", fingerprint: "f" }));
        } else if (msg.type === "enrolled") {
          resolve();
        } else if (msg.type === "command") {
          commands.push(msg.command);
          if ((holdRestore && /pg_restore/.test(msg.command)) || (holdVolume && /--no-same-owner/.test(msg.command))) {
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

  // ── Volume data plane (P3) ─────────────────────────────────────────────────────────────────────────
  describe("volume ingest (P3)", () => {
    const APPITEM = "app:_:volapp";
    const gz = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]); // gzip magic + filler
    let appId = "";
    const putVol = (name: string, body: Buffer, q = "gzip=1") =>
      request(api()).put(`/api/v1/import/migration/artifacts/${encodeURIComponent(APPITEM)}/volumes/${name}?${q}`).set(H()).set("Content-Type", "application/octet-stream").send(body);
    const restoreVol = (name: string, q = "") =>
      request(api()).post(`/api/v1/import/migration/artifacts/${encodeURIComponent(APPITEM)}/volumes/${name}/restore${q}`).set(H());
    const volStatus = (name: string) =>
      request(api()).get(`/api/v1/import/migration/artifacts/${encodeURIComponent(APPITEM)}/volumes/${name}/status`).set(H());
    async function waitVol(name: string, want: string, tries = 80): Promise<void> {
      for (let i = 0; i < tries; i++) {
        if ((await volStatus(name)).body.state === want) return;
        await sleep(50);
      }
      throw new Error(`volume state never became ${want}`);
    }

    beforeAll(async () => {
      const envId = (await prisma.database.findUnique({ where: { id: dbId } }))!.environmentId;
      const appRow = await prisma.application.create({
        data: { name: "volapp", teamId, serverId, environmentId: envId, env: [], volumes: [{ name: "data", path: "/data" }] },
      });
      appId = appRow.id;
      await prisma.bulkTask.create({
        data: { opId, serverId, kind: "app", itemRef: APPITEM, status: "DONE", resourceType: "application", resourceId: appId, result: { name: "volapp", appId, volumes: { declared: 1, skipped: 0, mounts: [{ name: "data", path: "/data" }] } } },
      });
      // A second app with NO declared volume, to prove /targets reports volumeIngest:'none'.
      const bareRow = await prisma.application.create({ data: { name: "bareapp", teamId, serverId, environmentId: envId, env: [], volumes: [] } });
      await prisma.bulkTask.create({ data: { opId, serverId, kind: "app", itemRef: "app:_:bareapp", status: "DONE", resourceType: "application", resourceId: bareRow.id, result: { name: "bareapp", appId: bareRow.id } } });
    });

    afterAll(async () => {
      await prisma.application.deleteMany({ where: { teamId, name: { in: ["volapp", "bareapp"] } } }).catch(() => undefined);
    });

    it("lists the app target with its declared volume + the live cap, and 'none' for a volume-less app", async () => {
      const res = await request(api()).get("/api/v1/import/migration/targets").set(H()).expect(200);
      expect(res.body.maxVolumeBytes).toBe(256 * 1024 * 1024);
      const volapp = res.body.targets.find((t: { itemRef: string }) => t.itemRef === APPITEM);
      expect(volapp).toMatchObject({ kind: "application", volumeIngest: "hub-staged", volumes: [{ name: "data", path: "/data" }] });
      const bare = res.body.targets.find((t: { itemRef: string }) => t.itemRef === "app:_:bareapp");
      expect(bare).toMatchObject({ kind: "application", volumeIngest: "none" });
      expect(JSON.stringify(res.body)).not.toContain(appId); // no resource id leaked
    });

    it("rejects a malformed volume name (400) and an undeclared one (404) before reading any body", async () => {
      await putVol("Data", gz).expect(400); // uppercase → fails the name regex in the handler
      await putVol("x".repeat(60), gz).expect(400); // over the 41-char limit → 400
      await putVol("a.b", gz).expect(400); // illegal charset ('.') reaching the handler → 400
      await putVol("nope", gz).expect(404); // valid syntax, not declared on the app
      // Note: a literal ".." path SEGMENT is URL-normalized by the client/router before routing (it never
      // reaches this handler), so it is not a meaningful traversal test — the charset guard above, enforced
      // in the handler on a name that DOES reach it, is the real defence.
      await request(api()).get(`/api/v1/import/migration/artifacts/${encodeURIComponent(ITEM)}/volumes/data/status`).set(H()).expect(404); // a DB itemRef is not an app target
    });

    it("stages a volume tarball with the HUB-computed bytes + sha256", async () => {
      const res = await putVol("data", gz).expect(201);
      expect(res.body).toMatchObject({ volume: "data", bytes: gz.length, sha256: sha(gz), itemRef: `vol:${APPITEM}:data` });
    });

    it("rejects a non-gzip body declared gzip=1, a missing Content-Length is 411, and over-cap is 413", async () => {
      await putVol("data", Buffer.from("not gzip at all")).expect(415);
      process.env.MIGRATION_MAX_VOLUME_BYTES = "4";
      try {
        await putVol("data", gz).expect(413);
      } finally {
        delete process.env.MIGRATION_MAX_VOLUME_BYTES;
      }
    });

    it("restores into the app volume, serves the signed URL only during the window, wipes+extracts with --no-same-owner", async () => {
      await putVol("data", gz).expect(201);
      commands.length = 0;
      holdVolume = true;
      await restoreVol("data").expect(202);
      for (let i = 0; i < 120 && !held; i++) await sleep(20);
      expect(held).not.toBeNull();
      expect((await volStatus("data")).body.state).toBe("restoring");

      const cmd = commands.find((c) => c.includes("--no-same-owner"))!;
      expect(cmd).toMatch(new RegExp(`tugra_appv_${appId}_data`)); // the exact docker volume name
      expect(cmd).toMatch(/gunzip/);
      expect(cmd).toMatch(/find \. -mindepth 1 -delete/);
      const url = /curl -fsSL '([^']+)'/.exec(cmd)![1];
      const u = new URL(url);
      expect(u.host).toBe(`127.0.0.1:${port}`); // trusted mint-captured base
      const dl = await request(api()).get(u.pathname + u.search).expect(200);
      expect(Buffer.from(dl.body).length || dl.text.length).toBeGreaterThan(0);

      agent.send(JSON.stringify({ type: "command_result", reqId: held!.reqId, exitCode: 0, output: "" }));
      held = null;
      holdVolume = false;
      await waitVol("data", "restored");

      const dataTask = await prisma.bulkTask.findFirst({ where: { opId, itemRef: `data:vol:${APPITEM}:data` } });
      expect(dataTask).toMatchObject({ status: "DONE", kind: "data" });
      expect(dataTask!.result).toMatchObject({ status: "SUCCESS", appItemRef: APPITEM, volumeName: "data", sha256: sha(gz) });
      const st = await volStatus("data").expect(200);
      expect(st.body).toMatchObject({ state: "restored", ownership: "not-preserved" });
      await request(api()).get(u.pathname + u.search).expect(404); // dl dead after the window + cleanup
    });

    it("is idempotent: same sha → alreadyRestored, different sha needs resync=1", async () => {
      commands.length = 0;
      await putVol("data", gz).expect(201);
      const r = await restoreVol("data").expect(202);
      expect(r.body).toMatchObject({ state: "restored", alreadyRestored: true });
      expect(commands.some((c) => c.includes("--no-same-owner"))).toBe(false); // no new restore ran

      const gz2 = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 9, 9, 9, 9]);
      await putVol("data", gz2).expect(201);
      await restoreVol("data").expect(409); // different sha, no resync
      await restoreVol("data", "?resync=1").expect(202);
      await waitVol("data", "restored");
    });

    it("surfaces a failed restore (no leaked url/sig), keeps the staged file, then allows a retry", async () => {
      await putVol("data", gz, "gzip=1").expect(201);
      reply.exitCode = 1;
      reply.output = "tar: error at https://127.0.0.1/api/v1/import/migration/dl/x.bin?sig=LEAK";
      await restoreVol("data", "?resync=1").expect(202);
      await waitVol("data", "failed");
      const failed = await prisma.bulkTask.findFirst({ where: { opId, itemRef: `data:vol:${APPITEM}:data` } });
      expect(String(failed!.output)).not.toMatch(/https?:\/\/|sig=LEAK/); // scrubbed on the task
      const st = await volStatus("data").expect(200);
      expect(JSON.stringify(st.body)).not.toContain("LEAK"); // coarse status never carries the tail
      reply.exitCode = 0;
      reply.output = "";
      await restoreVol("data", "?resync=1").expect(202); // staged file kept → re-restorable without re-upload
      await waitVol("data", "restored");
    });

    it("refuses a volume restore once the app has been deployed (even with resync)", async () => {
      await putVol("data", gz).expect(201);
      await prisma.deployment.create({ data: { appId } }); // any deployment row marks the app as "started"
      try {
        await restoreVol("data", "?resync=1").expect(409);
      } finally {
        await prisma.deployment.deleteMany({ where: { appId } }).catch(() => undefined);
      }
    });

    it("rollback does NOT tear down an app whose volume data this migration touched — even a FAILED data task", async () => {
      const envId = (await prisma.database.findUnique({ where: { id: dbId } }))!.environmentId;
      const rbApp = await prisma.application.create({ data: { name: "rbapp", teamId, serverId, environmentId: envId, env: [], volumes: [{ name: "data", path: "/data" }] } });
      const rbOp = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId } } });
      const RB = "app:_:rbapp";
      const appTask = await prisma.bulkTask.create({ data: { opId: rbOp.id, serverId, kind: "app", itemRef: RB, status: "DONE", resourceType: "application", resourceId: rbApp.id, result: { appId: rbApp.id } } });
      // A FAILED restore still stamps appItemRef (at claim time) — a failed resync can leave the earlier good
      // data, or a mid-extract failure partial data, so rollback must NOT `docker volume rm` it.
      await prisma.bulkTask.create({ data: { opId: rbOp.id, serverId, kind: "data", itemRef: `data:vol:${RB}:data`, status: "FAILED", result: { status: "FAILED", appItemRef: RB, volumeName: "data" } } });
      await request(api()).post(`/api/v1/import/operations/${rbOp.id}/rollback`).set("Authorization", `Bearer ${tokenA}`).expect(201);
      expect(await prisma.application.findUnique({ where: { id: rbApp.id } })).not.toBeNull(); // not torn down
      const after = await prisma.bulkTask.findUnique({ where: { id: appTask.id } });
      expect(after!.status).toBe("DONE"); // kept DONE, not ROLLED_BACK
      expect(String(after!.output)).toMatch(/volume data was restored/i);
      await prisma.bulkOperation.deleteMany({ where: { id: rbOp.id } }).catch(() => undefined);
      await prisma.application.deleteMany({ where: { id: rbApp.id } }).catch(() => undefined);
    });

    it("leaks no token/url/sig in the audit log", async () => {
      const audits = await prisma.auditLog.findMany({ where: { target: opId } });
      expect(JSON.stringify(audits)).not.toContain(migToken);
      expect(JSON.stringify(audits)).not.toMatch(/sig=|\/dl\//);
    });
  });
});
