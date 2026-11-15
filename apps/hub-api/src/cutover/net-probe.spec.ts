import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { NetProbe, assertProbeIp, probeHttpAt, probeSslAt } from "./net-probe";

let dir: string;
const sh = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore", cwd: dir });
const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");

/** A leaf signed by the test CA (SAN = names, CN = cn). */
function leaf(name: string, cn: string, names: string[]) {
  sh(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${cn}`]);
  fs.writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}\n`);
  sh(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "30", "-extfile", `${name}.ext`]);
  return { key: read(`${name}.key`), cert: read(`${name}.crt`) };
}

let tlsServer: tls.Server;
let port: number;
const sniSeen: string[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-probe-"));
  sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "30", "-subj", "/CN=test-ca"]);
  const good = leaf("good", "good.example.com", ["good.example.com", "www.good.example.com"]);
  const other = leaf("other", "other.example.com", ["other.example.com"]);
  const dflt = leaf("dflt", "TRAEFIK DEFAULT CERT", ["traefik.default"]);
  sh(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "self.key", "-out", "self.crt", "-days", "30", "-subj", "/CN=self.example.com", "-addext", "subjectAltName=DNS:self.example.com"]);
  const self = { key: read("self.key"), cert: read("self.crt") };
  const ctx = (c: { key: string; cert: string }) => tls.createSecureContext(c);
  const byName: Record<string, tls.SecureContext> = {
    "good.example.com": ctx(good), "www.good.example.com": ctx(good), "other.example.com": ctx(other), "self.example.com": ctx(self),
    // a router with no cert yet: Traefik serves its default cert; "wrong.example.com" gets another host's cert
    "wrong.example.com": ctx(other),
  };
  tlsServer = tls.createServer({ ...dflt, SNICallback: (name, cb) => { sniSeen.push(name); cb(null, byName[name] ?? ctx(dflt)); } }, (s) => s.end("x"));
  await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
  port = (tlsServer.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => tlsServer.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("probeSslAt", () => {
  it("ok: a trusted cert for the SNI name, with expiry and SANs", async () => {
    const p = await probeSslAt("127.0.0.1", "good.example.com", { port, ca: read("ca.crt") });
    expect(p.ok).toBe(true);
    expect(p.sans).toEqual(expect.arrayContaining(["good.example.com", "www.good.example.com"]));
    expect(p.daysRemaining).toBeGreaterThanOrEqual(28);
    expect(p.issuer).toBe("test-ca");
  });
  it("SNI picks the right certificate", async () => {
    await probeSslAt("127.0.0.1", "other.example.com", { port, ca: read("ca.crt") });
    expect(sniSeen).toContain("other.example.com");
    const p = await probeSslAt("127.0.0.1", "other.example.com", { port, ca: read("ca.crt") });
    expect(p.subjectCN).toBe("other.example.com");
  });
  it("default-cert: Traefik's placeholder certificate", async () => {
    const p = await probeSslAt("127.0.0.1", "new.example.com", { port, ca: read("ca.crt") });
    expect(p).toMatchObject({ ok: false, reason: "default-cert", subjectCN: "TRAEFIK DEFAULT CERT" });
  });
  it("wrong-host: a valid cert for another name", async () => {
    expect((await probeSslAt("127.0.0.1", "wrong.example.com", { port, ca: read("ca.crt") })).reason).toBe("wrong-host");
  });
  it("untrusted: a self-signed leaf", async () => {
    expect((await probeSslAt("127.0.0.1", "self.example.com", { port, ca: read("ca.crt") })).reason).toBe("untrusted");
  });
  it("connect: nothing listening", async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const closed = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    expect((await probeSslAt("127.0.0.1", "a.example.com", { port: closed, timeoutMs: 1500 })).reason).toBe("connect");
  });
  it("timeout: a peer that never answers the handshake", async () => {
    const s = net.createServer((c) => c.on("error", () => undefined));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = await probeSslAt("127.0.0.1", "a.example.com", { port: (s.address() as net.AddressInfo).port, timeoutMs: 300 });
    s.close();
    expect(p.reason).toBe("timeout");
  });
});

describe("probeHttpAt", () => {
  let srv: http.Server;
  let hport: number;
  const hostsSeen: Array<string | undefined> = [];
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      hostsSeen.push(req.headers.host);
      if (req.url === "/redir") {
        res.writeHead(301, { Location: "https://elsewhere.example.com/" }).end();
      } else if (req.url === "/traefik") {
        res.writeHead(404).end("404 page not found\n");
      } else if (req.url === "/app404") {
        res.writeHead(404).end("<html>not here</html>");
      } else if (req.url === "/big") {
        res.writeHead(200);
        const iv = setInterval(() => res.write("x".repeat(2048)), 1);
        res.on("close", () => clearInterval(iv));
      } else res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    hport = (srv.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });
  it("sends the Host header and reports the status", async () => {
    expect(await probeHttpAt("127.0.0.1", "app.example.com", { tls: false, port: hport })).toMatchObject({ status: 200 });
    expect(hostsSeen).toContain("app.example.com");
  });
  it("does not follow redirects and surfaces the Location", async () => {
    expect(await probeHttpAt("127.0.0.1", "a.example.com", { tls: false, port: hport, path: "/redir" })).toMatchObject({ status: 301, location: "https://elsewhere.example.com/" });
  });
  it("recognises Traefik's own 404 body but not an app 404", async () => {
    expect((await probeHttpAt("127.0.0.1", "a.example.com", { tls: false, port: hport, path: "/traefik" })).traefik404).toBe(true);
    expect((await probeHttpAt("127.0.0.1", "a.example.com", { tls: false, port: hport, path: "/app404" })).traefik404).toBe(false);
  });
  it("aborts an endless body after 4 KiB", async () => {
    const t0 = Date.now();
    expect((await probeHttpAt("127.0.0.1", "a.example.com", { tls: false, port: hport, path: "/big", timeoutMs: 5000 })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
  it("reports a connection failure as status null", async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const closed = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    expect(await probeHttpAt("127.0.0.1", "a.example.com", { tls: false, port: closed, timeoutMs: 1500 })).toMatchObject({ status: null });
  });
});

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1", "0.0.0.0", "not-an-ip", "100.64.0.1"])("refuses %s before connecting", async (ip) => {
    expect(() => assertProbeIp(ip)).toThrow(/non-public/);
    const p = new NetProbe();
    expect(() => p.sslAt(ip, "a.example.com")).toThrow(/non-public/);
    expect(() => p.httpAt(ip, "a.example.com", { tls: true })).toThrow(/non-public/);
  });
  it("accepts a public address", () => {
    expect(() => assertProbeIp("203.0.113.7")).not.toThrow();
    expect(() => assertProbeIp("2606:4700::1111")).not.toThrow();
  });
});
