import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { authenticator } from "otplib";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { MailService } from "../src/mail/mail.service";

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";
  // Capture "sent" emails so the reset test can read the raw token out of the emailed link.
  const sentEmails: { to: string; html: string }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue({
        isConfigured: () => true,
        send: async (to: string, e: { html: string }) => {
          sentEmails.push({ to, html: e.html });
          return true;
        },
      })
      .compile();
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

  it("supports recovery-code status, regenerate, and 2FA disable (password + code re-auth)", async () => {
    // Fresh user so this lifecycle doesn't perturb the shared account, and to spare the login throttle.
    const u = `e2e-2fa-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
    const pw = "supersecret123";
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email: u, password: pw }).expect(201);
    const at = reg.body.tokens.accessToken as string;
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${at}`);

    const setup = await auth(request(app.getHttpServer()).post("/auth/2fa/setup")).expect(201);
    const secret = /secret=([A-Z0-9]+)/.exec(setup.body.otpauthUrl)![1];
    const enable = await auth(request(app.getHttpServer()).post("/auth/2fa/enable")).send({ token: authenticator.generate(secret) }).expect(200);
    const oldCodes = enable.body.recoveryCodes as string[];

    // Status shows 10 unused codes.
    const status = await auth(request(app.getHttpServer()).get("/auth/2fa/recovery-codes/status")).expect(200);
    expect(status.body.remaining).toBe(10);

    // Regenerate (password + TOTP) returns 10 fresh codes, distinct from the old set.
    const regen = await auth(request(app.getHttpServer()).post("/auth/2fa/recovery-codes/regenerate"))
      .send({ password: pw, code: authenticator.generate(secret) })
      .expect(200);
    const newCodes = regen.body.recoveryCodes as string[];
    expect(newCodes).toHaveLength(10);
    expect(newCodes).not.toContain(oldCodes[0]);

    // Disable needs password + a valid code: wrong password → 401; correct password + a NEW recovery code → 200.
    await auth(request(app.getHttpServer()).post("/auth/2fa/disable")).send({ password: "wrong-pw", code: authenticator.generate(secret) }).expect(401);
    await auth(request(app.getHttpServer()).post("/auth/2fa/disable")).send({ password: pw, code: newCodes[0] }).expect(200);

    // 2FA is off → login no longer asks for a code (the one login here keeps within the throttle).
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email: u, password: pw }).expect(200);
    expect(login.body.tokens.accessToken).toBeTruthy();
    expect(login.body.twoFaRequired).toBeUndefined();

    await prisma.user.deleteMany({ where: { email: u } }).catch(() => undefined);
  });

  it("rejects a bad password", async () => {
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "wrong" })
      .expect(401);
  });

  it("logout-all revokes the caller's active sessions", async () => {
    // Fresh user so this doesn't disturb the shared account (which now has 2FA enabled).
    const u = `e2e-la-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email: u, password }).expect(201);
    const access = reg.body.tokens.accessToken as string;
    // Rotate once so we hold a live, current refresh token.
    const rotated = await request(app.getHttpServer())
      .post("/auth/refresh")
      .send({ refreshToken: reg.body.tokens.refreshToken })
      .expect(200);
    const liveRt = rotated.body.refreshToken as string;

    await request(app.getHttpServer())
      .post("/auth/logout-all")
      .set("Authorization", `Bearer ${access}`)
      .expect(200);

    // Every refresh token for the user is revoked → the live one is now dead.
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken: liveRt }).expect(401);
    // logout-all requires auth.
    await request(app.getHttpServer()).post("/auth/logout-all").expect(401);

    await prisma.user.deleteMany({ where: { email: u } }).catch(() => undefined);
  });

  it("resets a password via an emailed single-use token (enumeration-safe, revokes sessions)", async () => {
    const u = `e2e-reset-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
    const oldPw = "old-pass-1234";
    const newPw = "new-pass-5678";
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ email: u, password: oldPw }).expect(201);
    const preResetRefresh = reg.body.tokens.refreshToken as string;

    sentEmails.length = 0;
    // Forgot returns 200 for BOTH an existing and an unknown email (no account enumeration).
    await request(app.getHttpServer()).post("/auth/forgot-password").send({ email: u }).expect(200);
    await request(app.getHttpServer()).post("/auth/forgot-password").send({ email: `ghost-${Date.now()}@x.io` }).expect(200);
    // Only the real account got an email; pull the raw token out of the link.
    const mine = sentEmails.filter((e) => e.to === u);
    expect(mine).toHaveLength(1);
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mine[0].html)![1];
    expect(token).toBeTruthy();
    // The DB stores only a hash — the raw token from the link is never a stored value.
    expect(await prisma.verificationToken.findFirst({ where: { tokenHash: token } })).toBeNull();

    await request(app.getHttpServer()).post("/auth/reset-password").send({ token, newPassword: newPw }).expect(200);

    // Reset revoked every session → the pre-reset refresh token is dead.
    await request(app.getHttpServer()).post("/auth/refresh").send({ refreshToken: preResetRefresh }).expect(401);
    // The new password logs in.
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email: u, password: newPw }).expect(200);
    expect(login.body.tokens.accessToken).toBeTruthy();
    // The token is single-use.
    await request(app.getHttpServer()).post("/auth/reset-password").send({ token, newPassword: "another-9999" }).expect(400);

    await prisma.user.deleteMany({ where: { email: u } }).catch(() => undefined);
  });
});
