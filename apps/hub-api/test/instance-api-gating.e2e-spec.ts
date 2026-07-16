import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// Bare paths (no configureApp) — mirrors api-tokens.e2e-spec. Exercises PAT-only API gating + the
// owner-only instance-settings endpoint. The InstanceSettings singleton is shared global state, so every
// test restores { apiEnabled: true, apiAllowedIps: [] } before finishing.
describe("instance API gating (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `gating-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  let jwt = "";
  let userId = "";
  let teamId = "";
  let pat = "";

  const setSettings = (apiEnabled: boolean, apiAllowedIps: string[]) =>
    prisma.instanceSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", apiEnabled, apiAllowedIps },
      update: { apiEnabled, apiAllowedIps },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.listen(0);

    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email, password, name: "Gate" }).expect(201);
    jwt = reg.body.tokens.accessToken;
    userId = reg.body.user.id;
    teamId = (await prisma.membership.findFirst({ where: { userId } }))!.teamId;

    const mint = await request(app.getHttpServer())
      .post("/api-tokens")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ name: "gate", scopes: ["read"] })
      .expect(201);
    pat = mint.body.token;
  });

  afterAll(async () => {
    await setSettings(true, []).catch(() => undefined);
    await prisma.team.deleteMany({ where: { id: teamId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("disables all PATs when apiEnabled=false, but leaves the session working", async () => {
    await setSettings(false, []);
    try {
      await request(srv()).get("/apps").set("Authorization", `Bearer ${pat}`).expect(403);
      await request(srv()).get("/apps").set("Authorization", `Bearer ${jwt}`).expect(200);
    } finally {
      await setSettings(true, []);
    }
  });

  it("allows a PAT from an allowlisted (loopback) address and blocks a foreign range", async () => {
    await setSettings(true, ["127.0.0.1", "::1"]); // supertest connects over loopback
    try {
      await request(srv()).get("/apps").set("Authorization", `Bearer ${pat}`).expect(200);
      await setSettings(true, ["10.0.0.0/8"]);
      await request(srv()).get("/apps").set("Authorization", `Bearer ${pat}`).expect(403);
    } finally {
      await setSettings(true, []);
    }
  });

  it("lets the instance owner read + write settings and blocks non-owners", async () => {
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: true } });
    try {
      const got = await request(srv()).get("/instance/settings").set("Authorization", `Bearer ${jwt}`).expect(200);
      expect(got.body).toEqual({ apiEnabled: expect.any(Boolean), apiAllowedIps: expect.any(Array), edition: expect.any(String) });

      const patched = await request(srv())
        .patch("/instance/settings")
        .set("Authorization", `Bearer ${jwt}`)
        .send({ apiAllowedIps: ["1.2.3.4", "10.0.0.0/8"] })
        .expect(200);
      expect(patched.body.apiAllowedIps).toEqual(["1.2.3.4", "10.0.0.0/8"]);

      // invalid entry → 400 (never silently persisted)
      await request(srv())
        .patch("/instance/settings")
        .set("Authorization", `Bearer ${jwt}`)
        .send({ apiAllowedIps: ["not-an-ip"] })
        .expect(400);

      // a non-owner is forbidden
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } });
      await request(srv()).get("/instance/settings").set("Authorization", `Bearer ${jwt}`).expect(403);
    } finally {
      await setSettings(true, []);
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    }
  });

  it("does not let a PAT manage instance settings (session-only)", async () => {
    // JwtAuthGuard rejects a tugra_pat_ token as an invalid JWT → 401, never reaching the owner check.
    await request(srv()).get("/instance/settings").set("Authorization", `Bearer ${pat}`).expect(401);
  });
});
