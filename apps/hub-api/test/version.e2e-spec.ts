import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("GET /version (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("is public (no auth) and returns the version descriptor", async () => {
    const res = await request(app.getHttpServer()).get("/version").expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        version: expect.any(String),
        protocol: 2,
        channel: expect.any(String),
        commit: expect.any(String),
        edition: expect.any(String),
      }),
    );
  });

  it("also surfaces the version in /health", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({ status: "ok", service: "tugra-hub-api", version: expect.any(String), protocol: 2 }),
    );
  });
});
