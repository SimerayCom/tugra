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
  });
});
