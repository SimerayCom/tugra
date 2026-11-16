import { CanActivate, ExecutionContext, INestApplication, Injectable } from "@nestjs/common";
import { APP_FILTER, Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { configureApp } from "../app-config";
import { ApiExceptionFilter } from "../common/api-exception.filter";
import { MIGRATION_RUNS_FACADE, STEP_HANDLERS, STEP_KEYS, type StepHandlerRegistry } from "./core/run-contract";
import { StepHandlerRegistryService } from "./core/step-handler.registry";
import { StepRegistryModule } from "./core/step-registry.module";
import { MigrationRunsController } from "./migration-runs.controller";
import { MigrationRunsModule } from "./migration-runs.module";
import { RunDataStepsModule } from "./steps/data/run-data-steps.module";
import { RunCutoverStepsModule } from "./steps/cutover/run-cutover-steps.module";
import { RunImportStepsModule } from "./steps/import/run-import-steps.module";

/** Stands in for ApiAuthGuard: scopes (and PAT-ness) arrive in headers; the real ScopesGuard still runs. */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const raw = String(req.headers["x-test-scopes"] ?? "*");
    req.user = { userId: "u1", scopes: raw === "" ? [] : raw.split(","), ...(req.headers["x-test-pat"] ? { tokenId: "tok1" } : {}) };
    return true;
  }
}

const H64 = "c".repeat(64);
const H32 = "d".repeat(32);

const FACADE_METHODS = ["create", "list", "get", "events", "start", "approve", "retry", "skip", "evidence", "attach", "command", "setInputs", "pause", "resume", "abort", "cleanup", "reverse", "decommission", "sourceSession", "report", "reportMarkdown"];

