import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app-config";

describe("GET /instance/status (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app); // mirror the real bootstrap (main.ts) so the /api/v1 prefix applies
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("is public (no auth) and returns the onboarding status triple under /api/v1", async () => {
    const res = await request(srv()).get("/api/v1/instance/status").expect(200);
    expect(res.body).toEqual({
      initialized: expect.any(Boolean),
      allowRegistration: expect.any(Boolean),
      edition: expect.any(String),
    });
    // never exposes any other settings field
    expect(Object.keys(res.body).sort()).toEqual(["allowRegistration", "edition", "initialized"]);
  });

  it("is a normal API route — not exempt from the prefix", async () => {
    await request(srv()).get("/instance/status").expect(404);
  });
});
