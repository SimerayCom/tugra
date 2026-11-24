import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Monitor } from "@prisma/client";
import {
  applyUpsideDown,
  dnsAnswers,
  dnsCheck,
  httpCheck,
  metricCheckResult,
  parseStatusRanges,
  pingCheck,
  statusAccepted,
  tcpCheck,
} from "./checkers";

const monitor = (target: string): Monitor =>
  ({
    id: "m",
    teamId: "t",
    name: "n",
    type: "HTTP",
    target,
    intervalSec: 30,
    retries: 1,
    timeoutMs: 5000,
    resendEvery: 0,
    status: "PENDING",
    failCount: 0,
    downCount: 0,
    enabled: true,
    method: null,
    keyword: null,
    keywordInvert: false,
    acceptedStatus: [],
    ignoreTls: false,
    maxRedirects: 10,
    upsideDown: false,
    dnsRecordType: null,
    dnsServer: null,
    dnsExpect: null,
    createdAt: new Date(),
  }) as unknown as Monitor;

describe("httpCheck", () => {
  let server: http.Server;
  let base = "";
  const seen: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
        const url = req.url ?? "/";
        if (url.startsWith("/status/")) {
          res.statusCode = Number(url.slice("/status/".length));
          return res.end("status");
        }
        if (url === "/redirect") {
          res.statusCode = 302;
          res.setHeader("location", "/ok");
          return res.end();
        }
        if (url === "/xhost") {
          res.statusCode = 307;
          res.setHeader("location", `http://127.0.0.1:${(server.address() as AddressInfo).port}/ok`);
          return res.end();
        }
        if (url === "/loop") {
          res.statusCode = 302;
          res.setHeader("location", "/loop");
          return res.end();
        }
        res.statusCode = 200;
        res.end("hello world, all systems operational");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
  });

  it("is up on a 2xx response", async () => {
    const r = await httpCheck(monitor(`${base}/ok`));
    expect(r.up).toBe(true);
    expect(r.msg).toBe("HTTP 200");
  });

  it("is down on a 5xx response", async () => {
    const r = await httpCheck(monitor(`${base}/status/503`));
    expect(r.up).toBe(false);
    expect(r.msg).toBe("HTTP 503");
    expect(r.cause).toBeUndefined();
  });

  it("is down when the connection is refused", async () => {
    const r = await httpCheck(monitor("http://127.0.0.1:1"));
    expect(r.up).toBe(false);
    expect(r.msg).toContain("ECONNREFUSED");
  });

  it("honors accepted status codes and ranges", async () => {
    const m = { ...monitor(`${base}/status/401`), acceptedStatus: ["200-299", "401"] };
    expect((await httpCheck(m)).up).toBe(true);
    const n = { ...monitor(`${base}/status/404`), acceptedStatus: ["200-299", "401"] };
    expect((await httpCheck(n)).up).toBe(false);
  });

  it("follows redirects and gives up on a loop", async () => {
    expect((await httpCheck(monitor(`${base}/redirect`))).up).toBe(true);
    const loop = await httpCheck({ ...monitor(`${base}/loop`), maxRedirects: 3 });
    expect(loop.up).toBe(false);
    expect(loop.msg).toBe("too many redirects");
  });

  it("with maxRedirects 0 judges the redirect response itself", async () => {
    const m = { ...monitor(`${base}/redirect`), maxRedirects: 0, acceptedStatus: ["302"] };
    expect(await httpCheck(m)).toMatchObject({ up: true, msg: "HTTP 302" });
  });

  it("sends the method, headers, basic auth and body", async () => {
    const m = { ...monitor(`${base}/ok`), method: "POST" };
    const r = await httpCheck(m, { headers: { "X-Probe": "1" }, basicAuth: { user: "u", pass: "p" }, body: "ping" });
    expect(r.up).toBe(true);
    const req = seen[0];
    expect(req.method).toBe("POST");
    expect(req.headers["x-probe"]).toBe("1");
    expect(req.headers.authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(req.body).toBe("ping");
  });

  it("does not forward custom headers, credentials or the body to another host on a redirect", async () => {
    const port = base.split(":").pop();
    const m = { ...monitor(`http://localhost:${port}/xhost`), method: "POST" };
    const r = await httpCheck(m, { headers: { "X-Api-Key": "k", Accept: "*/*" }, basicAuth: { user: "u", pass: "p" }, body: "secret" });
    expect(r.up).toBe(true);
    const last = seen[seen.length - 1];
    expect(last.headers["x-api-key"]).toBeUndefined();
    expect(last.headers.authorization).toBeUndefined();
    expect(last.body).toBe("");
    expect(last.headers.accept).toBe("*/*");
  });

  it("KEYWORD: up when the body contains it, down when it does not", async () => {
    const found = { ...monitor(`${base}/ok`), type: "KEYWORD", keyword: "operational" } as Monitor;
    expect((await httpCheck(found)).up).toBe(true);
    const missing = { ...monitor(`${base}/ok`), type: "KEYWORD", keyword: "maintenance" } as Monitor;
    const r = await httpCheck(missing);
    expect(r.up).toBe(false);
    expect(r.msg).toBe("HTTP 200, keyword not found");
  });

  it("KEYWORD inverted: down when the keyword is present", async () => {
    const m = { ...monitor(`${base}/ok`), type: "KEYWORD", keyword: "operational", keywordInvert: true } as Monitor;
    const r = await httpCheck(m);
    expect(r.up).toBe(false);
    expect(r.msg).toBe("HTTP 200, keyword present");
  });

  it.each([520, 521, 522, 523, 524, 525, 526])("labels Cloudflare %i as a Cloudflare <-> origin failure", async (code) => {
    const r = await httpCheck(monitor(`${base}/status/${code}`));
    expect(r.up).toBe(false);
    expect(r.cause).toBe(`cf:${code}`);
    expect(r.msg).toBe(`HTTP ${code} (Cloudflare <-> origin)`);
  });
});

