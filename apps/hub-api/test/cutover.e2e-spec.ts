import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// SSL/DNS cutover over HTTP: routes, auth, ownership, zod validation and the manual-DNS path (no Cloudflare
// credential, so nothing is ever written to a provider). The agent is absent; probes target a public IP that the
// hub never reaches in these cases (init/exclude/validation only).
describe("Cutover (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const emailA = `cutA-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const emailB = `cutB-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  let tokenA = "";
  let tokenB = "";
  let userAId = "";
  let teamId = "";
  let serverId = "";
  let appId = "";
  let opId = "";

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    const regA = await request(app.getHttpServer()).post("/auth/register").send({ email: emailA, password: "supersecret123", name: "A" }).expect(201);
    tokenA = regA.body.tokens.accessToken;
    userAId = regA.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId: userAId } }))!.teamId;
    const regB = await request(app.getHttpServer()).post("/auth/register").send({ email: emailB, password: "supersecret123", name: "B" }).expect(201);
    tokenB = regB.body.tokens.accessToken;
    const srv = await request(app.getHttpServer()).post("/servers").set("Authorization", `Bearer ${tokenA}`).send({ name: "cut-box", teamId }).expect(201);
    serverId = srv.body.server.id;
    await prisma.server.update({ where: { id: serverId }, data: { publicIp: "203.0.113.7" } });
    const a = await request(app.getHttpServer()).post("/apps").set("Authorization", `Bearer ${tokenA}`).send({ name: "web", serverId, image: "nginx:alpine", hostPort: 8080 }).expect(201);
    appId = a.body.id;
    await prisma.application.update({ where: { id: appId }, data: { domain: "cutover-e2e.invalid", exposeMode: "custom", domainKind: "custom", extraDomains: ["app-ek8c4gk8s8kwk8go4kwc4skc.cutover-e2e.invalid"] } });
    const op = await prisma.bulkOperation.create({ data: { actorId: userAId, command: "", kind: "import", planId: "h", meta: { sourceKind: "coolify", serverId } } });
    opId = op.id;
    await prisma.bulkTask.create({ data: { opId, serverId, kind: "app", itemRef: "app:_:1", status: "DONE", resourceType: "application", resourceId: appId, result: { name: "web-src" } } });
  });

  afterAll(async () => {
    await prisma.bulkOperation.deleteMany({ where: { actorId: userAId } }).catch(() => undefined);
    await prisma.application.deleteMany({ where: { id: appId } }).catch(() => undefined);
    await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }).catch(() => undefined);
    await app.close();
  });

  const srv = () => app.getHttpServer();
  const base = () => `/import/operations/${opId}/cutover`;
  const auth = (t = tokenA) => ({ Authorization: `Bearer ${t}` });

  it("requires auth (401) and ownership of the op (403)", async () => {
    await request(srv()).get(base()).expect(401);
    await request(srv()).get(base()).set(auth(tokenB)).expect(403);
    await request(srv()).post(`${base()}/init`).set(auth(tokenB)).send({}).expect(403);
  });

  it("init derives the entries (manual DNS: no credential), excludes the generated host, and is idempotent", async () => {
    const first = await request(srv()).post(`${base()}/init`).set(auth()).send({}).expect(200);
    const by = Object.fromEntries(first.body.entries.map((e: { hostname: string }) => [e.hostname, e]));
    expect(by["cutover-e2e.invalid"]).toMatchObject({ state: "PLANNED", dnsMode: "manual", role: "primary", sourceName: "web-src", challenge: "http01" });
    expect(by["app-ek8c4gk8s8kwk8go4kwc4skc.cutover-e2e.invalid"]).toMatchObject({ state: "EXCLUDED", blockReason: "generated-host" });
    const second = await request(srv()).post(`${base()}/init`).set(auth()).send({}).expect(200);
    expect(second.body.entries).toHaveLength(first.body.entries.length);
    expect(await prisma.cutoverDomain.count({ where: { opId } })).toBe(first.body.entries.length);
    // secret-free
    expect(JSON.stringify(second.body)).not.toMatch(/token|ledger|keyEnc|certPem/i);
  });

  it("GET returns the view with a per-server preflight, summary and no run", async () => {
    const v = await request(srv()).get(base()).set(auth()).expect(200);
    expect(v.body).toMatchObject({ opId, run: null, certs: { staged: 0, applied: 0 } });
    expect(v.body.servers[0]).toMatchObject({ serverId, publicIp: "203.0.113.7", dnsReady: false, coverage: "none" });
    expect(v.body.servers[0].warnings).toEqual(expect.arrayContaining(["dns01-not-ready"]));
    expect(v.body.summary.excluded).toBe(1);
  });

  it("exclude / include round-trips", async () => {
    await request(srv()).post(`${base()}/exclude`).set(auth()).send({ hostnames: ["cutover-e2e.invalid"], excluded: true }).expect(200);
    expect((await prisma.cutoverDomain.findFirst({ where: { opId, hostname: "cutover-e2e.invalid" } }))!.state).toBe("EXCLUDED");
    await request(srv()).post(`${base()}/exclude`).set(auth()).send({ hostnames: ["cutover-e2e.invalid"], excluded: false }).expect(200);
    expect((await prisma.cutoverDomain.findFirst({ where: { opId, hostname: "cutover-e2e.invalid" } }))!.state).toBe("PLANNED");
  });

  it("validates bodies (400) and refuses a flip with nothing READY or a wrong token (409) - nothing is written", async () => {
    await request(srv()).post(`${base()}/flip`).set(auth()).send({}).expect(400);
    await request(srv()).post(`${base()}/flip`).set(auth()).send({ confirmToken: "nope" }).expect(400);
    await request(srv()).post(`${base()}/flip`).set(auth()).send({ confirmToken: "a".repeat(64) }).expect(409);
    await request(srv()).post(`${base()}/revert`).set(auth()).send({ hostnames: ["cutover-e2e.invalid"] }).expect(400);
    await request(srv()).post(`${base()}/revert`).set(auth()).send({ hostnames: ["cutover-e2e.invalid"], acknowledgeDataLoss: true }).expect(409); // never switched
    await request(srv()).post(`${base()}/exclude`).set(auth()).send({ hostnames: ["*.example.com"], excluded: true }).expect(400);
    await request(srv()).post(`${base()}/cert-prepare`).set(auth()).send({ challenge: "dns02" }).expect(400);
    expect(await prisma.cutoverRun.count({ where: { opId } })).toBe(0);
  });

  it("cert-prepare dns01 is BLOCKED (never half-configured) while the server has no DNS-01 credentials", async () => {
    const r = await request(srv()).post(`${base()}/cert-prepare`).set(auth()).send({ challenge: "dns01" }).expect(200);
    expect(r.body.blocked).toEqual([{ hostname: "cutover-e2e.invalid", reason: "no-dns-credential" }]);
    expect((await prisma.application.findUnique({ where: { id: appId } }))!.dnsChallenge).toBe(false);
  });

  it("domain-options dnsChallenge is refused without DNS-01 creds and shows on the app view when set", async () => {
    await request(srv()).put(`/apps/${appId}/domain-options`).set(auth()).send({ dnsChallenge: true }).expect(400);
    await request(srv()).put(`/apps/${appId}/domain-options`).set(auth()).send({ dnsChallenge: false }).expect(200);
    const view = await request(srv()).get(`/apps/${appId}`).set(auth()).expect(200);
    expect(view.body.dnsChallenge).toBe(false);
  });

  it("the migrator cert routes are token-guarded", async () => {
    await request(srv()).get("/import/migration/certs/wanted").expect(401);
    await request(srv()).put("/import/migration/certs").set("content-type", "application/octet-stream").send("{}").expect(401);
  });

  it("flip-plan and seed-certs need their scopes; seed with nothing staged is 409", async () => {
    await request(srv()).get(`${base()}/flip-plan`).set(auth()).expect(200);
    await request(srv()).post(`${base()}/seed-certs`).set(auth()).send({ acknowledgeProxyRestart: true }).expect(409);
  });
});
