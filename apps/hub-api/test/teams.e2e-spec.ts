import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Teams (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const emailA = `team-a-${stamp}@tugra.test`;
  const emailB = `team-b-${stamp}@tugra.test`;
  const password = "supersecret123";
  let tokenA = "";
  let tokenB = "";
  let userBId = "";
  let teamId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);
    void (app.getHttpServer().address() as AddressInfo).port;

    const a = await request(app.getHttpServer()).post("/auth/register").send({ email: emailA, password, name: "A" }).expect(201);
    tokenA = a.body.tokens.accessToken;
    const b = await request(app.getHttpServer()).post("/auth/register").send({ email: emailB, password, name: "B" }).expect(201);
    tokenB = b.body.tokens.accessToken;
    userBId = b.body.user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } }).catch(() => undefined);
    await app.close();
  });

  it("creates a team, invites a user, who accepts and is managed", async () => {
    const created = await request(app.getHttpServer())
      .post("/teams")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "Platform" })
      .expect(201);
    teamId = created.body.id;
    expect(created.body.role).toBe("OWNER");

    // invite B
    const inv = await request(app.getHttpServer())
      .post(`/teams/${teamId}/members/invite`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: emailB, role: "VIEWER" })
      .expect(201);
    expect(inv.body.token).toBeTruthy();

    // B sees it
    const mine = await request(app.getHttpServer())
      .get("/teams/invitations/mine")
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);
    expect(mine.body.some((i: { token: string }) => i.token === inv.body.token)).toBe(true);

    // B accepts
    await request(app.getHttpServer())
      .post(`/teams/invitations/${inv.body.token}/accept`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(200);

    // members now 2
    const members = await request(app.getHttpServer())
      .get(`/teams/${teamId}/members`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
    expect(members.body).toHaveLength(2);

    // promote B to ADMIN, then remove
    await request(app.getHttpServer())
      .put(`/teams/${teamId}/members/${userBId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ role: "ADMIN" })
      .expect(200);
    await request(app.getHttpServer())
      .delete(`/teams/${teamId}/members/${userBId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
  });

  it("rejects accepting an invitation meant for another account", async () => {
    const inv = await request(app.getHttpServer())
      .post(`/teams/${teamId}/members/invite`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: `nobody-${stamp}@tugra.test`, role: "VIEWER" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/teams/invitations/${inv.body.token}/accept`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(403);
  });

  it("deletes an empty team", async () => {
    await request(app.getHttpServer())
      .delete(`/teams/${teamId}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .expect(200);
  });
});
