import { BadRequestException, ConflictException, ForbiddenException, HttpException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { FsPolicyException, FsRateLimitedException, FsRemoteException } from "./fs-errors";
import { FileOpLimiter } from "./fs-limiter";
import { FsTransferService } from "./fs-transfer.service";
import { FilesService, fsAuditAction, transferTimeoutMs } from "./files.service";

const SECRET = "test-secret-0123456789";

function parts(p: string): { id: string; exp: string; sig: string } {
  const m = /^\/api\/v1\/agent-fs\/t\/([A-Za-z0-9_-]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)$/.exec(p);
  if (!m) throw new Error(`unexpected xfer path ${p}`);
  return { id: m[1], exp: m[2], sig: m[3] };
}

class FakeRes extends Writable {
  headers: Record<string, string> = {};
  headersSent = false;
  chunks: Buffer[] = [];
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  removeHeader(k: string) {
    delete this.headers[k];
  }
  _write(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null) => void) {
    this.headersSent = true;
    this.chunks.push(chunk);
    cb();
  }
  body() {
    return Buffer.concat(this.chunks).toString();
  }
}

function uploadReq(body: string | Readable, contentLength?: number | string): IncomingMessage {
  const r = (typeof body === "string" ? Readable.from([Buffer.from(body)]) : body) as Readable & { headers: Record<string, string> };
  r.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return r as unknown as IncomingMessage;
}

function agentPut(body: string[] | Readable, contentLength?: number): IncomingMessage {
  const r = (Array.isArray(body) ? Readable.from(body.map((s) => Buffer.from(s))) : body) as Readable & { headers: Record<string, string> };
  r.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return r as unknown as IncomingMessage;
}

interface Opts {
  scope?: "volume" | "container";
  app?: Record<string, unknown>;
}

