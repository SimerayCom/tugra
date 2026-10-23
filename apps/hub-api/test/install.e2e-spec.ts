import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app-config";

describe("GET /install/agent.sh (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app); // mirror the real bootstrap (main.ts) so the /api/v1 prefix + exclude apply
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("serves the bootstrap script publicly at the BARE path (no auth, shell content-type)", async () => {
    const res = await request(srv()).get("/install/agent.sh").expect(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.text).toContain("#!/bin/sh");
    expect(res.text).toContain("docker run -d");
    expect(res.text).toContain("ghcr.io/simeraycom/tugra-agent:");
  });

  it("is EXEMPT from the /api/v1 prefix — the prefixed path 404s", async () => {
    await request(srv()).get("/api/v1/install/agent.sh").expect(404);
  });

  it("serves the one-click migrator bootstrap at the BARE path (public, hardened, same image)", async () => {
    const res = await request(srv()).get("/install/migrator.sh").expect(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain("#!/bin/sh");
    expect(res.text).toContain("--cap-drop ALL");
    expect(res.text).toContain("/var/run/docker.sock");
    expect(res.text).toContain("ghcr.io/simeraycom/tugra-agent:");
    expect(res.text).toContain("migrate");
    // the token rides the env (name-only -e), never a value-bearing -e or an embedded literal token
    expect(res.text).not.toMatch(/-e\s+TUGRA_MIGRATION_TOKEN=/);
    expect(res.text).not.toMatch(/tugra_mig_[A-Za-z0-9_-]{43}/);
  });

  it("migrator.sh is EXEMPT from the /api/v1 prefix — the prefixed path 404s", async () => {
    await request(srv()).get("/api/v1/install/migrator.sh").expect(404);
  });
});
