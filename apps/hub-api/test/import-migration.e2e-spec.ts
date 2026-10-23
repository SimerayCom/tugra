import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// The importer one-time migration token: mint / reissue / migrate-command (user-authenticated) + the
// migration-token guard exercised over HTTP via the public probe (source-host-authenticated). The agent is
// mocked/absent, so no WS/Docker is needed. Routes are at the bare paths (no configureApp), like monitors.e2e.
describe("Importer migration token (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const emailA = `migA-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const emailB = `migB-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  let tokenA = "";
  let tokenB = "";
  let userAId = "";
  let userBId = "";
  let teamId = "";
  let serverId = "";
  let opA = "";
  let opB = "";
  const savedHubUrl = process.env.HUB_PUBLIC_URL;

  // A settled copy-mode import with one provisioned destination — the state in which a migration token may be minted.
  const mkOp = async (actorId: string, over: Record<string, unknown> = {}) => {
    const op = await prisma.bulkOperation.create({ data: { actorId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId }, ...over } });
    await prisma.bulkTask.create({ data: { opId: op.id, serverId, kind: "database", itemRef: `database:${op.id}`, status: "DONE", resourceType: "database", resourceId: `dest-${op.id}` } });
    return op;
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    (app.getHttpServer().address() as AddressInfo).port;

    const regA = await request(app.getHttpServer()).post("/auth/register").send({ email: emailA, password: "supersecret123", name: "A" }).expect(201);
    tokenA = regA.body.tokens.accessToken;
    userAId = regA.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId: userAId } }))!.teamId;

    const regB = await request(app.getHttpServer()).post("/auth/register").send({ email: emailB, password: "supersecret123", name: "B" }).expect(201);
    tokenB = regB.body.tokens.accessToken;
    userBId = regB.body.user.id;

    const srv = await request(app.getHttpServer()).post("/servers").set("Authorization", `Bearer ${tokenA}`).send({ name: "mig-box", teamId }).expect(201);
    serverId = srv.body.server.id;

    opA = (await mkOp(userAId)).id;
    opB = (await mkOp(userAId)).id;
  });

  afterAll(async () => {
    if (savedHubUrl === undefined) delete process.env.HUB_PUBLIC_URL;
    else process.env.HUB_PUBLIC_URL = savedHubUrl;
    await prisma.bulkOperation.deleteMany({ where: { actorId: { in: [userAId, userBId] } } }).catch(() => undefined);
    await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }).catch(() => undefined);
    await app.close();
  });

  const srv = () => app.getHttpServer();
  const TOKEN_RE = /^tugra_mig_[A-Za-z0-9_-]{43}$/;

  it("mints a token + one-line command; stores only the HASH; never leaks the raw token", async () => {
    const res = await request(srv()).post(`/import/operations/${opA}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(201);
    expect(res.body.opId).toBe(opA);
    expect(res.body.token).toMatch(TOKEN_RE);
    expect(res.body.command).toMatch(/^curl -fsSL https?:\/\/\S+\/install\/migrator\.sh \| sh -s -- --hub \S+ --token tugra_mig_\S+$/);
    expect(res.body.command.endsWith(res.body.token)).toBe(true);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    const row = await prisma.bulkOperation.findUnique({ where: { id: opA } });
    expect(row!.migrationTokenHash).toBe(createHash("sha256").update(res.body.token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(res.body.token);
  });

  it("refuses a second mint while a token is live (409) — use reissue to rotate", async () => {
    await request(srv()).post(`/import/operations/${opA}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(409);
  });

  it("rejects mint with no auth (401) and by a non-owner (403)", async () => {
    await request(srv()).post(`/import/operations/${opA}/migration-token`).expect(401);
    await request(srv()).post(`/import/operations/${opA}/migration-token`).set("Authorization", `Bearer ${tokenB}`).expect(403);
  });

  it("409s an op that is not a settled copy-mode import with a destination (local-docker / no DONE task)", async () => {
    const adopt = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "local-docker", serverId } } });
    await request(srv()).post(`/import/operations/${adopt.id}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(409);
    const empty = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId } } });
    await request(srv()).post(`/import/operations/${empty.id}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(409);
  });

  it("authenticates the SOURCE host over HTTP via the probe, resolving the op from the TOKEN alone", async () => {
    const mint = await request(srv()).post(`/import/operations/${opB}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(201);
    const tB = mint.body.token;
    const ok = await request(srv()).get("/import/migration/probe").set("Authorization", `Bearer ${tB}`).expect(200);
    expect(ok.body).toMatchObject({ ok: true, opId: opB });

    // The untrusted host can never name a different destination — opId comes ONLY from the token.
    const spoof = await request(srv())
      .get(`/import/migration/probe?opId=${opA}`)
      .set("Authorization", `Bearer ${tB}`)
      .set("x-op-id", opA)
      .expect(200);
    expect(spoof.body.opId).toBe(opB);
  });

  it("gives ONE uniform 401 for missing / malformed / PAT-family / unknown tokens (no oracle)", async () => {
    const msg = "invalid or expired migration token";
    for (const h of [undefined, "Bearer ", `Bearer tugra_pat_${"a".repeat(43)}`, `Bearer tugra_mig_${"a".repeat(43)}`, `Bearer ${tokenA}`]) {
      const r = request(srv()).get("/import/migration/probe");
      const res = await (h ? r.set("Authorization", h) : r).expect(401);
      expect(res.body.message).toBe(msg);
    }
  });

  it("does not cross-accept: a migration token on a PAT/JWT route is 401", async () => {
    const mint = await mintFresh(opA);
    await request(srv()).get("/servers").set("Authorization", `Bearer ${mint}`).expect(401);
  });

  it("reissue revokes the old token and mints a new one", async () => {
    const first = await mintFresh(opA);
    await request(srv()).get("/import/migration/probe").set("Authorization", `Bearer ${first}`).expect(200);
    const re = await request(srv()).post(`/import/operations/${opA}/migration-token/reissue`).set("Authorization", `Bearer ${tokenA}`).expect(201);
    expect(re.body.token).not.toBe(first);
    await request(srv()).get("/import/migration/probe").set("Authorization", `Bearer ${first}`).expect(401); // old dead
    await request(srv()).get("/import/migration/probe").set("Authorization", `Bearer ${re.body.token}`).expect(200); // new live
  });

  it("migrate-command returns state + a <TOKEN> template, never the live token", async () => {
    await mintFresh(opA);
    const res = await request(srv()).get(`/import/operations/${opA}/migrate-command`).set("Authorization", `Bearer ${tokenA}`).expect(200);
    expect(res.body.active).toBe(true);
    expect(res.body.commandTemplate).toContain("--token <TOKEN>");
    expect(res.body.commandTemplate).not.toContain("tugra_mig_");
    expect(res.body.opId).toBe(opA);
  });

  it("neither the import status view nor GET /bulk/:id exposes the migration-token columns", async () => {
    await mintFresh(opA); // ensure the columns are populated
    const statusView = await request(srv()).get(`/import/operations/${opA}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
    expect(JSON.stringify(statusView.body)).not.toMatch(/migrationToken/i);
    const bulkView = await request(srv()).get(`/bulk/${opA}`).set("Authorization", `Bearer ${tokenA}`).expect(200);
    expect(JSON.stringify(bulkView.body)).not.toMatch(/migrationToken/i);
  });

  it("cancelling an op revokes its live token (command stops working) and records the revoke in the audit log", async () => {
    const op = (await mkOp(userAId)).id;
    const tok = await mintFresh(op);
    await request(srv()).get("/import/migration/probe").set("Authorization", `Bearer ${tok}`).expect(200);
    await request(srv()).post(`/import/operations/${op}/cancel`).set("Authorization", `Bearer ${tokenA}`).expect(201);
    await request(srv()).get("/import/migration/probe").set("Authorization", `Bearer ${tok}`).expect(401);
    const row = await prisma.bulkOperation.findUnique({ where: { id: op } });
    expect(row!.migrationTokenHash).toBeNull();
    const revoke = await prisma.auditLog.findFirst({ where: { action: "import.migration_token.revoke", target: op } });
    expect(revoke).not.toBeNull();
    expect(JSON.stringify(revoke)).not.toContain(tok);
  });

  it("400s a forged, shell-unsafe hub host rather than emitting an injectable command (HUB_PUBLIC_URL unset)", async () => {
    const op = (await mkOp(userAId)).id;
    delete process.env.HUB_PUBLIC_URL;
    await request(srv())
      .post(`/import/operations/${op}/migration-token`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("x-forwarded-host", "evil.test;rm -rf /")
      .set("x-forwarded-proto", "http")
      .expect(400);
    // nothing left behind: a clean mint still succeeds afterwards
    await request(srv()).post(`/import/operations/${op}/migration-token`).set("Authorization", `Bearer ${tokenA}`).expect(201);
  });

  // Mint a fresh token by rotating (reissue always overwrites), so tests don't depend on each other's token state.
  async function mintFresh(opId: string): Promise<string> {
    const re = await request(srv()).post(`/import/operations/${opId}/migration-token/reissue`).set("Authorization", `Bearer ${tokenA}`).expect(201);
    return re.body.token;
  }
});
