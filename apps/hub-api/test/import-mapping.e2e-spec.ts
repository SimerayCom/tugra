import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ImportSourceFactory } from "../src/importer/sources/import-source.factory";
import type { ForeignFleet } from "../src/importer/foreign-fleet";

// Editable import mapping over HTTP against the real DB: plan (feature block) -> PUT profile -> resolve -> apply
// (stubbed source) -> tasks -> re-run reloads the profile -> reconcile. The source PaaS is a stub; no Docker/WS.
// Routes are at the bare paths (no configureApp), like the other import e2e specs.
describe("Import mapping (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `impmap-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  let token = "";
  let userId = "";
  let teamId = "";
  let serverId = "";
  const tag = `${Date.now()}`;
  const fleet = (): ForeignFleet => ({
    servers: [{ ref: "srv-a", name: "box" }],
    apps: [{ sourceRef: `app-${tag}`, name: "web", kind: "image", buildPack: "image", image: "nginx:1", serverRef: "srv-a", env: [], volumes: [], domains: [] }],
    databases: [{ sourceRef: `db-${tag}`, name: "Orders", engine: "POSTGRES", version: "16", serverRef: "srv-a" }],
    services: [],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  });
  const APP = `app:srv-a:app-${tag}`;
  const DB = `database:srv-a:db-${tag}`;
  const stubSource = () => ({
    verify: jest.fn().mockResolvedValue({ ok: true }),
    discover: jest.fn().mockImplementation(async () => fleet()),
    fetchSecrets: jest.fn().mockResolvedValue({ values: {}, unresolved: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImportSourceFactory)
      .useValue({ create: () => stubSource(), label: () => "Coolify" })
      .compile();
    app = mod.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password: "supersecret123", name: "M" }).expect(201);
    token = reg.body.tokens.accessToken;
    userId = reg.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId } }))!.teamId;
    serverId = (await request(app.getHttpServer()).post("/servers").set("Authorization", `Bearer ${token}`).send({ name: "map-box", teamId }).expect(201)).body.server.id;
    // An import only places onto a server whose agent is connected and may deploy (a new server is PENDING until it enrolls).
    await prisma.server.update({ where: { id: serverId }, data: { status: "ONLINE" } });
  });

  afterAll(async () => {
    await prisma.bulkOperation.deleteMany({ where: { actorId: userId } }).catch(() => undefined);
    await prisma.importMapping.deleteMany({ where: { teamId } }).catch(() => undefined);
    await prisma.importSession.deleteMany({ where: { teamId } }).catch(() => undefined);
    await prisma.application.deleteMany({ where: { teamId } }).catch(() => undefined);
    await prisma.database.deleteMany({ where: { teamId } }).catch(() => undefined);
    await prisma.server.deleteMany({ where: { id: serverId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  const srv = () => app.getHttpServer();
  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`);
  const connect = async () => (await auth(request(srv()).post("/import/connect")).send({ sourceKind: "coolify", teamId, baseUrl: "https://coolify.example.com", token: "tok", scopeLabel: "team-3" }).expect(201)).body.sessionId as string;
  const waitSettled = async (opId: string) => {
    for (let i = 0; i < 60; i++) {
      const r = await auth(request(srv()).get(`/import/operations/${opId}`)).expect(200);
      if (r.body.status !== "RUNNING") return r.body;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error("import did not settle");
  };

  it("plan -> save profile -> resolve -> apply (mapping required, then mapped) -> re-run reloads the profile -> reconcile", async () => {
    const s1 = await connect();
    const plan1 = (await auth(request(srv()).post("/import/plan")).send({ sourceKind: "coolify", sessionId: s1 }).expect(201)).body;
    expect(plan1.mapping).toMatchObject({ features: ["mapping-v1"], stored: null, scopeKey: "team-3" });
    const planHash: string = plan1.planHash;

    const doc = { version: 1, items: { [APP]: { name: "Storefront", project: "Storefront", environment: "live" }, [DB]: { name: "orders-primary" } } };
    const put = await auth(request(srv()).put(`/import/sessions/${s1}/mapping`)).send({ mapping: doc, label: "first" }).expect(200);
    expect(put.body).toMatchObject({ ok: true, version: 1 });
    await auth(request(srv()).put(`/import/sessions/${s1}/mapping`)).send({ mapping: doc, expectedVersion: 9 }).expect(409);
    const got = (await auth(request(srv()).get(`/import/sessions/${s1}/mapping`)).expect(200)).body;
    expect(got).toMatchObject({ doc: expect.objectContaining({ version: 1 }), version: 1, label: "first" });

    const resolved = (await auth(request(srv()).post("/import/mapping/resolve")).send({ sessionId: s1, sourceKind: "coolify", planHash, targetServerId: serverId, mapping: doc }).expect(201)).body;
    expect(resolved.effective.find((e: { itemRef: string }) => e.itemRef === APP)).toMatchObject({ name: "Storefront", project: "Storefront", environment: "live", status: "pending" });
    expect(resolved.counts).toMatchObject({ renamed: 2, newProjects: 1 });
    expect(resolved.mappingHash).toMatch(/^[a-f0-9]{32}$/);

    const base = { sourceKind: "coolify", sessionId: s1, targetServerId: serverId, planHash };
    // a saved profile exists and the apply carries no mapping -> fail closed
    const refused = await auth(request(srv()).post("/import/apply")).send(base).expect(409);
    expect(refused.body.code).toBe("import.mapping_required");
    // mapping without its hash -> 400 (schema refine)
    await auth(request(srv()).post("/import/apply")).send({ ...base, mapping: doc }).expect(400);
    // a stale hash -> 409
    expect((await auth(request(srv()).post("/import/apply")).send({ ...base, mapping: doc, mappingHash: "0".repeat(32) }).expect(409)).body.code).toBe("import.mapping_changed");

    const applied = (await auth(request(srv()).post("/import/apply")).send({ ...base, mapping: doc, mappingHash: resolved.mappingHash }).expect(201)).body;
    expect(applied.mappingApplied).toBe(true);
    const op = await waitSettled(applied.opId);
    expect(op.status).toBe("SUCCEEDED");
    const appTask = op.tasks.find((t: { itemRef: string }) => t.itemRef === APP);
    expect(appTask).toMatchObject({ status: "DONE", name: "Storefront", sourceName: "web", mapped: true });
    const dbTask = op.tasks.find((t: { itemRef: string }) => t.itemRef === DB);
    expect(dbTask).toMatchObject({ status: "DONE", sourceName: "Orders" });

    const appRow = await prisma.application.findUnique({ where: { id: appTask.resourceId }, include: { environment: { include: { project: true } } } });
    expect(appRow).toMatchObject({ name: "Storefront" });
    expect(appRow!.environment).toMatchObject({ name: "live" });
    expect(appRow!.environment.project.name).toBe("Storefront");
    const dbRow = await prisma.database.findUnique({ where: { id: dbTask.resourceId } });
    expect(dbRow!.name).toBe("orders-primary");

    // the applied mapping is now the editable profile (version bumped, lastApplied set)
    const prof = await prisma.importMapping.findFirst({ where: { teamId, scopeKey: "team-3" } });
    expect(prof).toMatchObject({ lastAppliedOpId: applied.opId });

    // re-run: a NEW session of the same scope reloads the profile as the editable default
    const s2 = await connect();
    const plan2 = (await auth(request(srv()).post("/import/plan")).send({ sourceKind: "coolify", sessionId: s2 }).expect(201)).body;
    expect(plan2.planHash).toBe(planHash); // the profile never moves the hash
    expect(plan2.mapping.stored).toMatchObject({ version: 1, items: { [APP]: { name: "Storefront" } } });

    // already imported + a changed name, reconcile OFF -> nothing changes, the reason says so
    const doc2 = { ...doc, items: { ...doc.items, [APP]: { ...doc.items[APP], name: "Storefront v2" } }, acks: [`project.merge_existing:storefront`] };
    const base2 = { ...base, sessionId: s2 };
    const r2 = (await auth(request(srv()).post("/import/mapping/resolve")).send({ sessionId: s2, sourceKind: "coolify", planHash, targetServerId: serverId, mapping: doc2 }).expect(201)).body;
    expect(r2.effective.find((e: { itemRef: string }) => e.itemRef === APP)).toMatchObject({ status: "already_imported", drift: ["name"] });
    const off = (await auth(request(srv()).post("/import/apply")).send({ ...base2, mapping: doc2, mappingHash: r2.mappingHash }).expect(201)).body;
    const offOp = await waitSettled(off.opId);
    expect(offOp.tasks.find((t: { itemRef: string }) => t.itemRef === APP)).toMatchObject({ status: "SKIPPED", message: expect.stringContaining("mapping not applied (name)") });
    expect((await prisma.application.findUnique({ where: { id: appTask.resourceId } }))!.name).toBe("Storefront");

    // reconcile ON -> renamed in place; the task is SKIPPED (never DONE), the resource id is reported
    const r3 = (await auth(request(srv()).post("/import/mapping/resolve")).send({ sessionId: s2, sourceKind: "coolify", planHash, targetServerId: serverId, reconcile: true, mapping: doc2 }).expect(201)).body;
    const on = (await auth(request(srv()).post("/import/apply")).send({ ...base2, mapping: doc2, mappingHash: r3.mappingHash, reconcile: true }).expect(201)).body;
    const onOp = await waitSettled(on.opId);
    expect(onOp.tasks.find((t: { itemRef: string }) => t.itemRef === APP)).toMatchObject({ status: "SKIPPED", resourceId: appTask.resourceId, message: expect.stringContaining("reconciled: name") });
    expect((await prisma.application.findUnique({ where: { id: appTask.resourceId } }))!.name).toBe("Storefront v2");
    expect(await prisma.application.count({ where: { teamId } })).toBe(1); // never re-created
  });

  it("deleting the profile; another user's session cannot read it", async () => {
    const s = await connect();
    await auth(request(srv()).delete(`/import/sessions/${s}/mapping`)).expect(200);
    expect((await auth(request(srv()).get(`/import/sessions/${s}/mapping`)).expect(200)).body.doc).toBeNull();
    const other = `impmap2-${Date.now()}@tugra.test`;
    const reg = await request(srv()).post("/auth/register").send({ email: other, password: "supersecret123", name: "O" }).expect(201);
    await request(srv()).get(`/import/sessions/${s}/mapping`).set("Authorization", `Bearer ${reg.body.tokens.accessToken}`).expect(403);
    await prisma.user.deleteMany({ where: { email: other } }).catch(() => undefined);
  });
});
