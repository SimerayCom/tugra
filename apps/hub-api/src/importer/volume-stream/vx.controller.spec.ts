import { ConflictException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { MigrationVolumeController } from "./vx.controller";
import { VxService } from "./vx.service";
import { MigrationTokenService } from "../migration-token.service";
import { generateMigrationToken } from "../migration-token";
import { APP_VOL_REF, RUN } from "./testing/vx-fixtures";

const sha = "a".repeat(64);
const fp = { containerId: "c".repeat(64), startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-14T10:00:00Z", exitCode: 0, mountType: "volume", imageId: "sha256:x" };
const ENC = encodeURIComponent(APP_VOL_REF);

jest.setTimeout(30_000); // the Nest testing module compiles slowly when the whole suite runs in parallel

describe("MigrationVolumeController (routes, guard, strict bodies)", () => {
  let app: INestApplication;
  const TOKEN = generateMigrationToken();
  const vx = Object.fromEntries(
    ["inventory", "diskCheck", "begin", "registerPart", "commitPart", "finish", "status", "beat", "reset", "abort", "speedtestPart", "speedtestCommit", "speedtestEnd"].map((m) => [m, jest.fn().mockResolvedValue({ ok: true })]),
  );
  const tokens = { validate: jest.fn(async (raw: string) => (raw === TOKEN ? { opId: "op-1", actorId: "user-1", expiresAt: new Date(Date.now() + 3_600_000) } : null)) };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ controllers: [MigrationVolumeController], providers: [{ provide: VxService, useValue: vx }, { provide: MigrationTokenService, useValue: tokens }] }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix("api/v1");
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => Object.values(vx).forEach((f) => f.mockClear()));
  const post = (path: string, body: unknown = {}) => request(app.getHttpServer()).post(`/api/v1/import/migration/vx/${path}`).set("Authorization", `Bearer ${TOKEN}`).send(body as object);

  it("every route is behind the migration token: no / wrong / PAT-shaped credential is the uniform 401 and nothing is called", async () => {
    for (const auth of [undefined, "Bearer nope", `Bearer tugra_pat_${"a".repeat(43)}`, `Bearer ${generateMigrationToken()}`]) {
      const r = request(app.getHttpServer()).post("/api/v1/import/migration/vx/inventory").send({ runId: RUN, items: [] });
      const res = await (auth ? r.set("Authorization", auth) : r);
      expect(res.status).toBe(401);
    }
    expect((await request(app.getHttpServer()).get(`/api/v1/import/migration/vx/${ENC}/status`)).status).toBe(401);
    for (const f of Object.values(vx)) expect(f).not.toHaveBeenCalled();
  });

  it("the opId comes from the token only; the itemRef arrives url-decoded (colons intact)", async () => {
    await post(`${ENC}/begin`, { runId: RUN, partRawBytes: 134217728, fingerprint: fp }).expect(200);
    expect(vx.begin).toHaveBeenCalledWith(expect.objectContaining({ opId: "op-1", actorId: "user-1" }), APP_VOL_REF, expect.objectContaining({ runId: RUN }));
    await post(`${ENC}/begin`, { runId: RUN, partRawBytes: 1, fingerprint: fp, opId: "another-op" }).expect(400); // a body opId is not even accepted
  });

  it("bodies are strict: unknown keys, bad hashes, bad run ids and bad ints are 400 and never reach the service", async () => {
    await post(`${ENC}/parts/0`, { runId: RUN, rawOffset: 0, rawLen: 10, rawSha256: sha, size: 5, sha256: sha, extra: 1 }).expect(400);
    await post(`${ENC}/parts/0`, { runId: RUN, rawOffset: 0, rawLen: 10, rawSha256: "xyz", size: 5, sha256: sha }).expect(400);
    await post(`${ENC}/parts/0`, { runId: "x", rawOffset: 0, rawLen: 10, rawSha256: sha, size: 5, sha256: sha }).expect(400);
    await post(`${ENC}/parts/abc`, { runId: RUN, rawOffset: 0, rawLen: 10, rawSha256: sha, size: 5, sha256: sha }).expect(400); // idx is not an int
    await post("inventory", { runId: RUN, items: [] }).expect(400); // at least one item
    expect(vx.registerPart).not.toHaveBeenCalled();
    expect(vx.inventory).not.toHaveBeenCalled();
  });

  it("status codes: part registration/commit/beat/reset/abort 200, finish 202, status is a GET", async () => {
    await post(`${ENC}/parts/3`, { runId: RUN, rawOffset: 0, rawLen: 10, rawSha256: sha, size: 5, sha256: sha }).expect(200);
    expect(vx.registerPart).toHaveBeenCalledWith(expect.anything(), APP_VOL_REF, 3, expect.objectContaining({ rawLen: 10 }));
    await post(`${ENC}/parts/3/commit`, { runId: RUN }).expect(200);
    await post(`${ENC}/beat`, { runId: RUN, phase: "skipping" }).expect(200);
    await post(`${ENC}/reset`, { runId: RUN }).expect(200);
    await post(`${ENC}/abort`, { runId: RUN }).expect(200);
    await post(`${ENC}/beat`, { runId: RUN, phase: "not-a-phase" }).expect(400);
    await post(`${ENC}/finish`, { runId: RUN, parts: 1, rawBytes: 10, entries: 2, fingerprintAfter: { containerId: "c".repeat(64), startedAt: "a", finishedAt: "b", running: false } }).expect(202);
    await request(app.getHttpServer()).get(`/api/v1/import/migration/vx/${ENC}/status`).set("Authorization", `Bearer ${TOKEN}`).expect(200);
    expect(vx.status).toHaveBeenCalled();
  });

  it("a service 409 (the literal the migrator keys on) reaches the client unchanged", async () => {
    vx.begin.mockRejectedValueOnce(new ConflictException("vx-fingerprint-changed"));
    const res = await post(`${ENC}/begin`, { runId: RUN, partRawBytes: 1, fingerprint: fp });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("vx-fingerprint-changed");
  });

  it("speed test and disk check routes exist with strict bodies", async () => {
    await post(`${ENC}/speedtest/0`, { runId: RUN, size: 100, sha256: sha }).expect(200);
    await post(`${ENC}/speedtest/0`, { runId: RUN, size: 100, sha256: sha, extra: true }).expect(400);
    await post(`${ENC}/speedtest/0/commit`, { runId: RUN }).expect(200);
    await post(`${ENC}/speedtest-end`, { runId: RUN }).expect(200);
    await post(`${ENC}/disk-check`, { runId: RUN, rawBytes: 5 }).expect(201);
    expect(vx.speedtestPart).toHaveBeenCalledTimes(1);
  });
});
