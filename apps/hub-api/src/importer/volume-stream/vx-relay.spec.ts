import { NotFoundException, StreamableFile, UnprocessableEntityException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { VolumeRelayService, type RelayRegistration } from "../../app-moves/volume-relay.service";
import { vxPrincipal } from "./vx-constants";

const SECRET = "test-secret-0123456789";
const NOW = 1_700_000_000_000;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const TRANSFER = "cktransferabcdefghijklmnopq"; // 27 chars: matches MOVE_ID_RE ^[a-z0-9]{20,32}$

function parts(p: string): { id: string; exp: string; sig: string } {
  const m = /^\/api\/v1\/agent-vx\/t\/([A-Za-z0-9_-]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)$/.exec(p);
  if (!m) throw new Error(`unexpected path ${p}`);
  return { id: m[1], exp: m[2], sig: m[3] };
}
function agentReq(body: Readable, contentLength?: number): IncomingMessage {
  const r = body as Readable & { headers: Record<string, string> };
  r.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return r as unknown as IncomingMessage;
}
const bodyOf = (b: Buffer, chunk = 11): Readable => Readable.from((function* () { for (let i = 0; i < b.length; i += chunk) yield b.subarray(i, i + chunk); })());
async function readAll(f: StreamableFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of f.getStream()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe("relay with the mig:<opId> principal (migration volume stream)", () => {
  let svc: VolumeRelayService;
  const cfg = (extra: Record<string, unknown> = {}) => ({ get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? SECRET : extra[k]) }) as unknown as ConfigService;
  const data = Buffer.from("gzip-member-bytes-".repeat(100));
  const register = (over: Partial<Parameters<VolumeRelayService["register"]>[0]> = {}): RelayRegistration => {
    const r = svc.register({ moveId: TRANSFER, volIdx: 0, part: 4, size: data.length, sha256: sha(data), srcServerId: vxPrincipal("op1"), dstServerId: "ckserver0000000000000000001", ...over }, NOW);
    if (r.busy) throw new Error("unexpected busy");
    return r;
  };
  beforeEach(() => {
    svc = new VolumeRelayService(cfg());
  });
  afterEach(() => svc.onModuleDestroy());

  it("round-trips a part whose source principal is mig:<opId> (transferId as moveId, volIdx 0)", async () => {
    const r = register();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    const reading = readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW));
    await svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), data.length), NOW);
    expect((await reading).equals(data)).toBe(true);
    await expect(r.done).resolves.toEqual({ bytes: data.length, sha256: sha(data) });
  });

  it("the mig: source claim cannot be used as the destination role (and vice versa)", async () => {
    const r = register();
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    expect(() => svc.serveToTarget(src.id, src.exp, src.sig, NOW)).toThrow(NotFoundException);
    await expect(svc.receiveFromSource(dst.id, dst.exp, dst.sig, agentReq(bodyOf(data), data.length), NOW)).rejects.toBeInstanceOf(NotFoundException);
    r.cancel(new Error("cleanup"));
  });

  it("a sha mismatch is a 422 to the migrator and the target never sees a clean end", async () => {
    const r = register({ sha256: sha("something else") });
    const src = parts(r.srcPath);
    const dst = parts(r.dstPath);
    const reading = readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW)).catch((e: unknown) => e);
    await expect(svc.receiveFromSource(src.id, src.exp, src.sig, agentReq(bodyOf(data), data.length), NOW)).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await reading).toBeInstanceOf(Error); // an error, never a clean Buffer
    await expect(r.done).rejects.toThrow(/sha256 mismatch/);
  });

  it("cancel destroys both ends", async () => {
    const r = register();
    const dst = parts(r.dstPath);
    const reading = readAll(svc.serveToTarget(dst.id, dst.exp, dst.sig, NOW)).catch((e: unknown) => e);
    r.cancel(new Error("aborted"));
    expect(await reading).toBeInstanceOf(Error);
    await expect(r.done).rejects.toThrow("aborted");
    expect(svc.size).toBe(0);
  });

  it("migration seats are a SEPARATE pool: they neither consume nor wait for the app-move seats", () => {
    svc.onModuleDestroy();
    svc = new VolumeRelayService(cfg({ MOVE_MAX_CONCURRENT_RELAYS: 1, MIGRATION_RELAY_CONCURRENCY: 2 }));
    const mv = svc.register({ moveId: TRANSFER, volIdx: 0, part: 0, size: 1, sha256: sha("x"), srcServerId: "ckserver0000000000000000002", dstServerId: "ckserver0000000000000000001" }, NOW);
    expect(mv.busy).toBe(false);
    // the app-move pool (1 seat) is full, yet two migration parts still register
    const m1 = svc.register({ moveId: TRANSFER, volIdx: 0, part: 1, size: 1, sha256: sha("x"), srcServerId: vxPrincipal("op1"), dstServerId: "d" }, NOW);
    const m2 = svc.register({ moveId: TRANSFER, volIdx: 0, part: 2, size: 1, sha256: sha("x"), srcServerId: vxPrincipal("op1"), dstServerId: "d" }, NOW);
    expect([m1.busy, m2.busy]).toEqual([false, false]);
    // third migration part: its own pool (2) is exhausted
    expect(svc.register({ moveId: TRANSFER, volIdx: 0, part: 3, size: 1, sha256: sha("x"), srcServerId: vxPrincipal("op1"), dstServerId: "d" }, NOW)).toEqual({ busy: true });
    // and a second app-move part is still refused by ITS pool
    expect(svc.register({ moveId: TRANSFER, volIdx: 0, part: 4, size: 1, sha256: sha("x"), srcServerId: "ckserver0000000000000000002", dstServerId: "d" }, NOW)).toEqual({ busy: true });
    for (const r of [mv, m1, m2]) if (!r.busy) r.cancel(new Error("cleanup"));
  });

  it("default migration pool is 2 seats and is independent of MOVE_MAX_CONCURRENT_RELAYS", () => {
    svc.onModuleDestroy();
    svc = new VolumeRelayService(cfg({ MOVE_MAX_CONCURRENT_RELAYS: 8 }));
    const regs = [0, 1, 2].map((p) => svc.register({ moveId: TRANSFER, volIdx: 0, part: p, size: 1, sha256: sha("x"), srcServerId: vxPrincipal("op1"), dstServerId: "d" }, NOW));
    expect(regs.map((r) => r.busy)).toEqual([false, false, true]);
    for (const r of regs) if (!r.busy) r.cancel(new Error("cleanup"));
  });
});