describe("MigrationRunsController (HTTP level: auth, scopes and validation in front of the facade)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const stub: Record<string, jest.Mock> = Object.fromEntries(FACADE_METHODS.map((m) => [m, jest.fn().mockResolvedValue({ id: "r1" })]));
  stub.reportMarkdown.mockResolvedValue("# r\n");

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [MigrationRunsController],
      providers: [
        { provide: MIGRATION_RUNS_FACADE, useValue: stub },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: () => "x" } },
        Reflector,
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useClass(FakeAuthGuard)
      .compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });
  afterAll(async () => app.close());

  const api = (scopes: string) => ({
    get: (u: string) => request(baseUrl).get(`/api/v1${u}`).set("x-test-scopes", scopes),
    post: (u: string) => request(baseUrl).post(`/api/v1${u}`).set("x-test-scopes", scopes),
  });

  type Route = { label: string; call: (s: string) => request.Test; need: string[] };
  const create = { sessionId: "s1", sourceKind: "coolify", targetServerId: "srv1", planHash: H32 };
  const routes: Route[] = [
    { label: "POST /migration-runs", call: (s) => api(s).post("/migration-runs").send(create), need: ["deploy", "read:secrets"] },
    { label: "GET /migration-runs", call: (s) => api(s).get("/migration-runs"), need: ["read"] },
    { label: "GET /migration-runs/:id", call: (s) => api(s).get("/migration-runs/r1"), need: ["read"] },
    { label: "GET /:id/events", call: (s) => api(s).get("/migration-runs/r1/events?afterSeq=3"), need: ["read"] },
    { label: "GET /:id/report", call: (s) => api(s).get("/migration-runs/r1/report"), need: ["read"] },
    { label: "GET /:id/report?format=md", call: (s) => api(s).get("/migration-runs/r1/report?format=md"), need: ["read"] },
    { label: "POST /:id/start", call: (s) => api(s).post("/migration-runs/r1/start").send({}), need: ["deploy"] },
    { label: "POST /:id/steps/:key/approve", call: (s) => api(s).post("/migration-runs/r1/steps/CUTOVER/approve").send({ boundHash: H64 }), need: ["deploy"] },
    { label: "POST /:id/steps/:key/retry", call: (s) => api(s).post("/migration-runs/r1/steps/IMPORT/retry").send({}), need: ["deploy"] },
    { label: "POST /:id/steps/:key/skip", call: (s) => api(s).post("/migration-runs/r1/steps/DATA_SEED/skip").send({}), need: ["deploy"] },
    { label: "POST /:id/steps/:key/evidence", call: (s) => api(s).post("/migration-runs/r1/steps/FREEZE/evidence").send({ checkId: "c1" }), need: ["deploy"] },
    { label: "POST /:id/steps/:key/attach", call: (s) => api(s).post("/migration-runs/r1/steps/DATA_SEED/attach").send({ kind: "object-migration", resourceId: "om1" }), need: ["deploy"] },
    { label: "POST /:id/steps/:key/command", call: (s) => api(s).post("/migration-runs/r1/steps/DATA_FINAL/command").send({}), need: ["deploy", "read:secrets"] },
    { label: "POST /:id/inputs", call: (s) => api(s).post("/migration-runs/r1/inputs").send({ allowBind: true }), need: ["deploy"] },
    { label: "POST /:id/pause", call: (s) => api(s).post("/migration-runs/r1/pause").send({}), need: ["deploy"] },
    { label: "POST /:id/resume", call: (s) => api(s).post("/migration-runs/r1/resume").send({}), need: ["deploy"] },
    { label: "POST /:id/abort", call: (s) => api(s).post("/migration-runs/r1/abort").send({ confirmName: "r1" }), need: ["deploy"] },
    { label: "POST /:id/cleanup", call: (s) => api(s).post("/migration-runs/r1/cleanup").send({ confirmName: "r1" }), need: ["admin"] },
    { label: "POST /:id/reverse", call: (s) => api(s).post("/migration-runs/r1/reverse").send({ confirmName: "r1", acknowledgeDataLoss: true }), need: ["admin"] },
    { label: "POST /:id/decommission", call: (s) => api(s).post("/migration-runs/r1/decommission").send({ confirmName: "coolify.example.com" }), need: ["admin"] },
    { label: "POST /:id/source-session", call: (s) => api(s).post("/migration-runs/r1/source-session").send({ token: "t" }), need: ["deploy", "read:secrets"] },
  ];

  it("defines the full design surface (21 route variants incl. both report formats)", () => {
    expect(routes).toHaveLength(21);
  });

  it.each(routes)("reaches the facade behind a valid, sufficiently scoped request: $label", async ({ call, need }) => {
    for (const ok of [need.join(","), "admin", "*"]) {
      const res = await call(ok);
      expect([200, 201, 202]).toContain(res.status);
    }
  }, 20000);

  it.each(routes.filter((r) => r.need.some((s) => s !== "read")))("scope matrix, insufficient scope is 403: $label", async ({ call, need }) => {
    // a token holding only `read` never satisfies a deploy/admin route; a deploy token never satisfies read:secrets or admin routes
    expect((await call("read")).status).toBe(403);
    if (need.includes("read:secrets") || need.includes("admin")) expect((await call("deploy")).status).toBe(403);
    if (need.includes("admin")) expect((await call("deploy,read:secrets")).status).toBe(403);
  }, 20000);

  it("validation runs before the facade: bad bodies are 400, never a facade call", async () => {
    Object.values(stub).forEach((f) => f.mockClear());
    const a = api("*");
    expect((await a.post("/migration-runs").send({ ...create, topology: "side-by-side" })).status).toBe(400);
    expect((await a.post("/migration-runs").send({ ...create, planHash: "x" })).status).toBe(400);
    expect((await a.post("/migration-runs").send({ ...create, token: "leak" })).status).toBe(400);
    expect((await a.post("/migration-runs/r1/steps/NOPE/approve").send({ boundHash: H64 })).status).toBe(400);
    expect((await a.post("/migration-runs/r1/steps/CUTOVER/approve").send({ boundHash: "x" })).status).toBe(400);
    expect((await a.post("/migration-runs/r1/reverse").send({ confirmName: "r1" })).status).toBe(400);
    expect((await a.post("/migration-runs/r1/abort").send({})).status).toBe(400);
    expect((await a.post("/migration-runs/r1/inputs").send({})).status).toBe(400);
    expect((await a.get("/migration-runs/r1/events?afterSeq=-2")).status).toBe(400);
    expect((await a.get("/migration-runs/r1/report?format=pdf")).status).toBe(400);
    for (const f of Object.values(stub)) expect(f).not.toHaveBeenCalled();
  });

  it("accepts every one of the 14 step keys in the step routes", async () => {
    for (const k of STEP_KEYS) expect((await api("*").post(`/migration-runs/r1/steps/${k}/retry`).send({})).status).toBe(200);
  }, 20000);
});

