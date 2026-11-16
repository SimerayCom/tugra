import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { generateMigrationToken } from "../../../../importer/migration-token";
import { MigrationTokenService } from "../../../../importer/migration-token.service";
import { HostReportController } from "./host-report.controller";
import { HostReportService } from "./host-report.service";

jest.setTimeout(30_000);

describe("HostReportController (routes, guard, raw bodies)", () => {
  let app: INestApplication;
  const TOKEN = generateMigrationToken();
  const reports = { ingest: jest.fn(async () => ({ stored: 1, ignored: 0 })), ping: jest.fn(() => ({ ok: true, partMiB: 128 })), probeCap: 1024 };
  const tokens = { validate: jest.fn(async (raw: string) => (raw === TOKEN ? { opId: "op-1", actorId: "user-1", expiresAt: new Date(Date.now() + 3_600_000) } : null)) };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [HostReportController], providers: [{ provide: HostReportService, useValue: reports }, { provide: MigrationTokenService, useValue: tokens }] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    reports.ingest.mockClear();
    reports.ping.mockClear();
  });

  const auth = (r: request.Test) => r.set("Authorization", `Bearer ${TOKEN}`);

  it("every route is behind the migration token (the uniform 401) and nothing is called without it", async () => {
    const s = () => request(app.getHttpServer());
    for (const t of [undefined, "Bearer nope", `Bearer tugra_pat_${"a".repeat(43)}`]) {
      const apply = (r: request.Test) => (t ? r.set("Authorization", t) : r);
      expect((await apply(s().post("/api/v1/import/migration/host-report").set("Content-Type", "text/plain").send("x"))).status).toBe(401);
      expect((await apply(s().get("/api/v1/import/migration/host-probe/ping"))).status).toBe(401);
      expect((await apply(s().post("/api/v1/import/migration/host-probe/sink").set("Content-Type", "application/octet-stream").send("x"))).status).toBe(401);
    }
    expect(reports.ingest).not.toHaveBeenCalled();
    expect(reports.ping).not.toHaveBeenCalled();
  });

  it("host-report hands the text body and the token's op to the service; the opId in the body is never read", async () => {
    const text = "TUGRA_AT\tsrv-a\tTUGRA_HOST\tDATA_SEED\tfinished\tok\t0\n";
    const res = await auth(request(app.getHttpServer()).post("/api/v1/import/migration/host-report").set("Content-Type", "text/plain").send(text));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 1, ignored: 0 });
    expect(reports.ingest).toHaveBeenCalledWith(expect.objectContaining({ opId: "op-1", actorId: "user-1" }), text);
  });

  it("host-report accepts text/plain only (a JSON body is 415) and refuses an oversized one before the service", async () => {
    expect((await auth(request(app.getHttpServer()).post("/api/v1/import/migration/host-report").send({ a: 1 }))).status).toBe(415);
    const big = "x".repeat(1024 * 1024 + 10);
    // the server answers 413 from the Content-Length without reading the body, so the client may see the reset first
    const status = await auth(request(app.getHttpServer()).post("/api/v1/import/migration/host-report").set("Content-Type", "text/plain").send(big)).then(
      (r) => r.status,
      (e: { code?: string }) => (e.code === "ECONNRESET" || e.code === "EPIPE" ? 413 : -1),
    );
    expect(status).toBe(413);
    expect(reports.ingest).not.toHaveBeenCalled();
  });

  it("ping answers the part size; the sink counts a raw upload and refuses more than its cap", async () => {
    const ping = await auth(request(app.getHttpServer()).get("/api/v1/import/migration/host-probe/ping"));
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ ok: true, partMiB: 128 });
    const ok = await auth(request(app.getHttpServer()).post("/api/v1/import/migration/host-probe/sink").set("Content-Type", "application/octet-stream").send(Buffer.alloc(500)));
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: 500 });
    const over = await auth(request(app.getHttpServer()).post("/api/v1/import/migration/host-probe/sink").set("Content-Type", "application/octet-stream").send(Buffer.alloc(2000)));
    expect(over.status).toBe(413);
  });
});
