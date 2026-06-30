import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Audit log (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let token = "";
  let userId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "A" }).expect(201);
    token = reg.body.tokens.accessToken;
    userId = reg.body.user.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actor: userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  it("returns a paginated {entries, nextCursor} page of the user's own actions", async () => {
    await prisma.auditLog.create({ data: { actor: userId, action: "test.one", target: "x" } });
    await prisma.auditLog.create({ data: { actor: userId, action: "test.two", target: "y" } });

    const res = await request(app.getHttpServer())
      .get("/audit")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveProperty("entries");
    expect(res.body).toHaveProperty("nextCursor", null); // only 2 rows → no next page
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["test.one", "test.two"]));
    // actor resolved to the user's email
    expect(res.body.entries[0].actor).toBe(email);
  });
});
