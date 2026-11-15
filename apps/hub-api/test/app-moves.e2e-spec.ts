import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { ApplicationsService } from "../src/applications/applications.service";

/**
 * App move against a REAL Postgres: the migration's partial unique index, the cutover transaction (the cheap path of a
 * never-deployed app runs it end to end: server flip, log-drain move, runServerId/hostServerId stamps), the deploy queue's
 * claim rule while a move is live, and the lock guards. Agents are not connected in e2e, which is exactly what the NEW-app
 * (cheap) path is designed for: it needs none.
 */
describe("App move (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `move-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let s1 = "";
  let s2 = "";
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const newApp = async (name: string): Promise<string> => {
    const r = await request(app.getHttpServer()).post("/apps").set(auth()).send({ name, serverId: s1, image: "nginx:alpine" }).expect(201);
    return r.body.id as string;
  };
  const moveRow = (appId: string, over: Record<string, unknown> = {}) =>
    prisma.appMove.create({
      data: { appId, appName: "x", teamId, requestedBy: "u", sourceServerId: s1, targetServerId: s2, prevStatus: "RUNNING", plan: { cheap: false, totalBytes: 0 }, ...over } as never,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "M" }).expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;
    s1 = (await request(app.getHttpServer()).post("/servers").set(auth()).send({ name: "node-a", teamId }).expect(201)).body.server.id;
    s2 = (await request(app.getHttpServer()).post("/servers").set(auth()).send({ name: "node-b", teamId }).expect(201)).body.server.id;
  });

  // a live move reserves BOTH its servers (move_active_on_server): never let one test's leftovers block the next
  afterEach(async () => {
    await prisma.appMove.deleteMany({ where: { teamId } });
  });

  afterAll(async () => {
    await prisma.appMove.deleteMany({ where: { teamId } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("the migration created the partial unique index: ONE live move per app, a new one allowed once the first is terminal", async () => {
    const idx = await prisma.$queryRaw<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes WHERE indexname = 'AppMove_one_active_per_app'`;
    expect(idx).toHaveLength(1);
    expect(idx[0].indexdef).toContain("UNIQUE");
    expect(idx[0].indexdef).toMatch(/phase/);

    const appId = await newApp("idx-app");
    const first = await moveRow(appId, { phase: "TRANSFERRING" });
    await expect(moveRow(appId, { phase: "QUEUED" })).rejects.toMatchObject({ code: "P2002" });
    await prisma.appMove.update({ where: { id: first.id }, data: { phase: "COMPLETED" } });
    const second = await moveRow(appId, { phase: "QUEUED" });
    expect(second.id).not.toBe(first.id);
    // terminal phases never collide with anything
    await prisma.appMove.update({ where: { id: second.id }, data: { phase: "ROLLED_BACK" } });
    await moveRow(appId, { phase: "FAILED" });
    await moveRow(appId, { phase: "QUEUED" });
  });

  it("the added columns are nullable and default NULL on existing rows; the enum has every phase", async () => {
    const appId = await newApp("cols-app");
    const dep = await prisma.deployment.create({ data: { appId, status: "SUCCESS" } });
    expect(dep.runServerId).toBeNull();
    const vb = await prisma.volumeBackup.create({ data: { appId, volumeName: "d", filename: "f", path: "/p", createdBy: "u" } });
    expect(vb.hostServerId).toBeNull();
    const phases = await prisma.$queryRaw<{ e: string }[]>`SELECT unnest(enum_range(NULL::"AppMovePhase"))::text AS e`;
    expect(phases.map((p) => p.e)).toEqual(["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING", "DEPLOYING", "FINALIZING", "COMPLETED", "ROLLING_BACK", "ROLLED_BACK", "FAILED"]);
  });

  it("moves a never-deployed app end to end: preflight ok, 202 start, the cutover tx flips the server, moves the app's log drain and stamps legacy rows", async () => {
    const appId = await newApp("cheap-move");
    await prisma.logDrain.create({ data: { serverId: s1, appId, name: "app-drain", endpoint: "https://logs.example.com", type: "HTTP" } });
    const serverWide = await prisma.logDrain.create({ data: { serverId: s1, name: "server-drain", endpoint: "https://logs.example.com/s", type: "HTTP" } });
    const appDrain = (await prisma.logDrain.findFirst({ where: { appId } }))!;
    const dep = await prisma.deployment.create({ data: { appId, status: "SUCCESS" } });
    const local = await prisma.volumeBackup.create({ data: { appId, volumeName: "d", filename: "f", path: "/p", createdBy: "u", status: "SUCCESS" } });

    const pf = await request(app.getHttpServer()).post(`/apps/${appId}/move/preflight`).set(auth()).send({ targetServerId: s2 }).expect(200);
    expect(pf.body).toMatchObject({ ok: true, blockers: [], plan: { cheap: true } });

    // typing the wrong name is refused before anything starts
    await request(app.getHttpServer()).post(`/apps/${appId}/move`).set(auth()).send({ targetServerId: s2, confirmName: "wrong" }).expect(400);

    const started = await request(app.getHttpServer()).post(`/apps/${appId}/move`).set(auth()).send({ targetServerId: s2, confirmName: "cheap-move" }).expect(202);
    expect(started.body).toMatchObject({ phase: "QUEUED" });
    const moveId = started.body.moveId as string;

    let view: { phase: string; plan: unknown } | undefined;
    for (let i = 0; i < 100; i++) {
      view = (await request(app.getHttpServer()).get(`/apps/${appId}/moves/${moveId}`).set(auth()).expect(200)).body;
      if (view!.phase === "COMPLETED") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(view!.phase).toBe("COMPLETED");

    const moved = (await prisma.application.findUnique({ where: { id: appId } }))!;
    expect(moved.serverId).toBe(s2);
    expect(moved.status).toBe("NEW");
    expect((await prisma.logDrain.findUnique({ where: { id: appDrain.id } }))!.serverId).toBe(s2); // the app's drain follows it
    expect((await prisma.logDrain.findUnique({ where: { id: serverWide.id } }))!.serverId).toBe(s1); // a server-wide drain does not
    expect((await prisma.deployment.findUnique({ where: { id: dep.id } }))!.runServerId).toBe(s1);
    expect((await prisma.volumeBackup.findUnique({ where: { id: local.id } }))!.hostServerId).toBe(s1);
    const row = (await prisma.appMove.findUnique({ where: { id: moveId } }))!;
    expect(row).toMatchObject({ phase: "COMPLETED", ownerId: null, archiveUntil: null });
    expect(row.sourcePurgedAt).not.toBeNull();
    expect(row.snapshotBefore).toMatchObject({ serverId: s1, logDrains: [{ id: appDrain.id, serverId: s1 }] });
    expect(row.cutoverAt).not.toBeNull();

    // the moved app can be listed, is no longer locked, and a second move (back) is allowed
    const got = await request(app.getHttpServer()).get(`/apps/${appId}`).set(auth()).expect(200);
    expect(got.body.move).toBeNull();
    expect(got.body.serverId).toBe(s2);
    const history = await request(app.getHttpServer()).get(`/apps/${appId}/moves`).set(auth()).expect(200);
    expect(history.body.map((m: { id: string }) => m.id)).toContain(moveId);
    expect((await request(app.getHttpServer()).get(`/apps/${appId}/moves?active=true`).set(auth()).expect(200)).body).toEqual([]);
  });

  it("a second concurrent start is a 409 (the unique index) and the active move is visible on the app", async () => {
    const appId = await newApp("busy-move");
    await moveRow(appId, { phase: "TRANSFERRING", appName: "busy-move" });
    const r = await request(app.getHttpServer()).post(`/apps/${appId}/move`).set(auth()).send({ targetServerId: s2, confirmName: "busy-move" });
    expect(r.status).toBe(409);
    const got = await request(app.getHttpServer()).get(`/apps/${appId}`).set(auth()).expect(200);
    expect(got.body.move).toMatchObject({ phase: "TRANSFERRING" });
  });

  it("while a move is live: config edits and lifecycle actions are 409 app_move_in_progress; deploy QUEUEING still works", async () => {
    const appId = await newApp("locked-app");
    const mv = await moveRow(appId, { phase: "TRANSFERRING" });
    for (const [method, path, body] of [
      ["put", `/apps/${appId}/env`, { env: { A: "1" } }],
      ["post", `/apps/${appId}/stop`, undefined],
      ["post", `/apps/${appId}/restart`, undefined],
      ["delete", `/apps/${appId}`, undefined],
    ] as const) {
      const r = await (request(app.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>)[method](path).set(auth()).send(body);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe("app_move_in_progress");
    }
    const queued = await request(app.getHttpServer()).post(`/apps/${appId}/deploy`).set(auth()).send({});
    expect([200, 201, 202]).toContain(queued.status);
    expect((await prisma.deployment.findFirst({ where: { appId, status: "QUEUED" } }))).not.toBeNull();
    await prisma.appMove.update({ where: { id: mv.id }, data: { phase: "COMPLETED" } });
  });

  it("claimNext (real SQL) while a move is live: ONLY the move's own deploy is claimable; older queued rows wait", async () => {
    const appId = await newApp("queue-app");
    await prisma.deployment.deleteMany({ where: { appId } });
    const mv = await moveRow(appId, { phase: "DEPLOYING" });
    const old = await prisma.deployment.create({ data: { appId, status: "QUEUED", createdAt: new Date(Date.now() - 60_000) } });
    const keyed = await prisma.deployment.create({ data: { appId, status: "QUEUED", idempotencyKey: "client-key" } });
    const own = await prisma.deployment.create({ data: { appId, status: "QUEUED", idempotencyKey: `move:${mv.id}`, trigger: "move" } });
    const svc = app.get(ApplicationsService) as unknown as { claimNext: (id: string) => Promise<{ id: string } | null> };
    expect((await svc.claimNext(appId))?.id).toBe(own.id);
    // the move's deploy is RUNNING now: nothing else is claimed either (one RUNNING per app)
    expect(await svc.claimNext(appId)).toBeNull();
    await prisma.deployment.update({ where: { id: own.id }, data: { status: "SUCCESS" } });
    expect(await svc.claimNext(appId)).toBeNull(); // the move is still live: everyone else waits
    await prisma.appMove.update({ where: { id: mv.id }, data: { phase: "COMPLETED" } });
    expect((await svc.claimNext(appId))?.id).toBe(old.id); // move over: FIFO resumes
    await prisma.deployment.update({ where: { id: old.id }, data: { status: "SUCCESS" } });
    expect((await svc.claimNext(appId))?.id).toBe(keyed.id);
  });

  it("a stale move: deploy of a finished move is never run", async () => {
    const appId = await newApp("stale-app");
    await prisma.deployment.deleteMany({ where: { appId } });
    const mv = await moveRow(appId, { phase: "ROLLED_BACK" });
    const stale = await prisma.deployment.create({ data: { appId, status: "QUEUED", idempotencyKey: `move:${mv.id}` } });
    const normal = await prisma.deployment.create({ data: { appId, status: "QUEUED", createdAt: new Date(Date.now() + 1000) } });
    const svc = app.get(ApplicationsService) as unknown as { claimNext: (id: string) => Promise<{ id: string } | null> };
    expect((await svc.claimNext(appId))?.id).toBe(normal.id);
    expect((await prisma.deployment.findUnique({ where: { id: stale.id } }))!.status).toBe("QUEUED");
  });

  it("deleting a server is refused while it is part of a live move or still holds an unpurged archive", async () => {
    const holder = (await request(app.getHttpServer()).post("/servers").set(auth()).send({ name: "archive-holder", teamId }).expect(201)).body.server.id as string;
    const appId = await newApp("archive-app");
    const mv = await prisma.appMove.create({
      data: { appId, appName: "x", teamId, requestedBy: "u", sourceServerId: holder, targetServerId: s2, prevStatus: "RUNNING", plan: {}, phase: "COMPLETED", archiveUntil: new Date(Date.now() + 86_400_000) },
    });
    const r = await request(app.getHttpServer()).delete(`/servers/${holder}`).set(auth());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("server_in_active_move");
    await prisma.appMove.update({ where: { id: mv.id }, data: { sourcePurgedAt: new Date() } });
    await request(app.getHttpServer()).delete(`/servers/${holder}`).set(auth()).expect(200);
  });

  it("authorization: another team's member cannot preflight/start/read; a missing target is 404", async () => {
    const appId = await newApp("authz-app");
    const other = `move-other-${Date.now()}@tugra.test`;
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email: other, password, name: "O" }).expect(201);
    const otherToken = reg.body.tokens.accessToken as string;
    const h = { Authorization: `Bearer ${otherToken}` };
    for (const r of [
      await request(app.getHttpServer()).post(`/apps/${appId}/move/preflight`).set(h).send({ targetServerId: s2 }),
      await request(app.getHttpServer()).post(`/apps/${appId}/move`).set(h).send({ targetServerId: s2, confirmName: "authz-app" }),
      await request(app.getHttpServer()).get(`/apps/${appId}/moves`).set(h),
    ]) expect([403, 404]).toContain(r.status);
    await request(app.getHttpServer()).post(`/apps/${appId}/move/preflight`).set(auth()).send({ targetServerId: "no-such-server" }).expect(404);
    await prisma.team.deleteMany({ where: { memberships: { some: { user: { email: other } } } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: other } }).catch(() => undefined);
  });
});
