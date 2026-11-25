import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Hub health + coalesced polled reads (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const password = "supersecret123";
  const users: Record<"a" | "b", { email: string; id: string; token: string; teamId: string }> = {
    a: { email: `hh-a-${tag}@tugra.test`, id: "", token: "", teamId: "" },
    b: { email: `hh-b-${tag}@tugra.test`, id: "", token: "", teamId: "" },
  };
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
    for (const k of ["a", "b"] as const) {
      const reg = await http().post("/auth/register").send({ email: users[k].email, password, name: k }).expect(201);
      users[k].id = reg.body.user.id;
      users[k].token = reg.body.tokens.accessToken;
      users[k].teamId = (await prisma.membership.findFirst({ where: { userId: users[k].id } }))!.teamId;
    }
    // Registration order in a shared e2e DB decides the owner: pin it.
    await prisma.user.update({ where: { id: users.a.id }, data: { isInstanceOwner: true } });
    await prisma.user.update({ where: { id: users.b.id }, data: { isInstanceOwner: false } });
  });

  afterAll(async () => {
    await prisma.server.deleteMany({ where: { teamId: { in: [users.a.teamId, users.b.teamId] } } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: { in: [users.a.teamId, users.b.teamId] } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email: { in: [users.a.email, users.b.email] } } }).catch(() => undefined);
    await app.close();
  });

  const auth = (k: "a" | "b") => ({ Authorization: `Bearer ${users[k].token}` });

  it("GET /instance/hub-health: owner gets the snapshot, a member is refused, anonymous is 401", async () => {
    const ok = await http().get("/instance/hub-health").set(auth("a")).expect(200);
    expect(ok.body.process.heapLimitMb).toBeGreaterThan(0);
    expect(typeof ok.body.healthy).toBe("boolean");
    expect(ok.body.postgres.connectionsMax).toBeGreaterThan(0);
    expect(ok.body.postgres.tables.length).toBeGreaterThan(0);
    expect(ok.body.redis.connectedClients).toBeGreaterThan(0);
    await http().get("/instance/hub-health").set(auth("b")).expect(403);
    await http().get("/instance/hub-health").expect(401);
  });

  it("a write invalidates the coalesced list: a server created right after a list shows up at once", async () => {
    const before = await http().get("/servers").set(auth("a")).expect(200);
    expect(before.body).toHaveLength(0);
    await http().post("/servers").set(auth("a")).send({ name: "hh-a-1", teamId: users.a.teamId }).expect(201);
    const after = await http().get("/servers").set(auth("a")).expect(200); // well inside the 1.5 s window
    expect(after.body.map((s: { name: string }) => s.name)).toEqual(["hh-a-1"]);
  });

  it("never serves one team's cached list or fleet rows to another team", async () => {
    for (let i = 0; i < 3; i++) {
      const a = await http().get("/servers").set(auth("a")).expect(200);
      const b = await http().get("/servers").set(auth("b")).expect(200);
      expect(a.body.map((s: { name: string }) => s.name)).toEqual(["hh-a-1"]);
      expect(b.body).toEqual([]);
      const fa = await http().get("/fleet/metrics/latest").set(auth("a")).expect(200);
      const fb = await http().get("/fleet/containers/hottest").set(auth("b")).expect(200);
      expect(Array.isArray(fa.body)).toBe(true);
      expect(fb.body).toEqual([]);
      const ia = await http().get("/dashboard/insights").set(auth("a")).expect(200);
      expect(ia.body.deploys).toBeDefined();
    }
  });

  it("polled reads are private + revalidated and answer 304 to a matching If-None-Match", async () => {
    for (const path of ["/servers", "/fleet/metrics/latest", "/fleet/metrics/trend", "/dashboard/insights"]) {
      const first = await http().get(path).set(auth("a")).expect(200);
      expect(first.headers["cache-control"]).toBe("private, no-cache");
      const etag = first.headers["etag"];
      expect(etag).toBeTruthy();
      await http().get(path).set(auth("a")).set("If-None-Match", etag).expect(304);
    }
  });
});
