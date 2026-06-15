import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Monitors + Channels (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const email = `mon-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "Mon" })
      .expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  let monitorId = "";

  it("creates an HTTP monitor and checks it UP against the hub's own /health", async () => {
    const res = await request(app.getHttpServer())
      .post("/monitors")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "self", type: "HTTP", target: `http://127.0.0.1:${port}/health`, teamId })
      .expect(201);
    monitorId = res.body.id;
    expect(res.body.canWrite).toBe(true);

    const check = await request(app.getHttpServer())
      .post(`/monitors/${monitorId}/check`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(check.body.status).toBe("UP");

    const beats = await request(app.getHttpServer())
      .get(`/monitors/${monitorId}/heartbeats`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(beats.body.length).toBeGreaterThanOrEqual(1);
    expect(beats.body[beats.body.length - 1].status).toBe("UP");
  });

  it("lists monitors cross-team", async () => {
    const res = await request(app.getHttpServer())
      .get("/monitors")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.some((m: { id: string }) => m.id === monitorId)).toBe(true);
  });

  it("creates and lists a webhook channel", async () => {
    await request(app.getHttpServer())
      .post("/channels")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "hook", type: "webhook", teamId, config: { url: "http://example.test/hook" } })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get("/channels")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.some((c: { name: string }) => c.name === "hook")).toBe(true);
  });

  it("rejects an unsupported channel type", async () => {
    await request(app.getHttpServer())
      .post("/channels")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x", type: "carrier-pigeon", teamId, config: {} })
      .expect(400);
  });
});
