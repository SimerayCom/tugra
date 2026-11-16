import { ConflictException, PayloadTooLargeException, UnsupportedMediaTypeException } from "@nestjs/common";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { CutoverCertService, CERTS_MAX_BODY, nameCovers } from "./cutover-cert.service";

let dir: string;
const OP = { opId: "op1", actorId: "u1", expiresAt: new Date() };

function mk(name: string, days: number, otherKeyFrom?: string) {
  const key = path.join(dir, `${name}.key`);
  const crt = path.join(dir, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", String(days), "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name},DNS:www.${name}`], { stdio: "ignore" });
  return { certPem: fs.readFileSync(crt, "utf8"), keyPem: fs.readFileSync(otherKeyFrom ? path.join(dir, `${otherKeyFrom}.key`) : key, "utf8") };
}
let good: ReturnType<typeof mk>;
let mismatch: ReturnType<typeof mk>;
let unrelated: ReturnType<typeof mk>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-cert-"));
  good = mk("a.example.com", 90);
  unrelated = mk("nope.example.org", 90);
  mk("zz.example.com", 90);
  mismatch = mk("m.example.com", 90, "zz.example.com");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function req(body: unknown, headers: Record<string, string> = { "content-type": "application/octet-stream" }) {
  const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const r = Readable.from([buf]) as unknown as Readable & { headers: Record<string, string> };
  r.headers = { ...headers, "content-length": String(buf.length) };
  return r;
}

function make(over: { appsHosts?: string[]; staged?: Array<Record<string, unknown>>; entries?: Array<{ hostname: string; applicationId: string; state: string }>; srv?: { swarmRole: string | null } } = {}) {
  const upserts: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
  const prisma = {
    bulkTask: { findMany: jest.fn(async () => [{ resourceId: "app1" }]) },
    application: {
      findMany: jest.fn(async (a: { select: Record<string, boolean> }) =>
        a.select.domain ? [{ id: "app1", domain: (over.appsHosts ?? ["a.example.com"])[0], extraDomains: (over.appsHosts ?? ["a.example.com"]).slice(1) }] : [{ id: "app1", teamId: "t1", serverId: "srv1", clusterId: null }]),
    },
    appServiceDomain: { findMany: jest.fn(async () => []) },
    cutoverCert: {
      upsert: jest.fn(async (a: { create: Record<string, unknown>; update: Record<string, unknown> }) => (upserts.push(a), {})),
      findMany: jest.fn(async () => over.staged ?? []),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    cutoverDomain: { findMany: jest.fn(async () => over.entries ?? [{ hostname: "a.example.com", applicationId: "app1", state: "READY" }]) },
    server: { findUnique: jest.fn(async () => over.srv ?? { swarmRole: null }) },
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const crypto = { encrypt: jest.fn((s: string) => `ENC(${s.length})`), decrypt: jest.fn(() => good.keyPem) };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined) };
  const sent: string[] = [];
  const agentWs = {
    sendCommand: jest.fn(async (_s: string, cmd: string) => {
      sent.push(cmd);
      if (cmd.includes("docker stop")) return { exitCode: 0, output: `TUGRA_ACME_SIZE=0\n` };
      return { exitCode: 0, output: "TUGRA_ACME_SEED ok n=1" };
    }),
  };
  const proxy = { ensureProxy: jest.fn().mockResolvedValue(undefined) };
  const executor = { loadIngestOp: jest.fn().mockResolvedValue({}), ownedOpForCutover: jest.fn().mockResolvedValue({}) };
  const svc = new CutoverCertService(prisma as never, audit as never, crypto as never, access as never, agentWs as never, proxy as never, executor as never);
  return { svc, prisma, audit, crypto, agentWs, proxy, sent, upserts, executor };
}

describe("CutoverCertService.wanted", () => {
  it("is derived from the op's imported apps, never from the caller", async () => {
    const m = make({ appsHosts: ["a.example.com", "www.a.example.com"] });
    expect(await m.svc.wanted(OP)).toEqual({ hosts: ["a.example.com", "www.a.example.com"] });
    expect(m.executor.loadIngestOp).toHaveBeenCalledWith("op1", "u1");
  });

  it("includes the hosts of imported compose services: their tasks are read like the apps' (kind app or service)", async () => {
    const m = make({ appsHosts: ["a.example.com"] });
    await m.svc.wanted(OP);
    expect(m.prisma.bulkTask.findMany).toHaveBeenCalledWith({ where: { opId: "op1", kind: { in: ["app", "service"] }, status: "DONE", resourceType: "application" }, select: { resourceId: true } });
  });
});

describe("CutoverCertService.stage", () => {
  it("accepts a valid cert, encrypts the key, stores no plaintext key and returns counts only", async () => {
    const m = make();
    const res = await m.svc.stage(OP, req({ certs: [{ main: "a.example.com", sans: ["www.a.example.com"], ...good }] }));
    expect(res).toEqual({ accepted: 1, rejected: [] });
    const up = m.upserts[0];
    expect(up.create.keyEnc).toMatch(/^ENC\(/);
    expect(JSON.stringify(up)).not.toContain("PRIVATE KEY");
    expect(up.create.hosts).toEqual(expect.arrayContaining(["a.example.com", "www.a.example.com"]));
    expect(JSON.stringify(m.audit.log.mock.calls)).not.toContain("BEGIN");
    // a re-run refreshes the cert but never rewrites the (possibly purged) key
    expect(up.update).not.toHaveProperty("keyEnc");
  });

  it("derives the stored hosts from the certificate names only: a source-supplied sans claim is ignored", async () => {
    const m = make();
    const res = await m.svc.stage(OP, req({ certs: [{ main: "a.example.com", sans: ["app.victim.com", "x".repeat(300)], ...good }] }));
    expect(res.accepted).toBe(1);
    expect(m.upserts[0].create.hosts).toEqual(["a.example.com", "www.a.example.com"]);
    // a claimed san cannot make an unrelated cert match an app of this op
    const n = make();
    const rej = await n.svc.stage(OP, req({ certs: [{ main: "nope.example.org", sans: ["a.example.com"], ...unrelated }] }));
    expect(rej.rejected).toEqual([{ main: "nope.example.org", reason: "no-matching-app" }]);
    expect(n.upserts).toHaveLength(0);
  });

  it("rejects with fixed reasons: expired, key-mismatch, no-matching-app, malformed, too-large", async () => {
    const m = make();
    const longKey = "x".repeat(70 * 1024);
    const res = await m.svc.stage(
      OP,
      req({
        certs: [
          { main: "m.example.com", ...mismatch },
          { main: "nope.example.org", ...unrelated },
          { main: "a.example.com", certPem: "garbage", keyPem: good.keyPem },
          { main: "a.example.com", certPem: good.certPem, keyPem: longKey },
          { main: "bad host", certPem: good.certPem, keyPem: good.keyPem },
          { main: "a.example.com", certPem: good.certPem },
        ],
      }),
    );
    expect(res.accepted).toBe(0);
    expect(res.rejected.map((r) => r.reason)).toEqual(["key-mismatch", "no-matching-app", "malformed", "too-large", "malformed", "malformed"]);
  });

  it("rejects an expired certificate", async () => {
    const key = path.join(dir, "exp.key");
    const crt = path.join(dir, "exp.crt");
    const cnf = path.join(dir, "ca.cnf");
    fs.writeFileSync(cnf, "[ca]\ndefault_ca=c\n[c]\ndir=" + dir + "\ndatabase=" + dir + "/idx\nnew_certs_dir=" + dir + "\nserial=" + dir + "/serial\ndefault_md=sha256\npolicy=p\n[p]\ncommonName=supplied\n[v]\nsubjectAltName=DNS:a.example.com\n");
    fs.writeFileSync(path.join(dir, "idx"), "");
    fs.writeFileSync(path.join(dir, "serial"), "01\n");
    try {
      execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", `${crt}.csr`, "-subj", "/CN=a.example.com"], { stdio: "ignore" });
      execFileSync("openssl", ["ca", "-config", cnf, "-selfsign", "-keyfile", key, "-in", `${crt}.csr`, "-out", crt, "-startdate", "20200101000000Z", "-enddate", "20200102000000Z", "-batch", "-extensions", "v", "-notext"], { stdio: "ignore" });
    } catch {
      return; // this openssl build cannot backdate; the expiry rule is also covered by the merge tests
    }
    const m = make();
    const res = await m.svc.stage(OP, req({ certs: [{ main: "a.example.com", certPem: fs.readFileSync(crt, "utf8"), keyPem: fs.readFileSync(key, "utf8") }] }));
    expect(res.rejected).toEqual([{ main: "a.example.com", reason: "expired" }]);
  });

  it("enforces the content type and the 2 MiB cap", async () => {
    const m = make();
    await expect(m.svc.stage(OP, req({ certs: [] }, { "content-type": "application/json" }))).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    const big = Readable.from([Buffer.alloc(CERTS_MAX_BODY + 10)]) as unknown as Readable & { headers: Record<string, string> };
    big.headers = { "content-type": "application/octet-stream" };
    await expect(m.svc.stage(OP, big)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});

describe("nameCovers", () => {
  it("matches exact and one-label wildcards only", () => {
    expect(nameCovers("a.com", "a.com")).toBe(true);
    expect(nameCovers("*.a.com", "x.a.com")).toBe(true);
    expect(nameCovers("*.a.com", "x.y.a.com")).toBe(false);
    expect(nameCovers("*.a.com", "a.com")).toBe(false);
  });
});

describe("CutoverCertService.seed", () => {
  const staged = [{ id: "c1", hosts: ["a.example.com", "www.a.example.com"], certPem: "", keyEnc: "ENC", notAfter: new Date() }];
  const stagedReal = () => [{ ...staged[0], certPem: good.certPem }];

  it("stops the proxy, merges into acme.json, writes it, ALWAYS recreates the proxy and purges the key", async () => {
    const m = make({ staged: stagedReal() });
    const r = await m.svc.seed("u1", "op1", { acknowledgeProxyRestart: true });
    expect(r).toEqual({ applied: 1 });
    expect(m.sent[0]).toContain("docker stop tugra-proxy");
    expect(m.sent[1]).toContain("acme.json.tmp");
    expect(m.proxy.ensureProxy).toHaveBeenCalledWith("srv1", { force: true });
    expect(m.prisma.cutoverCert.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: expect.objectContaining({ keyEnc: "", appliedServerId: "srv1" }) });
  });

  it("recreates the proxy even when reading or writing fails, and keeps the staged key", async () => {
    const m = make({ staged: stagedReal() });
    m.agentWs.sendCommand.mockResolvedValueOnce({ exitCode: 0, output: "garbage" });
    await expect(m.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).rejects.toBeInstanceOf(ConflictException);
    expect(m.proxy.ensureProxy).toHaveBeenCalledWith("srv1", { force: true });
    expect(m.prisma.cutoverCert.update).not.toHaveBeenCalled();
  });

  it("fails closed when the target acme.json read is truncated: nothing is written, the proxy is still recreated", async () => {
    const m = make({ staged: stagedReal() });
    m.agentWs.sendCommand.mockResolvedValueOnce({ exitCode: 0, output: "TUGRA_ACME_SIZE=90000\nTUGRA_ACME_B64_BEGIN\nAAAA\n…(truncated)" });
    await expect(m.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).rejects.toThrow(/could not be read completely/);
    expect(m.agentWs.sendCommand).toHaveBeenCalledTimes(1);
    expect(m.sent.some((c) => c.includes("acme.json.tmp"))).toBe(false);
    expect(m.proxy.ensureProxy).toHaveBeenCalledWith("srv1", { force: true });
    expect(m.prisma.cutoverCert.update).not.toHaveBeenCalled();
  });

  describe("large acme.json (read in chunks)", () => {
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    /** A pretty-printed store well beyond the agent's 64 KiB output cap, holding an ACME account and filler certs. */
    const bigStore = () => {
      const certs = Array.from({ length: 12 }, (_, i) => ({ domain: { main: `other${i}.example.net` }, certificate: "A".repeat(8000), key: "B".repeat(3000) }));
      return Buffer.from(JSON.stringify({ le: { Account: { Email: "ops@example.net", PrivateKey: "ACCOUNT-KEY" }, Certificates: certs } }, null, 2), "utf8");
    };
    function mockFile(m: ReturnType<typeof make>, file: Buffer, over: { chunkOutput?: (n: number, real: string) => string; sha?: string } = {}) {
      let n = 0;
      m.agentWs.sendCommand.mockImplementation(async (_s: string, cmd: string) => {
        m.sent.push(cmd);
        if (cmd.includes("docker stop")) return { exitCode: 0, output: `TUGRA_ACME_SIZE=${file.length}\nTUGRA_ACME_SHA256=${over.sha ?? sha(file)}\n` };
        const rng = /tail -c \+(\d+) .* \| head -c (\d+) /.exec(cmd);
        if (rng) {
          const real = `${file.subarray(Number(rng[1]) - 1, Number(rng[1]) - 1 + Number(rng[2])).toString("base64")}\nTUGRA_ACME_CHUNK_END\n`;
          return { exitCode: 0, output: over.chunkOutput ? over.chunkOutput(n++, real) : real };
        }
        return { exitCode: 0, output: "TUGRA_ACME_SEED ok n=1" };
      });
    }

    it("reassembles the chunks, verifies them and merges without losing the account or the other certs", async () => {
      const file = bigStore();
      expect(file.length).toBeGreaterThan(64 * 1024);
      const m = make({ staged: stagedReal() });
      mockFile(m, file);
      expect(await m.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).toEqual({ applied: 1 });
      const chunkCmds = m.sent.filter((c) => c.includes("tail -c"));
      expect(chunkCmds.length).toBe(Math.ceil(file.length / (36 * 1024)));
      const write = m.sent.find((c) => c.includes("acme.json.tmp"))!;
      const written = JSON.parse(Buffer.from(/printf %s '([^']+)'/.exec(write)![1], "base64").toString("utf8"));
      expect(written.le.Account.PrivateKey).toBe("ACCOUNT-KEY");
      expect(written.le.Certificates).toHaveLength(13);
      expect(written.le.Certificates.some((c: { domain: { main: string } }) => c.domain.main === "a.example.com")).toBe(true);
      expect(m.proxy.ensureProxy).toHaveBeenCalledWith("srv1", { force: true });
    });

    it.each([
      ["a truncated chunk", (_n: number, real: string) => real.slice(0, 2000) + "\n…(truncated)"],
      ["a chunk without its end marker", (_n: number, real: string) => real.replace("TUGRA_ACME_CHUNK_END\n", "")],
      ["a short chunk", (n: number, real: string) => (n === 1 ? "AAAA\nTUGRA_ACME_CHUNK_END\n" : real)],
    ])("refuses %s and writes nothing", async (_name, chunkOutput) => {
      const m = make({ staged: stagedReal() });
      mockFile(m, bigStore(), { chunkOutput });
      await expect(m.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).rejects.toThrow(/could not be read completely/);
      expect(m.sent.some((c) => c.includes("acme.json.tmp"))).toBe(false);
      expect(m.proxy.ensureProxy).toHaveBeenCalledWith("srv1", { force: true });
    });

    it("refuses a reassembled store whose sha256 differs from the probe", async () => {
      const m = make({ staged: stagedReal() });
      mockFile(m, bigStore(), { sha: "0".repeat(64) });
      await expect(m.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).rejects.toThrow(/could not be read completely/);
      expect(m.sent.some((c) => c.includes("acme.json.tmp"))).toBe(false);
    });
  });

  it("requires the proxy-restart acknowledgement, and refuses swarm nodes and an empty stage", async () => {
    const m = make({ staged: stagedReal() });
    await expect(m.svc.seed("u1", "op1", { acknowledgeProxyRestart: false })).rejects.toThrow(/acknowledgeProxyRestart/);
    expect(m.agentWs.sendCommand).not.toHaveBeenCalled();
    const s = make({ staged: stagedReal(), srv: { swarmRole: "MANAGER" } });
    await expect(s.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).rejects.toThrow(/swarm/);
    const e = make({ staged: [] });
    await expect(e.svc.seed("u1", "op1", { acknowledgeProxyRestart: true })).rejects.toThrow(/no staged/);
  });

  it("purge blanks every staged key of an op", async () => {
    const m = make();
    await m.svc.purge("op1");
    expect(m.prisma.cutoverCert.updateMany).toHaveBeenCalledWith({ where: { opId: "op1" }, data: { keyEnc: "" } });
  });
});
