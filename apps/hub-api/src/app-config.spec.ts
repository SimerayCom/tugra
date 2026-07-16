import { Controller, Get, INestApplication, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "./app-config";
import { HealthController } from "./health/health.controller";
import { VersionController } from "./health/version.controller";

// Stand-ins for a real REST controller and a param-route webhook controller. Kept dependency-free (no
// Prisma) so this route-level test runs WITHOUT a database — it exercises configureApp's prefix + exempt
// mechanics locally; the full-route behaviour is verified by test/prefix.e2e-spec.ts in CI.
@Controller("dummy")
class DummyController {
  @Get()
  get() {
    return { ok: true };
  }
}

@Controller("webhooks")
class DummyWebhookController {
  @Post("deploy/:token")
  deploy() {
    return { received: true };
  }
}

describe("configureApp — /api/v1 prefix + exemptions", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [HealthController, VersionController, DummyController, DummyWebhookController],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("mounts ordinary REST controllers under /api/v1 (the bare path 404s)", async () => {
    await request(srv()).get("/api/v1/dummy").expect(200);
    await request(srv()).get("/dummy").expect(404);
  });

  it("keeps health/version EXEMPT at the bare path (never under the prefix)", async () => {
    await request(srv()).get("/health").expect(200);
    await request(srv()).get("/version").expect(200);
    await request(srv()).get("/api/v1/health").expect(404);
    await request(srv()).get("/api/v1/version").expect(404);
  });

  it("keeps the parameterized webhook route EXEMPT at the bare path", async () => {
    await request(srv()).post("/webhooks/deploy/tok123").expect(201); // bare POST reaches the controller
    await request(srv()).post("/api/v1/webhooks/deploy/tok123").expect(404); // not mounted under the prefix
  });
});
