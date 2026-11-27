import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../app-config";
import { McpOAuthEndpointsController, McpOAuthMetadataController } from "./oauth.controller";
import { McpOAuthService } from "./oauth.service";

describe("MCP OAuth HTTP surface", () => {
  let app: INestApplication;
  const oauth = { register: jest.fn(), exchangeCode: jest.fn(), refresh: jest.fn(), revokeToken: jest.fn() };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [McpOAuthMetadataController, McpOAuthEndpointsController],
      providers: [
        { provide: McpOAuthService, useValue: oauth },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(() => app.close());
  const srv = () => app.getHttpServer();

  it("serves the discovery documents at the origin root", async () => {
    const pr = await request(srv()).get("/.well-known/oauth-protected-resource").set("Host", "hub.test").set("X-Forwarded-Proto", "https").expect(200);
    expect(pr.body.resource).toBe("https://hub.test/api/v1/mcp");
    const prMcp = await request(srv()).get("/.well-known/oauth-protected-resource/api/v1/mcp").set("Host", "hub.test").set("X-Forwarded-Proto", "https").expect(200);
    expect(prMcp.body.authorization_servers).toEqual(["https://hub.test"]);
    const as = await request(srv()).get("/.well-known/oauth-authorization-server").set("Host", "hub.test").set("X-Forwarded-Proto", "https").expect(200);
    expect(as.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.body.registration_endpoint).toBe("https://hub.test/api/v1/oauth/register");
    await request(srv()).get("/api/v1/.well-known/oauth-authorization-server").expect(404);
  });

  it("registration answers 201", async () => {
    oauth.register.mockResolvedValue({ client_id: "c1" });
    await request(srv()).post("/api/v1/oauth/register").send({ redirect_uris: ["http://localhost:1/cb"] }).expect(201);
    expect(oauth.register).toHaveBeenCalledWith({ redirect_uris: ["http://localhost:1/cb"] });
  });

  it("the token endpoint takes a form body and dispatches on grant_type", async () => {
    oauth.exchangeCode.mockResolvedValue({ access_token: "a" });
    oauth.refresh.mockResolvedValue({ access_token: "b" });
    const r = await request(srv()).post("/api/v1/oauth/token").type("form").send({ grant_type: "authorization_code", code: "c", code_verifier: "v", client_id: "x", redirect_uri: "http://localhost:1/cb" }).expect(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(oauth.exchangeCode).toHaveBeenCalledWith({ code: "c", code_verifier: "v", client_id: "x", redirect_uri: "http://localhost:1/cb" });
    await request(srv()).post("/api/v1/oauth/token").type("form").send({ grant_type: "refresh_token", refresh_token: "r", client_id: "x" }).expect(200);
    expect(oauth.refresh).toHaveBeenCalledWith({ refresh_token: "r", client_id: "x" });
    const bad = await request(srv()).post("/api/v1/oauth/token").type("form").send({ grant_type: "password" }).expect(400);
    expect(bad.body.error).toBe("unsupported_grant_type");
  });

  it("revocation always answers 200", async () => {
    await request(srv()).post("/api/v1/oauth/revoke").type("form").send({ token: "t", client_id: "x" }).expect(200);
    expect(oauth.revokeToken).toHaveBeenCalledWith("t", "x");
  });
});
