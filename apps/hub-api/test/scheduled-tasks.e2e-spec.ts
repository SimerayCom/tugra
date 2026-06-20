import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Scheduled tasks (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `task-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let teamId = "";
  let token = "";
  let serverId = "";
  let appId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    void (app.getHttpServer().address() as AddressInfo).port;

    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "T" }).expect(201);
    token = reg.body.tokens.accessToken;
    teamId = (await prisma.membership.findFirst({ where: { userId: reg.body.user.id } }))!.teamId;
    const srv = await request(app.getHttpServer()).post("/servers").set("Authorization", `Bearer ${token}`).send({ name: "task-node", teamId }).expect(201);
    serverId = srv.body.server.id;
    const a = await request(app.getHttpServer()).post("/apps").set("Authorization", `Bearer ${token}`).send({ name: "cronapp", serverId, image: "nginx:alpine" }).expect(201);
    appId = a.body.id;
  });

  afterAll(async () => {
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("creates, lists, updates and deletes a scheduled task", async () => {
    const created = await request(app.getHttpServer())
      .post(`/apps/${appId}/tasks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "nightly", schedule: "0 2 * * *", command: "echo hi" })
      .expect(201);
    const taskId = created.body.id;
    expect(created.body.enabled).toBe(true);

    const list = await request(app.getHttpServer()).get(`/apps/${appId}/tasks`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(list.body.some((t: { id: string }) => t.id === taskId)).toBe(true);

    await request(app.getHttpServer())
      .put(`/apps/${appId}/tasks/${taskId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: false })
      .expect(200);

    await request(app.getHttpServer()).delete(`/apps/${appId}/tasks/${taskId}`).set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("rejects an invalid cron expression", async () => {
    await request(app.getHttpServer())
      .post(`/apps/${appId}/tasks`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "bad", schedule: "not-a-cron", command: "echo" })
      .expect(400);
  });
});
