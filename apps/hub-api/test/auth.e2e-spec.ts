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

    await request(app.getHttpServer())
      .post("/auth/2fa/enable")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ token: authenticator.generate(secret!) })
      .expect(200);

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
  });

  it("rejects a bad password", async () => {
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "wrong" })
      .expect(401);
  });
});
