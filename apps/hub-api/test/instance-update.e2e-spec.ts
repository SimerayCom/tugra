import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

// Bare paths (no configureApp) — mirrors instance-api-gating.e2e-spec. Exercises the owner-only
// GET /instance/update status endpoint. Update checks are hard-off in test (TUGRA_UPDATE_CHECKS=0 from the
// test env setup), so getStatus just reads the InstanceSettings singleton + the running version — no remote
// fetch, no scheduler.
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
        channelSource: expect.stringMatching(/^(auto|explicit)$/),
        updateAvailable: false, // report-only, never a downgrade
        changelogUrl: null,
        autoUpdate: expect.any(Boolean),
        notice: null, // no signed check has run in test
        checksEnabled: false, // hard-off in test
        checkIntervalMin: 60,
        lastCheckedAt: null,
        lastCheckError: null,
        updater: { version: null, state: "unknown", behind: false, checkedAt: null }, // no updater has reported in test
        halfUpdate: null, // no half-finished update in test
        inFlight: [], // nothing running in a fresh test hub
        hold: null,
      });

      // a non-owner is forbidden
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } });
      await request(srv()).get("/instance/update").set("Authorization", `Bearer ${jwt}`).expect(403);
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    }
  });

  it("lets the owner set the update channel + auto-update (and blocks non-owners / PATs)", async () => {
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: true } });
    try {
      const patched = await request(srv())
        .patch("/instance/update")
        .set("Authorization", `Bearer ${jwt}`)
        .send({ updateChannel: "beta", autoUpdate: true })
        .expect(200);
      expect(patched.body).toMatchObject({ channel: "beta", autoUpdate: true });

      expect(patched.body).toMatchObject({ channelSource: "explicit" });

      // null → automatic: the channel follows the running build ("0.0.0-dev" is a prerelease → beta)
      const auto = await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${jwt}`).send({ updateChannel: null }).expect(200);
      expect(auto.body).toMatchObject({ channelSource: "auto", channel: "beta", autoUpdate: true });
      // stored as the non-null "auto" sentinel (an older hub image must still be able to read the row)
      expect((await prisma.instanceSettings.findUniqueOrThrow({ where: { id: "singleton" } })).updateChannel).toBe("auto");

      // absent → unchanged (autoUpdate-only patch keeps the automatic channel)
      const kept = await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${jwt}`).send({ autoUpdate: false }).expect(200);
      expect(kept.body).toMatchObject({ channelSource: "auto", autoUpdate: false });

      // an explicit pin flips it back
      const pinned = await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${jwt}`).send({ updateChannel: "stable" }).expect(200);
      expect(pinned.body).toMatchObject({ channelSource: "explicit", channel: "stable" });

      // an invalid channel → 400 (enum-constrained)
      await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${jwt}`).send({ updateChannel: "nope" }).expect(400);
      await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${jwt}`).send({ updateChannel: "edge" }).expect(400);

      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } });
      await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${jwt}`).send({ autoUpdate: false }).expect(403);
    } finally {
      await prisma.instanceSettings.update({ where: { id: "singleton" }, data: { updateChannel: "auto", autoUpdate: false } }).catch(() => undefined);
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    }
  });

  it("GET /instance/version gives members exactly the four-field slice (no preference leak)", async () => {
    const got = await request(srv()).get("/instance/version").set("Authorization", `Bearer ${jwt}`).expect(200);
    expect(Object.keys(got.body).sort()).toEqual(["channel", "current", "latest", "updateAvailable"]);
  });

  it("lets the owner trigger a manual check (unconfigured → no-op, still 200) and blocks non-owners", async () => {
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: true } });
    try {
      const res = await request(srv()).post("/instance/update/check").set("Authorization", `Bearer ${jwt}`).expect(200);
      expect(res.body).toMatchObject({ current: expect.any(String), updateAvailable: false });
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } });
      await request(srv()).post("/instance/update/check").set("Authorization", `Bearer ${jwt}`).expect(403);
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    }
  });

  it("owner can request an apply (unconfigured → up-to-date/unconfigured, still 200) and blocks non-owners", async () => {
    await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: true } });
    try {
      // update checks are hard-off in test → verifyLatestEntry unconfigured → a 200 typed status (no docker).
      const res = await request(srv()).post("/instance/update").set("Authorization", `Bearer ${jwt}`).expect(200);
      expect(res.body).toMatchObject({ status: expect.any(String) });
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } });
      await request(srv()).post("/instance/update").set("Authorization", `Bearer ${jwt}`).expect(403);
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { isInstanceOwner: false } }).catch(() => undefined);
    }
  });

  it("does not let a PAT read or change the update status (session-only)", async () => {
    // JwtAuthGuard rejects a tugra_pat_ token as an invalid JWT → 401, never reaching the owner check.
    await request(srv()).get("/instance/update").set("Authorization", `Bearer ${pat}`).expect(401);
    await request(srv()).patch("/instance/update").set("Authorization", `Bearer ${pat}`).send({ autoUpdate: true }).expect(401);
    await request(srv()).post("/instance/update").set("Authorization", `Bearer ${pat}`).expect(401);
  });
});