describe("status helpers", () => {
  it("parses ranges and singles, ignoring junk", () => {
    expect(parseStatusRanges(["200-299", "301", "x", "500-400"])).toEqual([[200, 299], [301, 301]]);
  });

  it("defaults to 2xx/3xx when no list is given", () => {
    expect(statusAccepted(200, [])).toBe(true);
    expect(statusAccepted(399, undefined)).toBe(true);
    expect(statusAccepted(400, [])).toBe(false);
  });

  it("applyUpsideDown flips the verdict and drops the cause when it becomes UP", () => {
    expect(applyUpsideDown({ up: true, ms: 5, msg: "HTTP 200" })).toMatchObject({ up: false, msg: "HTTP 200 (inverted)" });
    const flipped = applyUpsideDown({ up: false, ms: 5, msg: "HTTP 522", cause: "cf:522" });
    expect(flipped.up).toBe(true);
    expect(flipped.cause).toBeNull();
  });
});

describe("tcp / ping / dns checks", () => {
  it("tcpCheck is up against a listening port", async () => {
    const srv = net.createServer((s) => s.end());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const r = await tcpCheck({ ...monitor(`127.0.0.1:${port}`), type: "TCP" } as Monitor);
    srv.close();
    expect(r.up).toBe(true);
  });

  it("pingCheck refuses a host that could be read as an option", async () => {
    const r = await pingCheck({ ...monitor("-f"), type: "PING" } as Monitor);
    expect(r).toMatchObject({ up: false, msg: "invalid host" });
  });

  it("dnsCheck rejects an unsupported record type without querying", async () => {
    const r = await dnsCheck({ ...monitor("example.com"), type: "DNS", dnsRecordType: "ANY" } as Monitor);
    expect(r.up).toBe(false);
    expect(r.msg).toContain("unsupported record type");
  });

  it("dnsAnswers flattens MX, SRV and TXT answers", () => {
    expect(dnsAnswers("MX", [{ priority: 10, exchange: "mx.example.com" }])).toEqual(["10 mx.example.com"]);
    expect(dnsAnswers("SRV", [{ priority: 1, weight: 2, port: 443, name: "h.example.com" }])).toEqual(["1 2 443 h.example.com"]);
    expect(dnsAnswers("TXT", [["v=spf1 ", "-all"]])).toEqual(["v=spf1 -all"]);
    expect(dnsAnswers("A", ["192.0.2.1"])).toEqual(["192.0.2.1"]);
  });
});

