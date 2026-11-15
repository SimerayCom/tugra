import { NotFoundException, StreamableFile } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { mintArtifactUrl } from "../importer/migration-artifact";
import { attachmentDisposition, byteCounter, mintXferPath, newXferId, verifyXferSig, type XferClaim } from "./fs-transfer";
import { FsTransferService } from "./fs-transfer.service";

const SECRET = "test-secret-0123456789";
const claim: XferClaim = { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", dir: "to-agent", serverId: "s1", size: 5, sha256: "a".repeat(64) };
const NOW = 1_700_000_000_000;
const EXP = Math.floor(NOW / 1000) + 600;

function parts(p: string): { id: string; exp: string; sig: string } {
  const m = /^\/api\/v1\/agent-fs\/t\/([A-Za-z0-9_-]+)\?exp=(\d+)&sig=([A-Za-z0-9_-]+)$/.exec(p);
  if (!m) throw new Error(`unexpected path ${p}`);
  return { id: m[1], exp: m[2], sig: m[3] };
}

describe("fs-transfer (pure)", () => {
  it("mints a relative path the agent's regex accepts", () => {
    const p = mintXferPath(SECRET, { ...claim, id: newXferId() }, EXP);
    expect(p).toMatch(/^\/api\/v1\/agent-fs\/t\/[A-Za-z0-9_-]{16,64}\?exp=[0-9]{1,12}&sig=[A-Za-z0-9_-]{16,128}$/);
    expect(newXferId()).not.toBe(newXferId());
  });

  it("verifies, and any tampered bound field breaks the signature", () => {
    const sig = parts(mintXferPath(SECRET, claim, EXP)).sig;
    expect(verifyXferSig(SECRET, claim, EXP, sig, NOW)).toBe(true);
    const bad: Array<Partial<XferClaim>> = [
      { id: claim.id + "x" }, { dir: "from-agent" }, { serverId: "s2" }, { size: 6 }, { sha256: "b".repeat(64) },
    ];
    for (const b of bad) expect(verifyXferSig(SECRET, { ...claim, ...b }, EXP, sig, NOW)).toBe(false);
    expect(verifyXferSig(SECRET, claim, EXP + 1, sig, NOW)).toBe(false);
    expect(verifyXferSig("other-secret-0123456789", claim, EXP, sig, NOW)).toBe(false);
    expect(verifyXferSig(SECRET, claim, EXP, sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"), NOW)).toBe(false);
  });

  it("rejects an expired, past-horizon or non-integer exp even with a valid MAC", () => {
    const old = Math.floor(NOW / 1000) - 1;
    expect(verifyXferSig(SECRET, claim, old, parts(mintXferPath(SECRET, claim, old)).sig, NOW)).toBe(false);
    const far = Math.floor(NOW / 1000) + 3 * 3600;
    expect(verifyXferSig(SECRET, claim, far, parts(mintXferPath(SECRET, claim, far)).sig, NOW)).toBe(false);
    expect(verifyXferSig(SECRET, claim, 1.5, "x".repeat(43), NOW)).toBe(false);
  });

  it("is domain-separated from the migration artifact URLs (neither replays as the other)", () => {
    const { url } = mintArtifactUrl("https://hub", SECRET, { opId: claim.id, taskId: "t", sha256: claim.sha256 }, NOW);
    const migSig = new URL(url).searchParams.get("sig")!;
    expect(verifyXferSig(SECRET, claim, EXP, migSig, NOW)).toBe(false);
  });

  it("byteCounter passes exact bodies and fails short/long ones", async () => {
    const run = async (chunks: string[], size: number) => {
      const out: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const c = byteCounter(size);
        c.on("data", (d) => out.push(d)).on("end", resolve).on("error", reject);
        for (const ch of chunks) c.write(ch);
        c.end();
      });
      return Buffer.concat(out).toString();
    };
    await expect(run(["abc", "de"], 5)).resolves.toBe("abcde");
    await expect(run(["abc"], 5)).rejects.toThrow(/shorter/);
    await expect(run(["abcdef"], 5)).rejects.toThrow(/longer/);
    await expect(run([], 0)).resolves.toBe("");
  });

  it("builds a safe attachment Content-Disposition for hostile and unicode names", () => {
    expect(attachmentDisposition("report.pdf")).toBe(`attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
    const q = attachmentDisposition('a"b\\c;d.txt');
    expect(q).toContain('filename="a_b_c_d.txt"');
    expect(q).toContain("filename*=UTF-8''a%22b%5Cc%3Bd.txt");
    const crlf = attachmentDisposition("x\r\nSet-Cookie: a=b");
    expect(crlf).not.toMatch(/[\r\n]/);
    expect(crlf.split("filename=")[1].split(";")[0]).toBe('"x__Set-Cookie: a=b"');
    const uni = attachmentDisposition("héllo 日本.txt");
    expect(uni).toContain('filename="h_llo __.txt"');
    expect(uni).toContain("filename*=UTF-8''h%C3%A9llo%20%E6%97%A5%E6%9C%AC.txt");
    expect(attachmentDisposition("it's (1).txt")).toContain("filename*=UTF-8''it%27s%20%281%29.txt");
    expect(attachmentDisposition("")).toContain('filename="download"');
    expect(attachmentDisposition("x")).toMatch(/^attachment;/);
  });
});

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

function agentReq(body: string[] | Readable, contentLength?: number): IncomingMessage {
  const r = (Array.isArray(body) ? Readable.from(body.map((s) => Buffer.from(s))) : body) as Readable & { headers: Record<string, string> };
  r.headers = contentLength === undefined ? {} : { "content-length": String(contentLength) };
  return r as unknown as IncomingMessage;
}

describe("FsTransferService", () => {
  let svc: FsTransferService;
  let tmp: string;
  beforeEach(async () => {
    svc = new FsTransferService({ get: () => SECRET } as unknown as ConfigService);
    tmp = await mkdtemp(path.join(os.tmpdir(), "fs-xfer-"));
  });
  afterEach(async () => {
    svc.onModuleDestroy();
    await rm(tmp, { recursive: true, force: true });
  });

  async function staged(content: string) {
    const p = path.join(tmp, "f.part");
    await writeFile(p, content);
    return p;
  }

  async function readAll(f: StreamableFile): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of f.getStream()) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  }

  it("serves a staged upload to the agent exactly once", async () => {
    const reg = svc.registerUpload({ serverId: "s1", appId: "a", stagedPath: await staged("hello"), size: 5, sha256: "a".repeat(64) }, 600, NOW);
    const { id, exp, sig } = parts(reg.path);
    const f = svc.serveToAgent(id, exp, sig, NOW);
    expect(f.getHeaders().length).toBe(5);
    await expect(readAll(f)).resolves.toBe("hello");
    expect(() => svc.serveToAgent(id, exp, sig, NOW)).toThrow(NotFoundException); // single use
  });

  it("answers EVERY failure with the same uniform 404", async () => {
    const reg = svc.registerUpload({ serverId: "s1", appId: "a", stagedPath: await staged("hello"), size: 5, sha256: "a".repeat(64) }, 600, NOW);
    const { id, exp, sig } = parts(reg.path);
    const attempts: Array<() => unknown> = [
      () => svc.serveToAgent(id, exp, sig.slice(0, -2) + "zz", NOW), // bad sig
      () => svc.serveToAgent(id, String(Number(exp) + 1), sig, NOW), // exp mismatch
      () => svc.serveToAgent(id, exp, sig, NOW + 3_600_000), // expired
      () => svc.serveToAgent("nope" + id, exp, sig, NOW), // unknown id
      () => svc.serveToAgent(undefined, exp, sig, NOW),
      () => svc.serveToAgent(id, undefined, sig, NOW),
      () => svc.serveToAgent(id, exp, undefined, NOW),
      () => svc.receiveFromAgent(id, exp, sig, agentReq(["hello"], 5), NOW), // wrong direction (PUT on a to-agent transfer)
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
    // the failed attempts did not burn the transfer: the legitimate hit still works
    expect(svc.serveToAgent(id, exp, sig, NOW)).toBeInstanceOf(StreamableFile);
  });

  it("relays a download PUT into the browser response and resolves done", async () => {
    const sink = new FakeRes();
    const reg = svc.registerDownload({ serverId: "s1", appId: "a", size: 5, sink: sink as unknown as ServerResponse, headers: { "Content-Length": "5", "Content-Disposition": "attachment" } }, 600, NOW);
    const { id, exp, sig } = parts(reg.path);
    await svc.receiveFromAgent(id, exp, sig, agentReq(["he", "llo"], 5), NOW);
    await expect(reg.done).resolves.toBeUndefined();
    expect(sink.body()).toBe("hello");
    expect(sink.headers["Content-Disposition"]).toBe("attachment");
    expect(sink.writableEnded).toBe(true);
    await expect(svc.receiveFromAgent(id, exp, sig, agentReq(["hello"], 5), NOW)).rejects.toBeInstanceOf(NotFoundException); // single use
  });

  it("refuses a Content-Length that differs from the registered size (and strips the download headers)", async () => {
    const sink = new FakeRes();
    const reg = svc.registerDownload({ serverId: "s1", appId: "a", size: 5, sink: sink as unknown as ServerResponse, headers: { "Content-Length": "5" } }, 600, NOW);
    const { id, exp, sig } = parts(reg.path);
    await expect(svc.receiveFromAgent(id, exp, sig, agentReq(["hello!"], 6), NOW)).rejects.toBeInstanceOf(NotFoundException);
    await expect(reg.done).rejects.toThrow();
    expect(sink.headersSent).toBe(false);
    expect(sink.headers["Content-Length"]).toBeUndefined(); // the owner can still send a typed JSON error
    await expect(svc.receiveFromAgent(id, exp, sig, agentReq(["hello"]), NOW)).rejects.toBeInstanceOf(NotFoundException); // no CL at all
  });

  it("a mid-stream failure destroys the browser response (never a clean end) and rejects done", async () => {
    const sink = new FakeRes();
    const reg = svc.registerDownload({ serverId: "s1", appId: "a", size: 10, sink: sink as unknown as ServerResponse, headers: {} }, 600, NOW);
    const { id, exp, sig } = parts(reg.path);
    const body = new PassThrough();
    const p = svc.receiveFromAgent(id, exp, sig, agentReq(body, 10), NOW);
    body.write("hello");
    await new Promise((r) => setImmediate(r));
    body.destroy(new Error("agent died"));
    await expect(p).rejects.toBeInstanceOf(NotFoundException);
    await expect(reg.done).rejects.toThrow();
    expect(sink.destroyed).toBe(true);
    expect(sink.writableFinished).toBe(false);
  });

  it("a body shorter or longer than declared fails the relay and destroys the sink", async () => {
    for (const body of [["abc"], ["abcdefgh"]]) {
      const sink = new FakeRes();
      const reg = svc.registerDownload({ serverId: "s1", appId: "a", size: 5, sink: sink as unknown as ServerResponse, headers: {} }, 600, NOW);
      const { id, exp, sig } = parts(reg.path);
      await expect(svc.receiveFromAgent(id, exp, sig, agentReq(body, 5), NOW)).rejects.toBeInstanceOf(NotFoundException);
      await expect(reg.done).rejects.toThrow();
      expect(sink.writableFinished).toBe(false);
    }
  });

  it("cancel() fails a pending download; sweep() expires and fails stale ones; release() forgets", async () => {
    const sink = new FakeRes();
    const reg = svc.registerDownload({ serverId: "s1", appId: "a", size: 5, sink: sink as unknown as ServerResponse, headers: { A: "b" } }, 600, NOW);
    reg.cancel(new Error("agent said no"));
    await expect(reg.done).rejects.toThrow(/agent said no/);
    expect(sink.headers.A).toBeUndefined();
    expect(svc.size).toBe(0);

    const r2 = svc.registerDownload({ serverId: "s1", appId: "a", size: 5, sink: new FakeRes() as unknown as ServerResponse, headers: {} }, 10, NOW);
    const r3 = svc.registerUpload({ serverId: "s1", appId: "a", stagedPath: "/x", size: 1, sha256: "" }, 10, NOW);
    expect(svc.size).toBe(2);
    svc.sweep(NOW + 20_000);
    await expect(r2.done).rejects.toThrow(/expired/);
    expect(svc.size).toBe(0);
    svc.release(r3.id); // idempotent
  });
});
