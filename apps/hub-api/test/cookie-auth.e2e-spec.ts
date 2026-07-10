import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

/** Pull one cookie's value out of a Set-Cookie header array. */
function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const line = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  if (!line) return undefined;
  return decodeURIComponent(line.slice(name.length + 1).split(";")[0]);
}

/** The full Set-Cookie line for a name (to assert flags like HttpOnly). */
function cookieLine(setCookie: string[] | undefined, name: string): string | undefined {
  return (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
}

describe("Cookie auth + CSRF (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `cookie-${Date.now()}-${Math.floor(Math.random() * 1e6)}@tugra.test`;
  const password = "supersecret123";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } }).catch(() => undefined);
    await app.close();
  });

  const agent = () => request.agent(app.getHttpServer());
  let csrf = "";
  let bearer = "";

  it("register sets httpOnly session cookies + a JS-readable CSRF cookie, and still returns body tokens", async () => {
    const a = agent();
    const res = await a.post("/auth/register").send({ email, password, name: "Cookie" }).expect(201);

    // Dual-mode: body still carries tokens (bearer clients unaffected).
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
    bearer = res.body.tokens.accessToken;

    const set = res.headers["set-cookie"] as unknown as string[];
    expect(cookieLine(set, "tg_access")).toMatch(/HttpOnly/i);
    expect(cookieLine(set, "tg_refresh")).toMatch(/HttpOnly/i);
    // CSRF cookie must be readable by JS → NOT HttpOnly.
    expect(cookieLine(set, "tg_csrf")).toBeDefined();
    expect(cookieLine(set, "tg_csrf")).not.toMatch(/HttpOnly/i);
    expect(cookieValue(set, "tg_csrf")).toBeTruthy();
  });

  it("authenticates a protected GET from the cookie alone (no Authorization header)", async () => {
    const a = agent();
    await a.post("/auth/login").send({ email, password }).expect(200);
    const res = await a.get("/auth/me").expect(200);
    expect(res.body.email).toBe(email);
  });

  it("blocks a cookie-authed mutation without the CSRF header (403), allows it with the header", async () => {
    const a = agent();
    const login = await a.post("/auth/login").send({ email, password }).expect(200);
    csrf = cookieValue(login.headers["set-cookie"] as unknown as string[], "tg_csrf")!;
    expect(csrf).toBeTruthy();

    // Cookie session + no X-CSRF-Token → rejected.
    await a.patch("/auth/me").send({ name: "NoCsrf" }).expect(403);

    // Same session WITH the double-submit header → allowed.
    const ok = await a.patch("/auth/me").set("X-CSRF-Token", csrf).send({ name: "WithCsrf" }).expect(200);
    expect(ok.body.name).toBe("WithCsrf");

    // A wrong CSRF value is still rejected.
    await a.patch("/auth/me").set("X-CSRF-Token", "wrong").send({ name: "Bad" }).expect(403);
  });

  it("refreshes from the cookie (empty body) and preserves the CSRF token", async () => {
    const a = agent();
    const login = await a.post("/auth/login").send({ email, password }).expect(200);
    const csrf0 = cookieValue(login.headers["set-cookie"] as unknown as string[], "tg_csrf")!;

    const res = await a.post("/auth/refresh").set("X-CSRF-Token", csrf0).send({}).expect(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();

    // Refresh rotates the session cookies but keeps the CSRF value stable (no rotation race).
    const set = res.headers["set-cookie"] as unknown as string[];
    expect(cookieLine(set, "tg_access")).toMatch(/HttpOnly/i);
    expect(cookieValue(set, "tg_csrf")).toBe(csrf0);

    // The rotated cookie still authenticates.
    await a.get("/auth/me").expect(200);
  });

  it("logout clears the session cookies (subsequent cookie-auth fails)", async () => {
    const a = agent();
    const login = await a.post("/auth/login").send({ email, password }).expect(200);
    const c = cookieValue(login.headers["set-cookie"] as unknown as string[], "tg_csrf")!;
    await a.get("/auth/me").expect(200);

    await a.post("/auth/logout").set("X-CSRF-Token", c).send({}).expect(200);
    await a.get("/auth/me").expect(401);
  });

  it("public auth routes (login) are CSRF-exempt even with a stale session cookie (no re-login lockout)", async () => {
    const a = agent();
    await a.post("/auth/login").send({ email, password }).expect(200); // seeds the session cookies
    // Re-login carries tg_access/tg_refresh cookies but sends NO X-CSRF-Token — must still succeed
    // because login is a public, body-authenticated route (@CsrfExempt), not a cookie-authed action.
    await a.post("/auth/login").send({ email, password }).expect(200);
  });

  it("bearer-authed mutations are exempt from CSRF (no header needed)", async () => {
    // Plain request (no cookie jar) with a Bearer token, no X-CSRF-Token → still allowed.
    await request(app.getHttpServer())
      .patch("/auth/me")
      .set("Authorization", `Bearer ${bearer}`)
      .send({ name: "BearerNoCsrf" })
      .expect(200);
  });

  it("mints a short-lived terminal ticket for a cookie session (CSRF-protected)", async () => {
    const a = agent();
    const login = await a.post("/auth/login").send({ email, password }).expect(200);
    const c = cookieValue(login.headers["set-cookie"] as unknown as string[], "tg_csrf")!;

    // Without CSRF → 403 (it's a cookie-authed POST).
    await a.post("/terminal/ticket").send({}).expect(403);

    const res = await a.post("/terminal/ticket").set("X-CSRF-Token", c).send({}).expect(200);
    expect(typeof res.body.ticket).toBe("string");
    expect(res.body.ticket.split(".")).toHaveLength(3); // looks like a JWT
  });
});
