import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Saved views (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `views-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let token = "";
  let userId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "V" }).expect(201);
    token = reg.body.tokens.accessToken;
    userId = reg.body.user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("creates, lists and deletes a personal fleet view", async () => {
    const created = await request(app.getHttpServer())
      .post("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "prod-eu", status: "ONLINE", tags: ["eu"] })
      .expect(201);
    expect(created.body).toMatchObject({ name: "prod-eu", status: "ONLINE", tags: ["eu"] });
    const id = created.body.id;

    const list = await request(app.getHttpServer())
      .get("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((v: { id: string }) => v.id)).toContain(id);

    await request(app.getHttpServer())
      .delete(`/saved-views/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const after = await request(app.getHttpServer())
      .get("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(after.body).toEqual([]);
  });

  it("rejects an empty name", async () => {
    await request(app.getHttpServer())
      .post("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "" })
      .expect(400);
  });

  it("shares a view with the user's team and refuses foreign teams", async () => {
    const teamId = (await prisma.membership.findFirst({ where: { userId } }))!.teamId;

    const shared = await request(app.getHttpServer())
      .post("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "team-eu", teamId })
      .expect(201);
    expect(shared.body).toMatchObject({ name: "team-eu", teamId, canDelete: true });

    const list = await request(app.getHttpServer())
      .get("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.find((v: { id: string }) => v.id === shared.body.id)?.teamId).toBe(teamId);

    // Sharing with a team the user isn't a member of is forbidden.
    const other = await prisma.team.create({ data: { name: "views-foreign" } });
    await request(app.getHttpServer())
      .post("/saved-views")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "nope", teamId: other.id })
      .expect(403);
    await prisma.team.deleteMany({ where: { id: other.id } }).catch(() => undefined);
  });
});
