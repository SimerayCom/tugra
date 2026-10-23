import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../app-config";
import { InstallController } from "./install.controller";
import { UpdateService } from "../update/update.service";

// DB-free route test: the REAL InstallController (so the @Header/@SkipThrottle/prefix-exclude decorators
// run) with stubbed Config/Update providers, no Prisma — runs locally AND in unit CI.
describe("InstallController HTTP (migrator.sh route)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [InstallController],
      providers: [
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: UpdateService, useValue: { verifyLatestEntry: jest.fn().mockResolvedValue({ status: "unconfigured" }) } },
      ],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const srv = () => app.getHttpServer();

  it("serves migrator.sh publicly at the BARE path with a shell content-type and no-store", async () => {
    const res = await request(srv()).get("/install/migrator.sh").expect(200);
    expect(res.headers["content-type"]).toContain("text/x-shellscript");
    expect(res.headers["content-type"]).toContain("charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text.startsWith("#!/bin/sh")).toBe(true);
    expect(res.text).toContain("TUGRA_MIGRATION_TOKEN");
    expect(res.text).toContain("migrate");
    // `tugra_mig_` appears only as the token-prefix validation pattern, never a full embedded token
    expect(res.text).not.toMatch(/tugra_mig_[A-Za-z0-9_-]{43}/);
  });

  it("is EXEMPT from the /api/v1 prefix (prefixed path 404s; agent.sh still 200)", async () => {
    await request(srv()).get("/api/v1/install/migrator.sh").expect(404);
    await request(srv()).get("/install/agent.sh").expect(200);
  });

  it("is GET-only (POST 404s)", async () => {
    await request(srv()).post("/install/migrator.sh").expect(404);
  });

  it("never reflects a query token/hub into the static script", async () => {
    const queryToken = "tugra_mig_" + "a".repeat(43);
    const res = await request(srv())
      .get("/install/migrator.sh?token=" + queryToken + "&hub=http://evil;id")
      .expect(200);
    expect(res.text).not.toContain(queryToken); // the query token is NOT reflected into the static script
    expect(res.text).not.toContain("evil");
  });
});
