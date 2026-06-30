import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("GitHub OAuth (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "e2e-client";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "e2e-secret";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
    await app.close();
  });

  it("GET /auth/oauth/github redirects to GitHub's consent screen with a state", async () => {
    const res = await request(app.getHttpServer()).get("/auth/oauth/github").expect(302);
    const loc = res.headers.location as string;
    expect(loc).toContain("github.com/login/oauth/authorize");
    expect(loc).toContain("client_id=e2e-client");
    expect(loc).toContain("state=");
    expect(loc).toContain("redirect_uri=");
  });
});
