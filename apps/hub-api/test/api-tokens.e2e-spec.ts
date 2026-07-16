import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("API tokens (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `pat-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let jwt = "";
  let teamId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "PAT" })
      .expect(201);
    jwt = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("mints a token (raw shown once) and authorizes API calls with it", async () => {
    const res = await request(app.getHttpServer())
      .post("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "ci" })
      .expect(201);
    const raw: string = res.body.token;
    expect(raw).toMatch(/^tugra_pat_/);
    expect(res.body.view.prefix).toMatch(/^tugra_pat_/);

    // the PAT authorizes a normal API call (JWT swapped for the token)
    await request(app.getHttpServer())
      .get("/apps")
      .set("Authorization", `Bearer ${raw}`)
      .expect(200);

    // JWT still works (regression)
    await request(app.getHttpServer())
      .get("/apps")
      .set("Authorization", `Bearer ${jwt}`)
      .expect(200);

    // revoke → the token stops working
    const tokenId = res.body.view.id;
    await request(app.getHttpServer())
      .delete(`/api-tokens/${tokenId}`)
      .set("Authorization", `Bearer ${jwt}`)
      .expect(200);
    await request(app.getHttpServer())
      .get("/apps")
      .set("Authorization", `Bearer ${raw}`)
      .expect(401);
  });

  it("rejects a bogus api token", async () => {
    await request(app.getHttpServer())
      .get("/apps")
      .set("Authorization", "Bearer tugra_pat_bogus")
      .expect(401);
  });

  it("lists the caller's tokens", async () => {
    await request(app.getHttpServer())
      .post("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "second", expiresInDays: 30 })
      .expect(201);
    const list = await request(app.getHttpServer())
      .get("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .expect(200);
    expect(list.body.some((t: { name: string }) => t.name === "second")).toBe(true);
    expect(list.body[0]).not.toHaveProperty("tokenHash");
    expect(list.body[0]).toHaveProperty("scopes"); // scopes surfaced on the view
  });

  // ── scope enforcement ──────────────────────────────────────────────────────
  // The ScopesGuard denial carries the exact message "insufficient token scope"; asserting on it lets us
  // distinguish a scope block from any downstream 404/authz that a bogus-id request would otherwise reach.
  const SCOPE_DENIED = "insufficient token scope";
  const mintPat = async (scopes: string[]): Promise<string> => {
    const res = await request(app.getHttpServer())
      .post("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: `scope-${scopes.join("-") || "none"}`, scopes })
      .expect(201);
    expect(res.body.view.scopes).toEqual(scopes);
    return res.body.token;
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it("read PAT: reads list, blocked from writing or deploying", async () => {
    const read = await mintPat(["read"]);
    await request(app.getHttpServer()).get("/apps").set(auth(read)).expect(200);

    const post = await request(app.getHttpServer()).post("/apps").set(auth(read)).send({});
    expect(post.status).toBe(403);
    expect(post.body.message).toBe(SCOPE_DENIED);

    const deploy = await request(app.getHttpServer()).post("/apps/bogus/deploy").set(auth(read)).send({});
    expect(deploy.status).toBe(403);
    expect(deploy.body.message).toBe(SCOPE_DENIED);
  });

  it("write PAT: clears the write gate (method-default) but not the deploy gate", async () => {
    const write = await mintPat(["write"]);
    const post = await request(app.getHttpServer()).post("/apps").set(auth(write)).send({});
    expect(post.body.message).not.toBe(SCOPE_DENIED); // scope satisfied → validation/authz, not a scope block

    const deploy = await request(app.getHttpServer()).post("/apps/bogus/deploy").set(auth(write)).send({});
    expect(deploy.status).toBe(403);
    expect(deploy.body.message).toBe(SCOPE_DENIED); // deploy is independent of write
  });

  it("deploy PAT: clears the deploy gate but not a generic write", async () => {
    const deployPat = await mintPat(["deploy"]);
    const deploy = await request(app.getHttpServer()).post("/apps/bogus/deploy").set(auth(deployPat)).send({});
    expect(deploy.body.message).not.toBe(SCOPE_DENIED);

    const post = await request(app.getHttpServer()).post("/apps").set(auth(deployPat)).send({});
    expect(post.status).toBe(403);
    expect(post.body.message).toBe(SCOPE_DENIED);
  });

  it("read:secrets gates /env; read and write PATs cannot reach it", async () => {
    const read = await mintPat(["read"]);
    const write = await mintPat(["write"]);
    const secrets = await mintPat(["read:secrets"]);

    for (const pat of [read, write]) {
      const res = await request(app.getHttpServer()).get("/apps/bogus/env").set(auth(pat));
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(SCOPE_DENIED);
    }
    const ok = await request(app.getHttpServer()).get("/apps/bogus/env").set(auth(secrets));
    expect(ok.body.message).not.toBe(SCOPE_DENIED); // scope satisfied → falls through to 404/authz
  });

  it("browser session JWT keeps full access (['*']) — never scope-blocked", async () => {
    const post = await request(app.getHttpServer()).post("/apps").set(auth(jwt)).send({});
    expect(post.body.message).not.toBe(SCOPE_DENIED);
    const deploy = await request(app.getHttpServer()).post("/apps/bogus/deploy").set(auth(jwt)).send({});
    expect(deploy.body.message).not.toBe(SCOPE_DENIED);
  });

  it("deploy-gates the restore-class import-from-url route (write PAT blocked)", async () => {
    const write = await mintPat(["write"]);
    const deployPat = await mintPat(["deploy"]);
    const blocked = await request(app.getHttpServer()).post("/databases/bogus/backups/import-from-url").set(auth(write)).send({ url: "https://x/y" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toBe(SCOPE_DENIED);
    const ok = await request(app.getHttpServer()).post("/databases/bogus/backups/import-from-url").set(auth(deployPat)).send({ url: "https://x/y" });
    expect(ok.body.message).not.toBe(SCOPE_DENIED);
  });

  it("deploy-gates scheduled-task create/update (arbitrary in-container exec)", async () => {
    const write = await mintPat(["write"]);
    const deployPat = await mintPat(["deploy"]);
    const blocked = await request(app.getHttpServer()).post("/apps/bogus/tasks").set(auth(write)).send({ name: "x", schedule: "* * * * *", command: "id" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toBe(SCOPE_DENIED);
    const ok = await request(app.getHttpServer()).post("/apps/bogus/tasks").set(auth(deployPat)).send({ name: "x", schedule: "* * * * *", command: "id" });
    expect(ok.body.message).not.toBe(SCOPE_DENIED);
  });

  it("read:secrets-gates the server install command (enroll-token takeover credential)", async () => {
    const read = await mintPat(["read"]);
    const write = await mintPat(["write"]);
    const secrets = await mintPat(["read:secrets"]);
    for (const pat of [read, write]) {
      const res = await request(app.getHttpServer()).get("/servers/bogus/install").set(auth(pat));
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(SCOPE_DENIED);
    }
    const ok = await request(app.getHttpServer()).get("/servers/bogus/install").set(auth(secrets));
    expect(ok.body.message).not.toBe(SCOPE_DENIED);
  });

  it("requires BOTH write and read:secrets to reissue a server enroll token", async () => {
    const write = await mintPat(["write"]);
    const secrets = await mintPat(["read:secrets"]);
    const both = await mintPat(["write", "read:secrets"]);
    for (const pat of [write, secrets]) {
      const res = await request(app.getHttpServer()).post("/servers/bogus/reissue").set(auth(pat));
      expect(res.status).toBe(403);
      expect(res.body.message).toBe(SCOPE_DENIED);
    }
    const ok = await request(app.getHttpServer()).post("/servers/bogus/reissue").set(auth(both));
    expect(ok.body.message).not.toBe(SCOPE_DENIED);
  });

  it("defaults to a read-only token when scopes are omitted (CLI/back-compat)", async () => {
    const res = await request(app.getHttpServer())
      .post("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "no-scopes" })
      .expect(201);
    expect(res.body.view.scopes).toEqual(["read"]);
    const raw: string = res.body.token;
    await request(app.getHttpServer()).get("/apps").set(auth(raw)).expect(200);
    const post = await request(app.getHttpServer()).post("/apps").set(auth(raw)).send({});
    expect(post.status).toBe(403);
    expect(post.body.message).toBe(SCOPE_DENIED);
  });
});
