import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app-config";
import { setupOpenApi } from "../src/openapi/openapi";

describe("OpenAPI serving (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app); // mirror main.ts
    setupOpenApi(app); // mounts /api/docs + /api/v1/openapi.json
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("serves a valid OpenAPI 3.1 document at /api/v1/openapi.json with the pat scheme", async () => {
    const res = await request(srv()).get("/api/v1/openapi.json").expect(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(50);
    expect(res.body.components.securitySchemes.pat).toMatchObject({ type: "http", scheme: "bearer" });
    // every documented public route is present (spot-check the app + server resources)
    expect(res.body.paths["/api/v1/apps"]).toBeDefined();
    expect(res.body.paths["/api/v1/servers"]).toBeDefined();
  });

  it("serves the Swagger UI at /api/docs", async () => {
    const res = await request(srv()).get("/api/docs").expect(200);
    expect(res.text).toMatch(/swagger-ui/i);
  });
});
