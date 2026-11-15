import { NotFoundException, StreamableFile, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import request from "supertest";
import { mintXferPath, verifyXferSig } from "../files/fs-transfer";
import { RELAY_HKDF_LABEL, RELAY_MAX_HORIZON_MS, mintRelayPath, newRelayId, relayPayload, verifyRelaySig, type RelayClaim } from "./volume-relay-sig";
import { RELAY_IDLE_MS, RELAY_TTL_SEC, VolumeRelayService, type RelayRegistration } from "./volume-relay.service";
import { VolumeRelayController } from "./volume-relay.controller";

const SECRET = "test-secret-0123456789";
const NOW = 1_700_000_000_000;
const EXP = Math.floor(NOW / 1000) + 300;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const claim: RelayClaim = { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", role: "src", serverId: "s1", moveId: "ckmoveabcdefghijklmnopqrs", volIdx: 0, part: 3, size: 1000, sha256: "a".repeat(64) };

function parts(p: string): { id: string; exp: string; sig: string } {
  const m = /^\/api\/v1\/agent-vx\/t\/([A-Za-z0-9_-]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)$/.exec(p);
  if (!m) throw new Error(`unexpected path ${p}`);
  return { id: m[1], exp: m[2], sig: m[3] };
}

describe("relay signature (pure)", () => {
  it("mints a relative path in the documented shape", () => {
    const p = mintRelayPath(SECRET, { ...claim, id: newRelayId() }, EXP);
    expect(p).toMatch(/^\/api\/v1\/agent-vx\/t\/[A-Za-z0-9_-]{16,64}\?exp=[0-9]{1,12}&sig=[A-Za-z0-9_-]{16,128}$/);
    expect(newRelayId()).not.toBe(newRelayId());
    expect(newRelayId()).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 random bytes, base64url
  });

  it("the signed payload is v1|id|role|serverId|moveId|volIdx|part|size|sha256|exp", () => {
    expect(relayPayload(claim, 123)).toBe(`v1|${claim.id}|src|s1|${claim.moveId}|0|3|1000|${"a".repeat(64)}|123`);
  });

  it("verifies, and any tampered bound field breaks it (id, role, server, move, volume, part, size, sha, exp, key)", () => {
    const sig = parts(mintRelayPath(SECRET, claim, EXP)).sig;
    expect(verifyRelaySig(SECRET, claim, EXP, sig, NOW)).toBe(true);
    const bad: Array<Partial<RelayClaim>> = [
      { id: claim.id + "x" }, { role: "dst" }, { serverId: "s2" }, { moveId: "ckmoveabcdefghijklmnopqrt" }, { volIdx: 1 }, { part: 4 }, { size: 1001 }, { sha256: "b".repeat(64) },
    ];
    for (const b of bad) expect(verifyRelaySig(SECRET, { ...claim, ...b }, EXP, sig, NOW)).toBe(false);
    expect(verifyRelaySig(SECRET, claim, EXP + 1, sig, NOW)).toBe(false);
    expect(verifyRelaySig("other-secret-0123456789", claim, EXP, sig, NOW)).toBe(false);
    expect(verifyRelaySig(SECRET, claim, EXP, sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"), NOW)).toBe(false);
    expect(verifyRelaySig(SECRET, claim, EXP, "x".repeat(200), NOW)).toBe(false);
  });

  it("exp must be an integer in (now, now + 10 min]", () => {
    const mk = (exp: number) => verifyRelaySig(SECRET, claim, exp, parts(mintRelayPath(SECRET, claim, exp)).sig, NOW);
    expect(mk(Math.floor(NOW / 1000) + 1)).toBe(true);
    expect(mk(Math.floor((NOW + RELAY_MAX_HORIZON_MS) / 1000))).toBe(true);
    expect(mk(Math.floor((NOW + RELAY_MAX_HORIZON_MS) / 1000) + 1)).toBe(false);
    expect(mk(Math.floor(NOW / 1000))).toBe(false);
    expect(mk(Math.floor(NOW / 1000) - 5)).toBe(false);
    expect(verifyRelaySig(SECRET, claim, 1.5, "x".repeat(43), NOW)).toBe(false);
    expect(RELAY_TTL_SEC * 1000).toBeLessThan(RELAY_MAX_HORIZON_MS);
  });

  it("HKDF label separation: an fs-transfer URL never verifies as a relay URL and vice versa", () => {
    expect(RELAY_HKDF_LABEL).toBe("tugra-vol-relay-v1");
    const fsPath = mintXferPath(SECRET, { id: claim.id, dir: "to-agent", serverId: "s1", size: 1000, sha256: "a".repeat(64) }, EXP);
    const fsSig = new URL(`http://x${fsPath}`).searchParams.get("sig")!;
    expect(verifyRelaySig(SECRET, claim, EXP, fsSig, NOW)).toBe(false);
    expect(verifyRelaySig(SECRET, { ...claim, role: "dst" }, EXP, fsSig, NOW)).toBe(false);
    const relaySig = parts(mintRelayPath(SECRET, claim, EXP)).sig;
    for (const dir of ["to-agent", "from-agent"] as const) {
      expect(verifyXferSig(SECRET, { id: claim.id, dir, serverId: "s1", size: 1000, sha256: "a".repeat(64) }, EXP, relaySig, NOW)).toBe(false);
    }
  });
});

function agentReq(body: Readable, contentLength?: number): IncomingMessage {
  const r = body as Readable & { headers: Record<string, string> };
  r.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return r as unknown as IncomingMessage;
}
const bodyOf = (b: Buffer, chunk = 7): Readable => Readable.from((function* () { for (let i = 0; i < b.length; i += chunk) yield b.subarray(i, i + chunk); })());

async function readAll(f: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of f.getStream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe("VolumeRelayService", () => {
  let svc: VolumeRelayService;
  const cfg = (extra: Record<string, unknown> = {}) => ({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? SECRET : extra[k]) }) as unknown as ConfigService;
  beforeEach(() => {
    svc = new VolumeRelayService(cfg());
  });
  afterEach(() => svc.onModuleDestroy());

  const data = Buffer.from("the quick brown fox jumps over the lazy dog".repeat(50));
  const reg = (over: Partial<Parameters<VolumeRelayService["register"]>[0]> = {}): RelayRegistration => {
    const r = svc.register({ moveId: claim.moveId, volIdx: 0, part: 0, size: data.length, sha256: sha(data), srcServerId: "s1", dstServerId: "s2", ...over }, NOW);
    if (r.busy) throw new Error("unexpected busy");
    return r;
  };

  it("source first, then target: the bytes arrive intact and the PUT resolves only AFTER the target drained", async () => {
    const r = reg();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    let putDone = false;
    const put = svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), data.length), NOW).then(() => (putDone = true));
    await new Promise((res) => setTimeout(res, 20));
    expect(putDone).toBe(false); // nobody has read the buffer yet
    const got = await readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW));
    await put;
    expect(got.equals(data)).toBe(true);
    await expect(r.done).resolves.toEqual({ bytes: data.length, sha256: sha(data) });
    expect(svc.size).toBe(0);
  });

  it("target first, then source", async () => {
    const r = reg();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    const file = svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW);
    expect(file.getHeaders().length).toBe(data.length);
    const reading = readAll(file);
    await new Promise((res) => setTimeout(res, 10));
    await svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), data.length), NOW);
    expect((await reading).equals(data)).toBe(true);
    await expect(r.done).resolves.toMatchObject({ bytes: data.length });
  });

  it("is single use per role (a replay of either URL is a 404) and a failed attempt does not burn the legitimate one", async () => {
    const r = reg();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    // garbage first: bad sig / wrong exp must NOT consume the claim or fail the rendezvous
    expect(() => svc.serveToTarget(dst.id, dst.exp, dst.sig.slice(0, -2) + "zz", NOW)).toThrow(NotFoundException);
    expect(() => svc.serveToTarget(dst.id, String(Number(dst.exp) + 1), dst.sig, NOW)).toThrow(NotFoundException);
    const file = svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW);
    expect(() => svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW)).toThrow(NotFoundException); // target replay
    const reading = readAll(file);
    await svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), data.length), NOW);
    await reading;
    await expect(svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), data.length), NOW)).rejects.toBeInstanceOf(NotFoundException); // settled
  });

  it("every failure on the agent-facing routes is the SAME 404: wrong role, bad sig, expired, unknown id, junk args", async () => {
    const r = reg();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    const attempts: Array<() => unknown> = [
      () => svc.serveToTarget(src.id, src.exp, src.sig, NOW), // the SOURCE url used as a GET (wrong role)
      () => svc.receiveFromSource(dst.id, dst.exp, dst.sig, agentReq(bodyOf(data), data.length), NOW), // the TARGET url used as a PUT
      () => svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW + 3_600_000), // expired
      () => svc.serveToTarget("nope" + dst.id, dst.exp, dst.sig, NOW), // unknown id
      () => svc.serveToTarget(undefined, dst.exp, dst.sig, NOW),
      () => svc.serveToTarget(dst.id, undefined, dst.sig, NOW),
      () => svc.serveToTarget(dst.id, dst.exp, undefined, NOW),
    ];
    const msgs = new Set<string>();
    for (const a of attempts) {
      let err: unknown;
      try {
        await a();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NotFoundException);
      msgs.add(JSON.stringify((err as NotFoundException).getResponse()));
    }
    expect(msgs.size).toBe(1);
    expect(svc.size).toBe(1); // none of that disturbed the live rendezvous
    r.cancel(new Error("cleanup"));
  });

  it("a Content-Length that differs from the registered size (or chunked/no length) fails the rendezvous", async () => {
    for (const cl of [data.length + 1, data.length - 1, undefined]) {
      const r = reg();
      const src = parts(r.srcPath);
      await expect(svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), cl), NOW)).rejects.toBeInstanceOf(NotFoundException);
      await expect(r.done).rejects.toThrow();
    }
    const r = reg();
    const src = parts(r.srcPath);
    const req = agentReq(bodyOf(data), data.length);
    (req.headers as Record<string, string>)["transfer-encoding"] = "chunked";
    await expect(svc.receiveFromSource(src.id, src.exp, src.sig, req, NOW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("byte cap: a body longer or shorter than the declared size fails BOTH ends", async () => {
    for (const body of [Buffer.concat([data, Buffer.from("X")]), data.subarray(0, data.length - 1)]) {
      const r = reg();
      const src = parts(r.srcPath);
      const dst = parts(r.dstPath);
      const reading = readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW)).catch((e: unknown) => e);
      await expect(svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(body), data.length), NOW)).rejects.toBeInstanceOf(NotFoundException);
      expect(await reading).toBeInstanceOf(Error); // the target side died with it
      await expect(r.done).rejects.toThrow();
    }
  });

  it("sha mismatch: the PUT is answered 422 and the target's stream errors (never a clean end of a wrong part)", async () => {
    const bad = Buffer.from(data);
    bad[5] ^= 0xff; // same length, one flipped byte
    const r = reg();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    const reading = readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW)).catch((e: unknown) => e);
    await expect(svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(bad), data.length), NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await reading).toBeInstanceOf(Error);
    await expect(r.done).rejects.toThrow(/sha256 mismatch/);
    expect(svc.size).toBe(0);
  });

  it("one side aborting kills the other: target hang-up fails the PUT; source abort errors the GET", async () => {
    {
      const r = reg();
      const src = parts(r.srcPath);
      const dst = parts(r.dstPath);
      const slowSrc = new PassThrough();
      const put = svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(slowSrc, data.length), NOW).catch((e: unknown) => e);
      const file = svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW);
      slowSrc.write(data.subarray(0, 100));
      const stream = file.getStream();
      await new Promise((res) => setTimeout(res, 20));
      stream.destroy(); // the target agent hung up mid-part
      expect(await put).toBeInstanceOf(NotFoundException);
      await expect(r.done).rejects.toThrow();
    }
    {
      const r = reg();
      const src = parts(r.srcPath);
      const dst = parts(r.dstPath);
      const slowSrc = new PassThrough();
      const put = svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(slowSrc, data.length), NOW).catch((e: unknown) => e);
      const reading = readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW)).catch((e: unknown) => e);
      slowSrc.write(data.subarray(0, 100));
      await new Promise((res) => setTimeout(res, 20));
      slowSrc.destroy(new Error("source agent died"));
      expect(await put).toBeInstanceOf(NotFoundException);
      expect(await reading).toBeInstanceOf(Error);
      await expect(r.done).rejects.toThrow();
    }
  });

  it("backpressure: the source is only pulled while the target keeps up (buffer stays bounded, nothing is staged)", async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 7);
    const r = reg({ size: big.length, sha256: sha(big) });
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    let pulled = 0;
    const chunk = 256 * 1024;
    let off = 0;
    const source = new Readable({
      highWaterMark: chunk,
      read() {
        if (off >= big.length) return this.push(null);
        pulled += chunk;
        this.push(big.subarray(off, off + chunk));
        off += chunk;
      },
    });
    const put = svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(source, big.length), NOW);
    await new Promise((res) => setTimeout(res, 100));
    // with NO consumer on the target the pull stalls after a few MiB of buffering (1 MiB + stage buffers), far below 16 MiB
    expect(pulled).toBeLessThan(6 * 1024 * 1024);
    const stalled = pulled;
    await new Promise((res) => setTimeout(res, 50));
    expect(pulled).toBe(stalled); // still stalled: nothing moves without the target
    const got = await readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW));
    await put;
    expect(got.length).toBe(big.length);
    expect(sha(got)).toBe(sha(big));
  });

  it("concurrency cap: registration is `busy` beyond MOVE_MAX_CONCURRENT_RELAYS and frees up when a rendezvous ends", () => {
    const capped = new VolumeRelayService(cfg({ MOVE_MAX_CONCURRENT_RELAYS: 2 }));
    const mk = () => capped.register({ moveId: claim.moveId, volIdx: 0, part: 0, size: 1, sha256: sha("x"), srcServerId: "s1", dstServerId: "s2" }, NOW);
    const a = mk();
    const b = mk();
    expect(a.busy).toBe(false);
    expect(b.busy).toBe(false);
    expect(mk()).toEqual({ busy: true });
    (a as RelayRegistration).cancel(new Error("done"));
    expect(mk().busy).toBe(false);
    capped.onModuleDestroy();
  });

  it("the default cap is 2 hub-wide", () => {
    const mk = () => svc.register({ moveId: claim.moveId, volIdx: 0, part: 0, size: 1, sha256: sha("x"), srcServerId: "s1", dstServerId: "s2" }, NOW);
    expect([mk().busy, mk().busy, mk().busy]).toEqual([false, false, true]);
  });

  it("an unused rendezvous is swept after its expiry and fails its owner", async () => {
    const r = reg();
    svc.sweep(NOW + 10_000);
    expect(svc.size).toBe(1);
    svc.sweep(NOW + (RELAY_TTL_SEC + 1) * 1000);
    expect(svc.size).toBe(0);
    await expect(r.done).rejects.toThrow(/expired/);
  });

  it("cancel() fails done, destroys the buffer and is idempotent", async () => {
    const r = reg();
    r.cancel(new Error("move cancelled"));
    r.cancel(new Error("again"));
    await expect(r.done).rejects.toThrow("move cancelled");
    expect(svc.size).toBe(0);
  });

  it("idle timeout: no byte and no peer for 120 s fails the rendezvous", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      const local = new VolumeRelayService(cfg());
      const now = Date.now(); // the fake clock starts at the real time; the sweeper must see a live rendezvous
      const r = local.register({ moveId: claim.moveId, volIdx: 0, part: 0, size: data.length, sha256: sha(data), srcServerId: "s1", dstServerId: "s2" }, now);
      if (r.busy) throw new Error("busy");
      const dst = parts(r.dstPath);
      local.serveToTarget(dst.id, dst.exp, dst.sig, now); // the target waits; the source never shows up
      jest.advanceTimersByTime(RELAY_IDLE_MS - 1000);
      expect(local.size).toBe(1);
      jest.advanceTimersByTime(2000);
      await expect(r.done).rejects.toThrow(/idle/);
      expect(local.size).toBe(0);
      local.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("VolumeRelayController (HTTP)", () => {
  let app: INestApplication;
  let svc: VolumeRelayService;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [VolumeRelayController],
      providers: [VolumeRelayService, { provide: ConfigService, useValue: { get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? SECRET : undefined) } }],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    svc = mod.get(VolumeRelayService);
  });
  afterAll(async () => {
    await app.close();
  });

  const body = Buffer.from("0123456789abcdef".repeat(4096));
  const open = (data = body) => {
    const r = svc.register({ moveId: claim.moveId, volIdx: 0, part: 1, size: data.length, sha256: sha(data), srcServerId: "s1", dstServerId: "s2" });
    if (r.busy) throw new Error("busy");
    return r;
  };
  const url = (p: string) => p.replace("/api/v1", ""); // the test app has no global prefix

  it("PUT (204, no-store) and GET (200, exact length, octet-stream) carry the part end to end, concurrently", async () => {
    const r = open();
    const [put, get] = await Promise.all([
      request(app.getHttpServer()).put(url(r.srcPath)).set("Content-Type", "application/octet-stream").send(body),
      request(app.getHttpServer()).get(url(r.dstPath)).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      }),
    ]);
    expect(put.status).toBe(204);
    expect(put.headers["cache-control"]).toBe("no-store");
    expect(get.status).toBe(200);
    expect(get.headers["content-type"]).toBe("application/octet-stream");
    expect(get.headers["content-length"]).toBe(String(body.length));
    expect(get.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(get.body).equals(body)).toBe(true);
    await expect(r.done).resolves.toMatchObject({ bytes: body.length });
  });

  it("answers the uniform 404 with no body hints for a replay, a bad signature and an unknown id", async () => {
    const r = open();
    const bad = await request(app.getHttpServer()).get(url(r.dstPath.replace(/sig=.{4}/, "sig=AAAA")));
    const unknown = await request(app.getHttpServer()).get("/agent-vx/t/nope?exp=1&sig=x");
    const wrongRole = await request(app.getHttpServer()).put(url(r.dstPath)).send(body);
    expect([bad.status, unknown.status, wrongRole.status]).toEqual([404, 404, 404]);
    expect(bad.body).toEqual(unknown.body);
    expect(unknown.body).toEqual(wrongRole.body);
    r.cancel(new Error("cleanup"));
  });

  it("a flipped byte is 422 to the source", async () => {
    const r = open();
    const bad = Buffer.from(body);
    bad[10] ^= 1;
    const [put] = await Promise.all([
      request(app.getHttpServer()).put(url(r.srcPath)).set("Content-Type", "application/octet-stream").send(bad),
      request(app.getHttpServer()).get(url(r.dstPath)).buffer(true).parse((res, cb) => {
        res.on("data", () => undefined);
        res.on("end", () => cb(null, Buffer.alloc(0)));
        res.on("error", () => cb(null, Buffer.alloc(0)));
      }).catch(() => undefined),
    ]);
    expect(put.status).toBe(422);
    await expect(r.done).rejects.toThrow();
  });
});
