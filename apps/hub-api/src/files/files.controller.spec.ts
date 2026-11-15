import { CanActivate, ExecutionContext, INestApplication, Injectable, NotFoundException } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { IncomingMessage, ServerResponse } from "node:http";
import request from "supertest";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { configureApp } from "../app-config";
import { ApiExceptionFilter } from "../common/api-exception.filter";
import { CSRF_EXEMPT } from "../common/csrf-exempt.decorator";
import { CsrfGuard } from "../common/csrf.guard";
import { AgentFsTransferController } from "./agent-fs-transfer.controller";
import { ContainerFilesController } from "./container-files.controller";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";
import { FsPolicyException, FsRateLimitedException, FsRemoteException } from "./fs-errors";
import { FsTransferService } from "./fs-transfer.service";

/** Stands in for ApiAuthGuard: the scopes under test arrive in a header (the real ScopesGuard still runs). */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const raw = String(req.headers["x-test-scopes"] ?? "*");
    req.user = { userId: "u1", scopes: raw === "" ? [] : raw.split(",") };
    return true;
  }
}

const stat = { name: "f", type: "file", size: 1, mode: "0644", mtime: 1, mtimeNs: 1, uid: 0, gid: 0, etag: "1-1" };

describe("file manager controllers (HTTP level)", () => {
  let app: INestApplication;
  const files = {
    meta: jest.fn(), stat: jest.fn(), download: jest.fn(), upload: jest.fn(), mkdir: jest.fn(),
    rename: jest.fn(), chmod: jest.fn(), remove: jest.fn(), listContainer: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [FilesController, ContainerFilesController, AgentFsTransferController],
      providers: [
        { provide: FilesService, useValue: files },
        // plain functions (not jest.fn): beforeEach's resetAllMocks must not wipe them. Every bad credential is the uniform 404.
        { provide: FsTransferService, useValue: { serveToAgent: () => { throw new NotFoundException(); }, receiveFromAgent: async () => { throw new NotFoundException(); } } },
        { provide: APP_GUARD, useClass: CsrfGuard },
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
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    files.meta.mockResolvedValue({ ok: true });
    files.stat.mockResolvedValue(stat);
    files.mkdir.mockResolvedValue(stat);
    files.rename.mockResolvedValue(stat);
    files.chmod.mockResolvedValue(stat);
    files.remove.mockResolvedValue(undefined);
    files.listContainer.mockResolvedValue({ entries: [], truncated: false });
    files.upload.mockResolvedValue({ created: true, body: { path: "f", bytes: 1, sha256: "x", etag: "1-1" } });
    files.download.mockImplementation(async (_u: string, _a: string, _t: unknown, _p: string, res: ServerResponse) => {
      res.setHeader("Content-Length", "2");
      res.end("ok");
    });
  });

  const api = (scopes: string) => ({
    get: (u: string) => request(app.getHttpServer()).get(`/api/v1${u}`).set("x-test-scopes", scopes),
    put: (u: string) => request(app.getHttpServer()).put(`/api/v1${u}`).set("x-test-scopes", scopes),
    post: (u: string) => request(app.getHttpServer()).post(`/api/v1${u}`).set("x-test-scopes", scopes),
    del: (u: string) => request(app.getHttpServer()).delete(`/api/v1${u}`).set("x-test-scopes", scopes),
  });

  // route table: [label, method, url, body?, required scopes]
  type Route = { label: string; call: (s: string) => request.Test; need: string[]; okStatus: number };
  const routes: Route[] = [
    { label: "GET files/meta", call: (s) => api(s).get("/apps/a1/files/meta"), need: ["read:secrets"], okStatus: 200 },
    { label: "GET files/stat", call: (s) => api(s).get("/apps/a1/files/stat?volume=data&path=x"), need: ["read:secrets"], okStatus: 200 },
    { label: "GET files/content", call: (s) => api(s).get("/apps/a1/files/content?volume=data&path=x"), need: ["read:secrets"], okStatus: 200 },
    { label: "PUT files/content", call: (s) => api(s).put("/apps/a1/files/content?volume=data&path=x").set("content-type", "application/octet-stream").send(Buffer.from("x")), need: ["write", "read:secrets"], okStatus: 201 },
    { label: "POST files/mkdir", call: (s) => api(s).post("/apps/a1/files/mkdir").send({ volume: "data", path: "d" }), need: ["write", "read:secrets"], okStatus: 201 },
    { label: "POST files/rename", call: (s) => api(s).post("/apps/a1/files/rename").send({ volume: "data", from: "a", to: "b" }), need: ["write", "read:secrets"], okStatus: 200 },
    { label: "POST files/chmod", call: (s) => api(s).post("/apps/a1/files/chmod").send({ volume: "data", path: "a", mode: "0644" }), need: ["write", "read:secrets"], okStatus: 200 },
    { label: "DELETE files", call: (s) => api(s).del("/apps/a1/files?volume=data&path=x"), need: ["admin"], okStatus: 204 },
    { label: "GET container-files (list)", call: (s) => api(s).get("/apps/a1/container-files?path=/app"), need: ["read:secrets"], okStatus: 200 },
    { label: "GET container-files/stat", call: (s) => api(s).get("/apps/a1/container-files/stat?path=/app/x"), need: ["read:secrets"], okStatus: 200 },
    { label: "GET container-files/content", call: (s) => api(s).get("/apps/a1/container-files/content?path=/app/x"), need: ["read:secrets"], okStatus: 200 },
    { label: "PUT container-files/content", call: (s) => api(s).put("/apps/a1/container-files/content?path=/app/x").set("content-type", "application/octet-stream").send(Buffer.from("x")), need: ["admin"], okStatus: 201 },
    { label: "POST container-files/mkdir", call: (s) => api(s).post("/apps/a1/container-files/mkdir").send({ path: "/app/d" }), need: ["admin"], okStatus: 201 },
    { label: "POST container-files/rename", call: (s) => api(s).post("/apps/a1/container-files/rename").send({ from: "/app/a", to: "/app/b" }), need: ["admin"], okStatus: 200 },
    { label: "POST container-files/chmod", call: (s) => api(s).post("/apps/a1/container-files/chmod").send({ path: "/app/a", mode: "0644" }), need: ["admin"], okStatus: 200 },
    { label: "DELETE container-files", call: (s) => api(s).del("/apps/a1/container-files?path=/app/x"), need: ["admin"], okStatus: 204 },
  ];

  it.each(routes)("scope matrix: $label", async ({ call, need, okStatus }) => {
    // satisfied by exactly its required set, by admin, and by a session (*)
    for (const ok of [need.join(","), "admin", "*"]) {
      const r = await call(ok);
      expect({ scopes: ok, status: r.status }).toEqual({ scopes: ok, status: okStatus });
    }
    // denied: no scopes, read-only, and every proper subset of its required set
    const denied = ["", "read", ...(need.length > 1 ? need.map((_, i) => need.filter((__, j) => j !== i).join(",")) : [])];
    // a write PAT without read:secrets, and a read:secrets PAT without write, are both locked out of volume writes
    if (need.includes("write")) denied.push("write", "read:secrets");
    if (need.length === 1 && need[0] === "admin") denied.push("write", "read:secrets", "write,read:secrets", "deploy");
    for (const bad of denied) {
      const r = await call(bad);
      expect({ scopes: bad, status: r.status }).toEqual({ scopes: bad, status: 403 });
    }
    expect(files.remove.mock.calls.length + files.upload.mock.calls.length + files.mkdir.mock.calls.length).toBeLessThanOrEqual(3); // only the 3 allowed calls ever reached the service
  });

  it("declares the scope matrix explicitly on every route (never the method default)", () => {
    for (const [ctrl, methods] of [
      [FilesController, ["meta", "stat", "download", "upload", "mkdir", "rename", "chmod", "remove"]],
      [ContainerFilesController, ["list", "stat", "download", "upload", "mkdir", "rename", "chmod", "remove"]],
    ] as const) {
      for (const m of methods) {
        expect(Reflect.getMetadata(REQUIRE_SCOPES, (ctrl.prototype as unknown as Record<string, object>)[m])).toBeDefined();
      }
    }
    expect(Reflect.getMetadata(REQUIRE_SCOPES, FilesController.prototype.remove)).toEqual(["admin"]);
    expect(Reflect.getMetadata(REQUIRE_SCOPES, FilesController.prototype.upload)).toEqual(["write", "read:secrets"]);
    for (const m of ["upload", "mkdir", "rename", "chmod", "remove"] as const) {
      expect(Reflect.getMetadata(REQUIRE_SCOPES, ContainerFilesController.prototype[m])).toEqual(["admin"]);
    }
  });

  it("validates input strictly: setuid modes, ifMatch shape, unknown keys, traversal, missing volume", async () => {
    const s = "*";
    expect((await api(s).post("/apps/a1/files/chmod").send({ volume: "data", path: "a", mode: "4755" })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/chmod").send({ volume: "data", path: "a", mode: "0o644" })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/mkdir").send({ volume: "data", path: "a", mode: "1777" })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/mkdir").send({ volume: "data", path: "a", extra: 1 })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/mkdir").send({ volume: "data", container: "c", path: "a" })).status).toBe(400); // volume xor container
    expect((await api(s).post("/apps/a1/files/mkdir").send({ path: "a" })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/mkdir").send({ volume: "../x", path: "a" })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/rename").send({ volume: "data", from: "../a", to: "b" })).status).toBe(400);
    expect((await api(s).post("/apps/a1/files/rename").send({ volume: "data", from: "a", to: "/abs" })).status).toBe(400);
    expect((await api(s).get("/apps/a1/files/stat?volume=data&path=a//b")).status).toBe(400);
    expect((await api(s).get("/apps/a1/files/stat?path=a")).status).toBe(400);
    expect((await api(s).put("/apps/a1/files/content?volume=data&path=a&ifMatch=nope").send(Buffer.from("x"))).status).toBe(400);
    expect((await api(s).put("/apps/a1/files/content?volume=data&path=a&overwrite=yes").send(Buffer.from("x"))).status).toBe(400);
    expect((await api(s).put("/apps/a1/files/content?volume=data&path=.tugra-part-x").send(Buffer.from("x"))).status).toBe(400);
    expect((await api(s).del("/apps/a1/files?volume=data&path=a&recursive=true")).status).toBe(400); // flags are "0"|"1"
    // container routes: absolute clean paths only, no acknowledgeRisk key, root immutable
    expect((await api(s).get("/apps/a1/container-files/stat?path=app")).status).toBe(400);
    expect((await api(s).get("/apps/a1/container-files?path=/proc")).status).toBe(400);
    expect((await api(s).post("/apps/a1/container-files/mkdir").send({ path: "/", acknowledgeRisk: true })).status).toBe(400);
    expect((await api(s).del("/apps/a1/container-files?path=/")).status).toBe(400);
    expect((await api(s).del("/apps/a1/container-files?path=/app/x&acknowledgeRisk=1")).status).toBe(400);
    expect(files.mkdir).not.toHaveBeenCalled();
    expect(files.chmod).not.toHaveBeenCalled();
  });

  it("maps validated input onto the service: targets, flags and defaults", async () => {
    await api("*").get("/apps/a1/files/stat?volume=data").expect(200);
    expect(files.stat).toHaveBeenLastCalledWith("u1", "a1", { volume: "data" }, "");
    await api("*").del("/apps/a1/files?volume=data&path=d&recursive=1&acknowledgeRisk=1").expect(204);
    expect(files.remove).toHaveBeenLastCalledWith("u1", "a1", { volume: "data" }, expect.objectContaining({ path: "d", recursive: true, acknowledgeRisk: true }));
    await api("*").del("/apps/a1/files?volume=data&path=d").expect(204);
    expect(files.remove).toHaveBeenLastCalledWith("u1", "a1", { volume: "data" }, expect.objectContaining({ recursive: false, acknowledgeRisk: false }));
    await api("*").get("/apps/a1/container-files").expect(200);
    expect(files.listContainer).toHaveBeenLastCalledWith("u1", "a1", { container: "" }, "/");
    await api("*").get("/apps/a1/container-files?container=tugra_a1-web-1&path=/etc").expect(200);
    expect(files.listContainer).toHaveBeenLastCalledWith("u1", "a1", { container: "tugra_a1-web-1" }, "/etc");
    await api("*").post("/apps/a1/files/mkdir").send({ volume: "data", path: "a/b", parents: true, mode: "0755" }).expect(201);
    expect(files.mkdir).toHaveBeenLastCalledWith("u1", "a1", { volume: "data" }, expect.objectContaining({ path: "a/b", parents: true, mode: "0755" }));
  });

  it("PUT content: the body reaches the service as an UNREAD raw stream (the body parser leaves octet-stream alone)", async () => {
    let seen = 0;
    let readBeforeHandler = false;
    files.upload.mockImplementation(async (_u: string, _a: string, _t: unknown, _q: unknown, req: IncomingMessage) => {
      readBeforeHandler = req.readableDidRead === true;
      for await (const c of req) seen += (c as Buffer).length;
      return { created: false, body: { path: "big", bytes: seen, sha256: "x", etag: "e" } };
    });
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const r = await api("*").put("/apps/a1/files/content?volume=data&path=big&overwrite=1").set("content-type", "application/octet-stream").send(big);
    expect(readBeforeHandler).toBe(false);
    expect(seen).toBe(big.length);
    expect(r.status).toBe(200); // created:false => 200 (replaced)
    expect(r.body).toEqual({ path: "big", bytes: big.length, sha256: "x", etag: "e" });
    expect(files.upload).toHaveBeenLastCalledWith("u1", "a1", { volume: "data" }, expect.objectContaining({ path: "big", overwrite: true }), expect.anything());
    // created:true => 201
    files.upload.mockResolvedValueOnce({ created: true, body: { path: "n", bytes: 1, sha256: "x", etag: "e" } });
    expect((await api("*").put("/apps/a1/files/content?volume=data&path=n").set("content-type", "application/octet-stream").send(Buffer.from("x"))).status).toBe(201);
  });

  it("surfaces typed errors with their machine code, and the limiter's wait as Retry-After", async () => {
    files.mkdir.mockRejectedValueOnce(new FsRemoteException("exists", "already exists"));
    const r1 = await api("*").post("/apps/a1/files/mkdir").send({ volume: "data", path: "d" });
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ statusCode: 409, code: "exists", message: "already exists" });
    files.mkdir.mockRejectedValueOnce(new FsPolicyException(409, "datastore_running", "risky"));
    expect((await api("*").post("/apps/a1/files/mkdir").send({ volume: "data", path: "d" })).body).toMatchObject({ code: "datastore_running" });
    files.remove.mockRejectedValueOnce(new FsRateLimitedException(17));
    const r2 = await api("*").del("/apps/a1/files?volume=data&path=d");
    expect(r2.status).toBe(429);
    expect(r2.headers["retry-after"]).toBe("17");
    expect(r2.body).toMatchObject({ code: "rate_limited" });
    files.upload.mockRejectedValueOnce(new FsRateLimitedException(5));
    const r3 = await api("*").put("/apps/a1/files/content?volume=data&path=d").set("content-type", "application/octet-stream").send(Buffer.from("x"));
    expect(r3.headers["retry-after"]).toBe("5");
  });

  it("GET content hands the raw response to the service (download relay)", async () => {
    const r = await api("*").get("/apps/a1/container-files/content?container=tugra_a1&path=/app/x");
    expect(r.status).toBe(200);
    expect(r.text).toBe("ok");
    expect(files.download).toHaveBeenLastCalledWith("u1", "a1", { container: "tugra_a1" }, "/app/x", expect.anything());
    files.download.mockRejectedValueOnce(new FsRemoteException("is_dir", "only regular files can be downloaded"));
    const e = await api("*").get("/apps/a1/files/content?volume=data&path=d");
    expect(e.status).toBe(409);
    expect(e.body).toMatchObject({ code: "is_dir" });
  });

  it("CSRF: cookie-authenticated mutations need the double-submit token; bearer callers and reads do not; the agent URLs are exempt", async () => {
    const cookie = "tg_access=a; tg_csrf=tok";
    const base = (m: "post" | "put" | "delete", u: string) => request(app.getHttpServer())[m](`/api/v1${u}`).set("x-test-scopes", "*").set("Cookie", cookie);
    expect((await base("post", "/apps/a1/files/mkdir").send({ volume: "data", path: "d" })).status).toBe(403);
    expect((await base("put", "/apps/a1/files/content?volume=data&path=d").set("content-type", "application/octet-stream").send(Buffer.from("x"))).status).toBe(403);
    expect((await base("delete", "/apps/a1/files?volume=data&path=d")).status).toBe(403);
    expect((await base("post", "/apps/a1/container-files/mkdir").send({ path: "/app/d" })).status).toBe(403);
    expect((await base("post", "/apps/a1/files/mkdir").set("x-csrf-token", "tok").send({ volume: "data", path: "d" })).status).toBe(201);
    expect((await base("post", "/apps/a1/files/mkdir").set("x-csrf-token", "wrong").send({ volume: "data", path: "d" })).status).toBe(403);
    expect((await request(app.getHttpServer()).post("/api/v1/apps/a1/files/mkdir").set("Authorization", "Bearer tugra_pat_x").set("x-test-scopes", "*").send({ volume: "data", path: "d" })).status).toBe(201);
    expect((await request(app.getHttpServer()).get("/api/v1/apps/a1/files/meta").set("Cookie", cookie)).status).toBe(200);
    // exempt metadata: only the agent transfer controller opts out of CSRF
    expect(Reflect.getMetadata(CSRF_EXEMPT, AgentFsTransferController)).toBe(true);
    expect(Reflect.getMetadata(CSRF_EXEMPT, FilesController)).toBeUndefined();
    expect(Reflect.getMetadata(CSRF_EXEMPT, ContainerFilesController)).toBeUndefined();
    const agentPut = await request(app.getHttpServer()).put("/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB").set("Cookie", cookie).send(Buffer.from("x"));
    expect(agentPut.status).toBe(404); // not 403: the cookie-CSRF gate does not apply; the HMAC does
  });

  it("agent transfer URLs are open to the agent (no user auth) and uniformly 404 on a bad credential", async () => {
    const g = await request(app.getHttpServer()).get("/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(g.status).toBe(404);
    const p = await request(app.getHttpServer()).put("/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB").send(Buffer.from("x"));
    expect(p.status).toBe(404);
  });
});