describe("metricCheckResult", () => {
  const sample = { cpu: 30, memUsed: 6, memTotal: 10, diskUsed: 85, diskTotal: 100 };

  it("alarms (down) when disk usage >= threshold", () => {
    const r = metricCheckResult("DISK", sample, 80);
    expect(r.up).toBe(false);
    expect(r.msg).toBe("DISK 85% (limit 80%)");
  });

  it("is up when below threshold", () => {
    expect(metricCheckResult("DISK", sample, 90).up).toBe(true);
  });

  it("computes CPU and MEM percentages", () => {
    expect(metricCheckResult("CPU", sample, 25).up).toBe(false); // 30 >= 25
    expect(metricCheckResult("MEM", sample, 50).up).toBe(false); // 60% >= 50
    expect(metricCheckResult("MEM", sample, 70).up).toBe(true); // 60% < 70
  });

  it("no sample → up (no false alarm before metrics arrive)", () => {
    const r = metricCheckResult("DISK", null, 80);
    expect(r.up).toBe(true);
    expect(r.msg).toContain("no metrics");
  });
});

describe("metricCheckResult — freshness gate (F03)", () => {
  const sample = { cpu: 1, memUsed: 1, memTotal: 100, diskUsed: 1, diskTotal: 100 }; // well below any threshold
  const NOW = 1_000_000_000_000;
  const aged = (ageMs: number) => metricCheckResult("DISK", sample, 80, { ts: NOW - ageMs, now: NOW, maxAgeMs: 90_000 });

  it("a sample within maxAge is evaluated normally (fresh low → up)", () => {
    expect(aged(89_000).up).toBe(true);
  });
  it("a sample older than maxAge is a failure, not a recovery", () => {
    expect(aged(91_000).up).toBe(false);
    expect(aged(91_000).msg).toContain("stale");
  });
  it("a future-dated sample beyond the 60s skew tolerance is a failure", () => {
    expect(metricCheckResult("DISK", sample, 80, { ts: NOW + 61_000, now: NOW, maxAgeMs: 90_000 }).up).toBe(false);
  });
  it("accepts both Date and numeric timestamps", () => {
    expect(metricCheckResult("DISK", sample, 80, { ts: new Date(NOW - 5_000), now: NOW, maxAgeMs: 90_000 }).up).toBe(true);
  });
  it("fails CLOSED on an unknown sample age (null/NaN ts) once freshness is requested", () => {
    expect(metricCheckResult("DISK", sample, 80, { ts: null, now: NOW, maxAgeMs: 90_000 }).up).toBe(false);
    expect(metricCheckResult("DISK", sample, 80, { ts: NaN, now: NOW, maxAgeMs: 90_000 }).up).toBe(false);
  });
  it("a null sample fails when noDataIsDown, but is 'no metrics yet' (UP) otherwise", () => {
    expect(metricCheckResult("DISK", null, 80, { now: NOW, maxAgeMs: 90_000, noDataIsDown: true }).up).toBe(false);
    expect(metricCheckResult("DISK", null, 80, { now: NOW, maxAgeMs: 90_000, noDataIsDown: false }).up).toBe(true);
  });
  it("keeps the legacy pure-threshold behaviour when freshness is omitted entirely", () => {
    expect(metricCheckResult("DISK", sample, 80).up).toBe(true); // no freshness arg → threshold only
  });
});
