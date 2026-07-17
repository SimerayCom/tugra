import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// Bare paths (no configureApp) — mirrors instance-api-gating.e2e-spec. Exercises the owner-only
// GET /instance/update status endpoint. UPDATE_MANIFEST_URL is unset in test, so getStatus just reads
// the (default) InstanceSettings singleton + the running version — no remote fetch, no scheduler.
describe("instance update status (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `update-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let jwt = "";
  let userId = "";
  let teamId = "";
  let pat = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);

    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "Upd" }).expect(201);
    jwt = reg.body.tokens.accessToken;
    userId = reg.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId } }))!.teamId;

    const mint = await request(app.getHttpServer())
      .post("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "upd", scopes: ["read"] })
      .expect(201);
    pat = mint.body.token;
  });

  afterAll(async () => {
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("lets the instance owner read the update status and blocks non-owners", async () => {
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: true } });
    try {
      const got = await request(srv()).get("/instance/update").set("Authorization", `Bearer ${jwt}`).expect(200);
      expect(got.body).toEqual({
        current: expect.any(String),
        latest: null, // no signed check has run in test
        channel: expect.any(String),
        updateAvailable: false, // report-only, never a downgrade
        changelogUrl: null,
        autoUpdate: expect.any(Boolean),
      });

      // a non-owner is forbidden
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } });
      await request(srv()).get("/instance/update").set("Authorization", `Bearer ${jwt}`).expect(403);
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    }
  });

  it("does not let a PAT read the update status (session-only)", async () => {
    // JwtAuthGuard rejects a tugra_pat_ token as an invalid JWT → 401, never reaching the owner check.
    await request(srv()).get("/instance/update").set("Authorization", `Bearer ${pat}`).expect(401);
  });
});
