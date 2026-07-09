import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { authenticator } from "otplib";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  let accessToken = "";
  let refreshToken = "";

  it("registers a new user (first user becomes OWNER)", async () => {
    const res = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password, name: "E2E" })
      .expect(201);

    expect(res.body.user.email).toBe(email);
    expect(res.body.user.twoFaEnabled).toBe(false);
    expect(res.body.tokens.accessToken).toBeTruthy();
    accessToken = res.body.tokens.accessToken;
    refreshToken = res.body.tokens.refreshToken;
  });

  it("rejects duplicate registration", async () => {
    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password })
      .expect(409);
  });

  it("returns the current user from /auth/me", async () => {
    const res = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.email).toBe(email);
  });

  it("rejects /auth/me without a token", async () => {
    await request(app.getHttpServer()).get("/auth/me").expect(401);
  });

  it("updates the profile name via PATCH /auth/me", async () => {
    await request(app.getHttpServer())
      .patch("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "Renamed" })
      .expect(200);
    const res = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.name).toBe("Renamed");
  });

  it("defaults uiMode to fleet and switches it via PATCH /auth/me", async () => {
    const before = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(before.body.uiMode).toBe("fleet");

    await request(app.getHttpServer())
      .patch("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ uiMode: "home" })
      .expect(200);
    const after = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(200);
    expect(after.body.uiMode).toBe("home");
  });

  it("rejects an invalid uiMode", async () => {
    await request(app.getHttpServer())
      .patch("/auth/me")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ uiMode: "tablet" })
      .expect(400);
  });

  it("rejects change-password with a wrong current password", async () => {
    await request(app.getHttpServer())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: "not-the-password", newPassword: "brand-new-pw-123" })
      .expect(401);
  });

  it("changes the password (and restores it for later tests)", async () => {
    await request(app.getHttpServer())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: password, newPassword: "temp-rotated-pw-123" })
      .expect(200);
    // logging in with the new password works
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "temp-rotated-pw-123" })
      .expect(200);
    // restore so the rest of the suite (which uses `password`) keeps passing
    await request(app.getHttpServer())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: "temp-rotated-pw-123", newPassword: password })
      .expect(200);
  });

  it("logs in and rotates refresh tokens; reuse is rejected", async () => {
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    const rt = login.body.tokens.refreshToken as string;

    const rotated = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: rt })
      .expect(200);
    expect(rotated.body.refreshToken).not.toBe(rt);

    await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: rt })
      .expect(401);
  });

  it("enables 2FA and then requires the code at login", async () => {
    const setup = await request(app.getHttpServer())
      .post("/auth/2fa/setup")
      .set("Authorization", `Bearer ${accessToken}`)
      .expect(201);
    const secret = /secret=([A-Z0-9]+)/.exec(setup.body.otpauthUrl)?.[1];
    expect(secret).toBeTruthy();

    const enable = await request(app.getHttpServer())
      .post("/auth/2fa/enable")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ token: authenticator.generate(secret!) })
      .expect(200);
    // enable returns the 10 one-time recovery codes (shown once)
    const recoveryCodes = enable.body.recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);

    // Login without the code now signals twoFaRequired.
    const noCode = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    expect(noCode.body.twoFaRequired).toBe(true);

    // Login with the code succeeds.
    const withCode = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password, totp: authenticator.generate(secret!) })
      .expect(200);
    expect(withCode.body.tokens.accessToken).toBeTruthy();

    // A recovery code works as the 2FA code when TOTP is unavailable, and is single-use.
    const viaRecovery = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password, totp: recoveryCodes[0] })
      .expect(200);
    expect(viaRecovery.body.tokens.accessToken).toBeTruthy();
    // reusing the same recovery code is rejected (consumed)
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password, totp: recoveryCodes[0] })
      .expect(401);
  });

  it("rejects a bad password", async () => {
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "wrong" })
      .expect(401);
  });
});
