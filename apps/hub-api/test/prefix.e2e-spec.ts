import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app-config";

describe("api/v1 global prefix (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app); // mirror the real bootstrap (main.ts)
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("serves REST routes under /api/v1 and 404s the bare path", async () => {
    // /servers is auth-guarded; a prefixed hit reaches the guard (401), proving the route is mounted there.
    await request(srv()).get("/api/v1/servers").expect(401);
    await request(srv()).get("/servers").expect(404);
  });

  it("keeps infra routes (health/version) exempt at bare paths", async () => {
    await request(srv()).get("/health").expect(200);
    await request(srv()).get("/version").expect(200);
    await request(srv()).get("/api/v1/health").expect(404);
    await request(srv()).get("/api/v1/version").expect(404);
  });

  it("keeps external-facing routes (OAuth start, webhooks) exempt at bare paths", async () => {
    // OAuth start is reachable un-prefixed (redirects to GitHub / errors if unconfigured — never a routing 404).
    expect((await request(srv()).get("/auth/oauth/github")).status).not.toBe(404);
    await request(srv()).get("/api/v1/auth/oauth/github").expect(404);
    // Webhook deploy is a bare POST; an unknown token is handled by the controller, not a routing 404.
    expect((await request(srv()).post("/webhooks/deploy/nope").send({})).status).not.toBe(404);
    await request(srv()).post("/api/v1/webhooks/deploy/nope").send({}).expect(404);
  });
});