describe("MigrationRunsController maps the caller to a RunActor and forwards the parsed request", () => {
  let app: INestApplication;
  let baseUrl: string;
  const facade: Record<string, jest.Mock> = {};
  for (const m of FACADE_METHODS) facade[m] = jest.fn();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [MigrationRunsController],
      providers: [
        { provide: MIGRATION_RUNS_FACADE, useValue: facade },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: ConfigService, useValue: { get: () => "x" } },
        Reflector,
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useClass(FakeAuthGuard)
      .compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  });
  afterAll(async () => app.close());
  beforeEach(() => Object.values(facade).forEach((f) => f.mockReset()));

  it("a session is channel session, a PAT is channel pat", async () => {
    facade.get.mockResolvedValue({ id: "r1" });
    await request(baseUrl).get("/api/v1/migration-runs/r1").set("x-test-scopes", "*").expect(200);
    await request(baseUrl).get("/api/v1/migration-runs/r1").set("x-test-scopes", "read").set("x-test-pat", "1").expect(200);
    expect(facade.get.mock.calls[0][0]).toEqual({ userId: "u1", scopes: ["*"], channel: "session" });
    expect(facade.get.mock.calls[1][0]).toEqual({ userId: "u1", scopes: ["read"], channel: "pat" });
    expect(facade.get.mock.calls[0][1]).toBe("r1");
  });

  it("create is 201 and receives the parsed body with defaults applied", async () => {
    facade.create.mockResolvedValue({ id: "r1" });
    const res = await request(baseUrl).post("/api/v1/migration-runs").set("x-test-scopes", "*").send({ sessionId: "s1", sourceKind: "coolify", targetServerId: "srv1", planHash: H32, dryRun: true });
    expect(res.status).toBe(201);
    const body = facade.create.mock.calls[0][1];
    expect(body).toMatchObject({ mode: "copy", topology: "two-box", dryRun: true, inputs: {} });
    expect(body.options.observeMinutes).toBe(30);
  });

  it("async actions answer 202, the rest 200", async () => {
    for (const m of ["abort", "cleanup", "reverse", "decommission"]) facade[m].mockResolvedValue({ id: "r1" });
    const a = (u: string, b: object) => request(baseUrl).post(`/api/v1/migration-runs/r1/${u}`).set("x-test-scopes", "*").send(b);
    expect((await a("abort", { confirmName: "r1" })).status).toBe(202);
    expect((await a("cleanup", { confirmName: "r1" })).status).toBe(202);
    expect((await a("reverse", { confirmName: "r1", acknowledgeDataLoss: true })).status).toBe(202);
    expect((await a("decommission", { confirmName: "h" })).status).toBe(202);
  });

  it("the step key is parsed into a StepKey before the facade sees it", async () => {
    facade.approve.mockResolvedValue({ id: "r1" });
    await request(baseUrl).post("/api/v1/migration-runs/r1/steps/CUTOVER/approve").set("x-test-scopes", "*").send({ boundHash: H64, confirmName: "srv" }).expect(200);
    const [, id, key, body] = facade.approve.mock.calls[0];
    expect([id, key]).toEqual(["r1", "CUTOVER"]);
    expect(body).toEqual({ boundHash: H64, confirmName: "srv", acks: [] });
  });

  it("the command route passes the request's public hub base", async () => {
    facade.command.mockResolvedValue({ shownOnce: true });
    await request(baseUrl).post("/api/v1/migration-runs/r1/steps/DATA_FINAL/command").set("x-test-scopes", "*").set("x-forwarded-host", "hub.example.com").set("x-forwarded-proto", "https").send({}).expect(200);
    expect(facade.command.mock.calls[0][4]).toMatch(/^https?:\/\//);
  });

  it("report serves markdown as text/markdown and JSON by default", async () => {
    facade.reportMarkdown.mockResolvedValue("# Report\n");
    facade.report.mockResolvedValue({ runId: "r1" });
    const md = await request(baseUrl).get("/api/v1/migration-runs/r1/report?format=md").set("x-test-scopes", "*");
    expect(md.status).toBe(200);
    expect(md.headers["content-type"]).toMatch(/^text\/markdown/);
    expect(md.text).toBe("# Report\n");
    const js = await request(baseUrl).get("/api/v1/migration-runs/r1/report").set("x-test-scopes", "*");
    expect(js.body).toEqual({ runId: "r1" });
    expect(facade.report).toHaveBeenCalledTimes(1);
  });
});


describe("module wiring", () => {
  // The real step modules need the whole app (Prisma, metrics, importer); their wiring is covered by the e2e boot.
  it("the global registry is injectable on its own and starts empty", async () => {
    const mod = await Test.createTestingModule({ imports: [StepRegistryModule] }).compile();
    const reg = mod.get<StepHandlerRegistry>(STEP_HANDLERS);
    expect(reg).toBeInstanceOf(StepHandlerRegistryService);
    expect(reg.list()).toEqual([]);
    expect(reg.missing("copy")).toHaveLength(13);
  });
  it("MigrationRunsModule declares the controller, binds the real facade and imports the three step modules", () => {
    expect(Reflect.getMetadata("controllers", MigrationRunsModule)).toEqual([MigrationRunsController]);
    const imports = Reflect.getMetadata("imports", MigrationRunsModule) as unknown[];
    for (const m of [StepRegistryModule, RunImportStepsModule, RunDataStepsModule, RunCutoverStepsModule]) expect(imports).toContain(m);
    const providers = Reflect.getMetadata("providers", MigrationRunsModule) as Array<{ provide?: unknown }>;
    expect(providers.some((p) => p.provide === MIGRATION_RUNS_FACADE)).toBe(true);
    expect(Reflect.getMetadata("path", MigrationRunsController)).toBe("migration-runs");
  });
});