describe("FilesService", () => {
  let dir: string;
  const saved = { ...process.env };
  const events: string[] = [];
  let transfers: FsTransferService;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "files-svc-"));
    process.env.FILES_STAGING_DIR = dir;
    events.length = 0;
    transfers = new FsTransferService({ get: () => SECRET } as unknown as ConfigService);
  });
  afterEach(async () => {
    transfers.onModuleDestroy();
    process.env = { ...saved };
    await rm(dir, { recursive: true, force: true });
  });

  function build(o: Opts = {}) {
    const app: Record<string, unknown> = { id: "app1", status: "RUNNING", source: "IMAGE", image: "nginx", ...o.app };
    const scope = o.scope ?? "volume";
    const apps = {
      resolveFsTarget: jest.fn(async () => {
        events.push("resolve");
        return { app, serverId: "s1", scope, subject: scope === "volume" ? "tugra_appv_app1_data" : "tugra_app1" };
      }),
      fsContext: jest.fn(),
    };
    const agentWs = {
      assertFs2Ready: jest.fn(async (..._a: unknown[]) => {
        events.push("ready");
        return [];
      }),
      sendFs2: jest.fn(async (..._a: unknown[]) => {
        events.push("send");
        return { type: "fs2_result", reqId: "r", ok: true, stat: { name: "x", type: "file", size: 3, etag: "3-9" } };
      }),
      reserveFs2: jest.fn((..._a: unknown[]) => {
        events.push("reserve");
        return jest.fn();
      }),
      isOnline: jest.fn().mockReturnValue(true),
      agentSupports: jest.fn().mockReturnValue(true),
      isCapabilityGranted: jest.fn().mockResolvedValue(true),
    };
    const audit = { log: jest.fn(async (e: { action: string; meta?: Record<string, unknown> }) => void events.push(`audit:${e.action}`)) };
    const limiter = new FileOpLimiter(1000, 60_000);
    const take = jest.spyOn(limiter, "take").mockImplementation(() => void events.push("limit"));
    const svc = new FilesService(apps as never, agentWs as never, audit as never, transfers, limiter);
    return { svc, apps, agentWs, audit, limiter, take, app };
  }

  // ── the mutation pipeline ───────────────────────────────────────────────────────────────────────────────────

  it("runs resolve -> ready -> limiter -> write-ahead audit -> dispatch, in that order", async () => {
    const { svc } = build();
    await svc.mkdir("u1", "app1", { volume: "data" }, { path: "a/b", parents: true });
    expect(events).toEqual(["resolve", "ready", "limit", "audit:app.file.mkdir", "send"]);
  });

  it("an audit failure ABORTS the operation (nothing is dispatched)", async () => {
    const { svc, audit, agentWs } = build();
    audit.log.mockRejectedValueOnce(new Error("audit store down"));
    await expect(svc.remove("u1", "app1", { volume: "data" }, { path: "x" })).rejects.toThrow("audit store down");
    expect(agentWs.sendFs2).not.toHaveBeenCalled();
  });

  it("audits mutations with the path and shape but never content, and writes an app.file.failed row on failure", async () => {
    const { svc, audit, agentWs } = build();
    await svc.chmod("u1", "app1", { volume: "data" }, { path: "f.txt", mode: "0600" });
    expect(audit.log).toHaveBeenLastCalledWith({
      actor: "u1", action: "app.file.chmod", target: "app1",
      meta: { scope: "volume", subject: "tugra_appv_app1_data", path: "f.txt", mode: "0600", flags: "" },
    });
    agentWs.sendFs2.mockRejectedValueOnce(new FsRemoteException("exists", "already exists"));
    await expect(svc.rename("u1", "app1", { volume: "data" }, { from: "a", to: "b" })).rejects.toBeInstanceOf(FsRemoteException);
    expect(audit.log).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: "app.file.rename", meta: expect.objectContaining({ path: "a", path2: "b" }) }));
    expect(audit.log).toHaveBeenLastCalledWith({ actor: "u1", action: "app.file.failed", target: "app1", meta: { op: "rename", scope: "volume", code: "exists" } });
  });

  it("a failing failure-audit never masks the real error", async () => {
    const { svc, audit, agentWs } = build();
    agentWs.sendFs2.mockRejectedValueOnce(new FsRemoteException("denied", "nope"));
    audit.log.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit down"));
    await expect(svc.remove("u1", "app1", { volume: "data" }, { path: "x" })).rejects.toBeInstanceOf(FsRemoteException);
  });

  it("names container-scope audit actions app.container_fs.<op>", () => {
    expect(fsAuditAction("volume", "write")).toBe("app.file.write");
    expect(fsAuditAction("volume", "read")).toBe("app.file.download");
    expect(fsAuditAction("container", "delete")).toBe("app.container_fs.delete");
    expect(fsAuditAction("container", "read")).toBe("app.container_fs.download");
  });

  it("refuses before the limiter and audit when the agent is offline / too old / missing a capability", async () => {
    const { svc, agentWs, audit, take } = build();
    for (const err of [new AgentOfflineException(), new HttpException({ statusCode: 409, code: "agent_too_old" }, 409), new ForbiddenException({ code: "capability_not_granted" })]) {
      agentWs.assertFs2Ready.mockRejectedValueOnce(err);
      await expect(svc.mkdir("u1", "app1", { volume: "data" }, { path: "d" })).rejects.toBe(err);
    }
    expect(take).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(agentWs.sendFs2).not.toHaveBeenCalled();
  });

  it("is rate limited per user (429 + retryAfterSec) before any audit or dispatch", async () => {
    const { svc, take, audit, agentWs } = build();
    take.mockImplementationOnce(() => {
      throw new FsRateLimitedException(12);
    });
    const err = await svc.remove("u1", "app1", { volume: "data" }, { path: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsRateLimitedException);
    expect((err as FsRateLimitedException).getStatus()).toBe(429);
    expect((err as FsRateLimitedException).retryAfterSec).toBe(12);
    expect(audit.log).not.toHaveBeenCalled();
    expect(agentWs.sendFs2).not.toHaveBeenCalled();
  });

  it("validates paths at the service too (volume: relative strict; container: absolute clean, root immutable)", async () => {
    const v = build();
    for (const bad of ["../x", "/abs", "a//b", "a\nb", ".tugra-part-x", ""]) {
      await expect(v.svc.remove("u1", "app1", { volume: "data" }, { path: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(v.agentWs.sendFs2).not.toHaveBeenCalled();
    const c = build({ scope: "container" });
    for (const bad of ["rel", "/a/../b", "/proc/1", "/", "/dev/null"]) {
      await expect(c.svc.remove("u1", "app1", { container: "" }, { path: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(c.agentWs.sendFs2).not.toHaveBeenCalled();
  });

  // ── datastore guard ─────────────────────────────────────────────────────────────────────────────────────────

  it("blocks volume writes on a RUNNING datastore with 409 datastore_running unless acknowledged", async () => {
    const { svc, agentWs, audit } = build({ app: { image: "postgres:16" } });
    const err = await svc.mkdir("u1", "app1", { volume: "data" }, { path: "d" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsPolicyException);
    expect((err as FsPolicyException).getStatus()).toBe(409);
    expect((err as FsPolicyException).code).toBe("datastore_running");
    expect(agentWs.sendFs2).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    await svc.mkdir("u1", "app1", { volume: "data" }, { path: "d", acknowledgeRisk: true });
    expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ meta: expect.objectContaining({ acknowledgedRisk: true }) }));
  });

  it("the datastore guard is volume-only, RUNNING-only, and never blocks reads", async () => {
    const stopped = build({ app: { image: "postgres:16", status: "STOPPED" } });
    await expect(stopped.svc.mkdir("u1", "app1", { volume: "data" }, { path: "d" })).resolves.toBeDefined();
    const ctr = build({ scope: "container", app: { image: "postgres:16" } });
    await expect(ctr.svc.mkdir("u1", "app1", { container: "" }, { path: "/tmp/d" })).resolves.toBeDefined();
    const rd = build({ app: { image: "postgres:16" } });
    await expect(rd.svc.stat("u1", "app1", { volume: "data" }, "x")).resolves.toBeDefined();
    const plain = build({ app: { image: "nginx" } });
    await expect(plain.svc.remove("u1", "app1", { volume: "data" }, { path: "x" })).resolves.toBeUndefined();
  });

  // ── operation mapping ───────────────────────────────────────────────────────────────────────────────────────

  it("maps mkdir/rename/chmod/delete onto the signed fields and returns the agent's stat", async () => {
    const { svc, agentWs } = build();
    const sent = () => agentWs.sendFs2.mock.calls.at(-1) as unknown as [string, Record<string, unknown>, number];
    const base = { scope: "volume", subject: "tugra_appv_app1_data", path2: "", mode: "", flags: "", size: 0, sha256: "", ifMatch: "", xfer: "" };

    await expect(svc.mkdir("u1", "app1", { volume: "data" }, { path: "a/b", mode: "0750", parents: true })).resolves.toMatchObject({ name: "x" });
    expect(sent()).toEqual(["s1", { ...base, op: "mkdir", path: "a/b", mode: "0750", flags: "p" }, 30_000]);
    await svc.rename("u1", "app1", { volume: "data" }, { from: "a", to: "b" });
    expect(sent()).toEqual(["s1", { ...base, op: "rename", path: "a", path2: "b" }, 30_000]);
    await svc.chmod("u1", "app1", { volume: "data" }, { path: "a", mode: "0644" });
    expect(sent()).toEqual(["s1", { ...base, op: "chmod", path: "a", mode: "0644" }, 30_000]);
    await svc.remove("u1", "app1", { volume: "data" }, { path: "a" });
    expect(sent()).toEqual(["s1", { ...base, op: "delete", path: "a" }, 30_000]);
    await svc.remove("u1", "app1", { volume: "data" }, { path: "a", recursive: true });
    expect(sent()).toEqual(["s1", { ...base, op: "delete", path: "a", flags: "r" }, 5 * 60_000]);
  });

  it("stat resolves read-only, allows the root, and the container list uses the legacy entry shape", async () => {
    const { svc, agentWs, apps } = build();
    await svc.stat("u1", "app1", { volume: "data" }, "");
    expect(apps.resolveFsTarget).toHaveBeenLastCalledWith("u1", "app1", { volume: "data" }, { mutating: false });
    const c = build({ scope: "container" });
    c.agentWs.sendFs2.mockResolvedValueOnce({ type: "fs2_result", reqId: "r", ok: true, entries: [{ name: "a", type: "file", size: 1, mode: "rw-r--r--", mtime: 2 }], truncated: true } as never);
    await expect(c.svc.listContainer("u1", "app1", { container: "" }, "/app")).resolves.toEqual({ entries: [{ name: "a", type: "file", size: 1, mode: "rw-r--r--", mtime: 2 }], truncated: true });
    expect(c.agentWs.sendFs2.mock.calls[0][1]).toMatchObject({ op: "list", scope: "container", path: "/app" });
    expect(c.agentWs.sendFs2.mock.calls[0][2]).toBe(20_000);
    expect(agentWs.sendFs2).toHaveBeenCalledTimes(1);
  });

  it("scales the transfer timeout with size, clamped to [30s, 10min]", () => {
    expect(transferTimeoutMs(0)).toBe(30_000);
    expect(transferTimeoutMs(512 * 1024)).toBe(31_000);
    expect(transferTimeoutMs(100 * 1024 * 1024)).toBe(30_000 + 200_000);
    expect(transferTimeoutMs(10 * 1024 ** 3)).toBe(600_000);
  });

  // ── upload ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** A fake agent: pulls the staged body over the registered transfer exactly like the real one. */
  function fakeAgent(h: ReturnType<typeof build>, result: Record<string, unknown> = {}) {
    const pulled: { body?: string; req?: Record<string, unknown> } = {};
    h.agentWs.sendFs2.mockImplementation((async (_sid: string, req: Record<string, unknown>) => {
      events.push("send");
      pulled.req = req;
      const { id, exp, sig } = parts(req.xfer as string);
      const file = transfers.serveToAgent(id, exp, sig);
      const chunks: Buffer[] = [];
      for await (const c of file.getStream()) chunks.push(c as Buffer);
      pulled.body = Buffer.concat(chunks).toString();
      return { type: "fs2_result", reqId: "r", ok: true, created: true, bytes: Number(req.size), sha256: req.sha256, etag: "5-1", ...result };
    }) as never);
    return pulled;
  }

  it("stages the body (hub-computed sha256), signs a transfer, and the agent pulls exactly those bytes; staging is cleaned up", async () => {
    const h = build();
    const pulled = fakeAgent(h);
    const r = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "d/hello.txt", overwrite: true, mode: "0644", ifMatch: "5-1" }, uploadReq("hello", 5));
    expect(pulled.body).toBe("hello");
    expect(pulled.req).toMatchObject({ op: "write", scope: "volume", subject: "tugra_appv_app1_data", path: "d/hello.txt", mode: "0644", flags: "o", size: 5, ifMatch: "5-1" });
    expect(pulled.req!.sha256).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(r).toEqual({ created: true, body: { path: "d/hello.txt", bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", etag: "5-1" } });
    expect(await readdir(dir)).toEqual([]); // staged file removed on success
    expect(transfers.size).toBe(0);
    // audit: path/size/mode/overwrite, never the body
    const meta = h.audit.log.mock.calls[0][0].meta;
    expect(meta).toEqual({ scope: "volume", subject: "tugra_appv_app1_data", path: "d/hello.txt", size: 5, mode: "0644", overwrite: true, flags: "o" });
    expect(JSON.stringify(h.audit.log.mock.calls)).not.toContain("hello\"");
  });

  it("reports created=false (200) when the agent overwrote an existing file", async () => {
    const h = build();
    fakeAgent(h, { created: false });
    const r = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f", overwrite: true }, uploadReq("x", 1));
    expect(r.created).toBe(false);
  });

  it("requires Content-Length (411) and refuses an over-cap body (413) before reading or auditing anything", async () => {
    process.env.FILES_MAX_UPLOAD_BYTES = "10";
    const h = build();
    const e1 = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("x")).catch((e: unknown) => e);
    expect((e1 as HttpException).getStatus()).toBe(411);
    for (const bad of ["abc", "-1", "1e3", ""]) {
      await expect(h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("x", bad))).rejects.toMatchObject({ status: 411 });
    }
    const e2 = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("x", 11)).catch((e: unknown) => e);
    expect((e2 as HttpException).getStatus()).toBe(413);
    expect((e2 as FsPolicyException).code).toBe("too_large");
    expect(h.audit.log).not.toHaveBeenCalled();
    expect(h.apps.resolveFsTarget).not.toHaveBeenCalled();
  });

  it("never reads the body for a request the agent cannot take (offline / too old / no capability / datastore)", async () => {
    const h = build();
    let pulled = false;
    const body = new Readable({ read() { pulled = true; this.push(null); } });
    h.agentWs.assertFs2Ready.mockRejectedValueOnce(new ForbiddenException({ code: "capability_not_granted", capability: "files_write" }));
    await expect(h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq(body, 5))).rejects.toBeInstanceOf(ForbiddenException);
    expect(pulled).toBe(false);
    const ds = build({ app: { image: "redis:7" } });
    await expect(ds.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq(body, 5))).rejects.toMatchObject({ code: "datastore_running" });
    expect(pulled).toBe(false);
  });

  it("admission control runs BEFORE the body is read: a busy server is a 429 with nothing staged, and the slot is handed to sendFs2", async () => {
    const h = build();
    let pulled = false;
    const body = new Readable({ read() { pulled = true; this.push(null); } });
    h.agentWs.reserveFs2.mockImplementationOnce(() => {
      throw new HttpException({ statusCode: 429, code: "busy", message: "busy" }, 429);
    });
    const err = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq(body, 5)).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(pulled).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    expect(h.agentWs.sendFs2).not.toHaveBeenCalled();

    // happy path: reserve happens first, the same release is passed to sendFs2, and it is released afterwards
    const slot = jest.fn();
    h.agentWs.reserveFs2.mockReset().mockImplementation((() => {
      events.push("reserve");
      return slot;
    }) as never);
    fakeAgent(h);
    events.length = 0;
    await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("hello", 5));
    expect(events.indexOf("reserve")).toBeGreaterThan(events.indexOf("audit:app.file.write"));
    expect(events.indexOf("reserve")).toBeLessThan(events.indexOf("send"));
    expect(h.agentWs.sendFs2.mock.calls[0][3]).toEqual({ reservation: slot });
    expect(slot).toHaveBeenCalled(); // idempotent release in finally
    // ...and also on a failed upload
    const slot2 = jest.fn();
    h.agentWs.reserveFs2.mockImplementation((() => slot2) as never);
    await expect(h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("abc", 10))).rejects.toBeInstanceOf(BadRequestException);
    expect(slot2).toHaveBeenCalled();
  });

  it("a body shorter or longer than its Content-Length is a 400 and leaves nothing staged", async () => {
    for (const [body, len] of [["abc", 10], ["abcdefgh", 3]] as const) {
      const h = build();
      fakeAgent(h);
      const err = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq(body, len)).catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(400);
      expect(h.agentWs.sendFs2).not.toHaveBeenCalled();
      expect(await readdir(dir)).toEqual([]);
      expect(transfers.size).toBe(0);
    }
  });

  it("removes the staged file and the transfer when the agent rejects the write, and when the client aborts", async () => {
    const h = build();
    fakeAgent(h);
    h.agentWs.sendFs2.mockRejectedValueOnce(new FsRemoteException("exists", "already exists"));
    await expect(h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("hello", 5))).rejects.toBeInstanceOf(FsRemoteException);
    expect(await readdir(dir)).toEqual([]);
    expect(transfers.size).toBe(0);
    expect(h.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: "app.file.failed", meta: { op: "write", scope: "volume", code: "exists" } }));

    const body = new PassThrough();
    const p = h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq(body, 100));
    await new Promise((r) => setTimeout(r, 20));
    body.write("abc");
    body.destroy(new Error("client gone"));
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    expect(await readdir(dir)).toEqual([]);
  });

  it("answers 507 staging_full without touching the agent when the hub's staging budget is exhausted", async () => {
    process.env.FILES_STAGING_MAX_BYTES = "4";
    const h = build();
    fakeAgent(h);
    const err = await h.svc.upload("u1", "app1", { volume: "data" }, { path: "f" }, uploadReq("hello", 5)).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(507);
    expect(h.agentWs.sendFs2).not.toHaveBeenCalled();
  });

  it("uploads to the container scope through the same pipeline", async () => {
    const h = build({ scope: "container" });
    const pulled = fakeAgent(h);
    await h.svc.upload("u1", "app1", { container: "" }, { path: "/app/config.json", overwrite: true }, uploadReq("{}", 2));
    expect(pulled.req).toMatchObject({ op: "write", scope: "container", subject: "tugra_app1", path: "/app/config.json" });
    expect(h.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.container_fs.write" }));
  });

  // ── download ────────────────────────────────────────────────────────────────────────────────────────────────

  function statResult(over: Record<string, unknown> = {}) {
    return { type: "fs2_result", reqId: "r", ok: true, stat: { name: "r.txt", type: "file", size: 5, etag: "5-77", ...over } };
  }

  it("relays the agent's PUT to the browser with attachment/nosniff/no-store/sandbox headers and the stat's Content-Length + ETag", async () => {
    const h = build();
    const res = new FakeRes();
    h.agentWs.sendFs2.mockImplementation((async (_sid: string, req: Record<string, unknown>) => {
      if (req.op === "stat") return statResult();
      const { id, exp, sig } = parts(req.xfer as string);
      await transfers.receiveFromAgent(id, exp, sig, agentPut(["he", "llo"], 5));
      return { type: "fs2_result", reqId: "r", ok: true, bytes: 5 };
    }) as never);
    await h.svc.download("u1", "app1", { volume: "data" }, "d/réport \"x\".txt", res as unknown as ServerResponse);
    expect(res.body()).toBe("hello");
    expect(res.writableEnded).toBe(true);
    expect(res.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      "Content-Length": "5",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox",
      ETag: '"5-77"',
    });
    expect(res.headers["Content-Disposition"]).toMatch(/^attachment; filename="r_port _x_\.txt"; filename\*=UTF-8''r%C3%A9port%20%22x%22\.txt$/);
    expect(h.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "app.file.download", target: "app1", meta: { scope: "volume", subject: "tugra_appv_app1_data", path: "d/réport \"x\".txt", flags: "" } });
    expect(transfers.size).toBe(0);
  });

  it("refuses directories, special files and over-limit sizes before any transfer is registered", async () => {
    process.env.FILES_MAX_DOWNLOAD_BYTES = "100";
    const h = build();
    h.agentWs.sendFs2.mockResolvedValueOnce(statResult({ type: "dir" }) as never);
    await expect(h.svc.download("u1", "app1", { volume: "data" }, "d", new FakeRes() as unknown as ServerResponse)).rejects.toMatchObject({ code: "is_dir" });
    h.agentWs.sendFs2.mockResolvedValueOnce(statResult({ type: "symlink" }) as never);
    await expect(h.svc.download("u1", "app1", { volume: "data" }, "l", new FakeRes() as unknown as ServerResponse)).rejects.toMatchObject({ code: "not_regular" });
    h.agentWs.sendFs2.mockResolvedValueOnce(statResult({ size: 101 }) as never);
    const err = await h.svc.download("u1", "app1", { volume: "data" }, "big", new FakeRes() as unknown as ServerResponse).catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(413);
    expect(transfers.size).toBe(0);
  });

  it("a failure BEFORE the headers go out is the typed JSON error (and no download headers leak onto it)", async () => {
    const h = build();
    const res = new FakeRes();
    h.agentWs.sendFs2.mockResolvedValueOnce(statResult() as never).mockRejectedValueOnce(new FsRemoteException("changed", "file size changed") as never);
    const err = await h.svc.download("u1", "app1", { volume: "data" }, "r.txt", res as unknown as ServerResponse).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FsRemoteException);
    expect((err as FsRemoteException).getStatus()).toBe(412);
    expect(res.headersSent).toBe(false);
    expect(res.headers).toEqual({});
    expect(transfers.size).toBe(0);
    expect(h.audit.log).toHaveBeenLastCalledWith(expect.objectContaining({ action: "app.file.failed", meta: { op: "read", scope: "volume", code: "changed" } }));
  });

  it("a failure AFTER the headers/bytes went out destroys the browser response (a failed download, never a truncated success)", async () => {
    const h = build();
    const res = new FakeRes();
    h.agentWs.sendFs2.mockImplementation((async (_sid: string, req: Record<string, unknown>) => {
      if (req.op === "stat") return statResult({ size: 10 });
      const { id, exp, sig } = parts(req.xfer as string);
      const body = new PassThrough();
      const put = transfers.receiveFromAgent(id, exp, sig, agentPut(body, 10)).catch(() => undefined);
      body.write("hello");
      await new Promise((r) => setImmediate(r));
      body.destroy(new Error("helper died"));
      await put;
      throw new FsRemoteException("failed", "file operation failed");
    }) as never);
    await expect(h.svc.download("u1", "app1", { volume: "data" }, "r.txt", res as unknown as ServerResponse)).resolves.toBeUndefined();
    expect(res.destroyed).toBe(true);
    expect(res.writableFinished).toBe(false);
  });

  it("a download that fails after the bytes started flowing is still audited as app.file.failed", async () => {
    const h = build();
    const res = new FakeRes();
    h.agentWs.sendFs2.mockImplementation((async (_sid: string, req: Record<string, unknown>) => {
      if (req.op === "stat") return statResult({ size: 10 });
      const { id, exp, sig } = parts(req.xfer as string);
      const body = new PassThrough();
      const put = transfers.receiveFromAgent(id, exp, sig, agentPut(body, 10)).catch(() => undefined);
      body.write("hello");
      await new Promise((r) => setImmediate(r));
      body.destroy(new Error("helper died"));
      await put;
      throw new FsRemoteException("changed", "file size changed");
    }) as never);
    await h.svc.download("u1", "app1", { volume: "data" }, "r.txt", res as unknown as ServerResponse);
    expect(res.destroyed).toBe(true);
    expect(h.audit.log).toHaveBeenLastCalledWith({ actor: "u1", action: "app.file.failed", target: "app1", meta: { op: "read", scope: "volume", code: "changed" } });
  });

  // ── meta ────────────────────────────────────────────────────────────────────────────────────────────────────

  function metaCtx(h: ReturnType<typeof build>, ctx: Record<string, unknown>, caps: Record<string, boolean>, over: { online?: boolean; fs2?: boolean } = {}) {
    h.apps.fsContext.mockResolvedValue({ app: h.app, canTerminal: true, volumeKeys: ["data"], volumeServerId: "s1", deployInProgress: false, ...ctx });
    h.agentWs.isCapabilityGranted.mockImplementation((async (_s: string, c: string) => caps[c] ?? false) as never);
    h.agentWs.isOnline.mockReturnValue(over.online ?? true);
    h.agentWs.agentSupports.mockReturnValue(over.fs2 ?? true);
  }
  const full = { files: true, files_write: true, terminal: true };

  it("meta: writable volumes + an available container when everything is granted", async () => {
    const h = build();
    metaCtx(h, {}, full);
    const m = await h.svc.meta("u1", "app1");
    expect(m).toMatchObject({
      serverOnline: true, clustered: false, capabilities: { files: true, filesWrite: true, terminal: true }, canTerminal: true,
      agentSupportsFs2: true, datastore: false, volumes: [{ name: "data", writable: true }],
      container: { available: true, writable: true, names: ["tugra_app1"] },
    });
    expect(m.volumes[0].reason).toBeUndefined();
    expect(m.limits.maxEditBytes).toBe(1024 * 1024);
  });

  it("meta: each missing prerequisite yields its own reason", async () => {
    const h = build();
    metaCtx(h, {}, { files: true, terminal: true }); // no files_write
    expect((await h.svc.meta("u1", "app1")).volumes[0]).toEqual({ name: "data", writable: false, reason: "capability" });
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: true, writable: false, reason: "capability" });

    metaCtx(h, {}, full, { fs2: false });
    expect((await h.svc.meta("u1", "app1")).volumes[0].reason).toBe("agent_old");
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: false, reason: "agent_old" });

    metaCtx(h, {}, full, { online: false });
    expect((await h.svc.meta("u1", "app1")).volumes[0].reason).toBe("offline");
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: false, reason: "offline" });

    metaCtx(h, { deployInProgress: true }, full);
    expect((await h.svc.meta("u1", "app1")).volumes[0]).toEqual({ name: "data", writable: false, reason: "deploy_in_progress" });
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: true, writable: false, reason: "deploy_in_progress" });
  });

  it("meta: container reasons for permission, terminal capability, clustered and never-deployed apps", async () => {
    const h = build();
    metaCtx(h, { canTerminal: false }, full);
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: false, reason: "permission" });
    metaCtx(h, {}, { files: true, files_write: true });
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: false, reason: "capability" });
    h.app.clusterId = "c1";
    metaCtx(h, { volumeServerId: "s9" }, full);
    expect((await h.svc.meta("u1", "app1"))).toMatchObject({ clustered: true, container: { available: false, reason: "clustered" } });
    h.app.clusterId = null;
    h.app.status = "NEW";
    metaCtx(h, {}, full);
    expect((await h.svc.meta("u1", "app1")).container).toMatchObject({ available: false, reason: "not_deployed" });
    metaCtx(h, { volumeServerId: null }, full);
    expect((await h.svc.meta("u1", "app1"))).toMatchObject({ serverOnline: false, capabilities: { files: false, filesWrite: false, terminal: false } });
  });

  it("meta: a running datastore marks its volumes with the datastore_running advisory (still writable with acknowledgeRisk)", async () => {
    const h = build({ app: { image: "mariadb:11" } });
    metaCtx(h, {}, full);
    const m = await h.svc.meta("u1", "app1");
    expect(m.datastore).toBe(true);
    expect(m.volumes[0]).toEqual({ name: "data", writable: true, reason: "datastore_running" });
    h.app.status = "STOPPED";
    expect((await h.svc.meta("u1", "app1")).volumes[0]).toEqual({ name: "data", writable: true });
  });

  it("meta: COMPOSE apps list no container names (the UI picks from the existing container list)", async () => {
    const h = build({ app: { source: "COMPOSE" } });
    metaCtx(h, {}, full);
    expect((await h.svc.meta("u1", "app1")).container.names).toEqual([]);
  });

  // Conflict between this and the policy gate is only possible through the service; keep a regression for the
  // 409 mapping the UI relies on.
  it("policy errors carry stable machine codes", () => {
    expect(new FsPolicyException(409, "deploy_in_progress", "m").getResponse()).toMatchObject({ statusCode: 409, code: "deploy_in_progress" });
    expect(new ConflictException().getStatus()).toBe(409);
  });
});
