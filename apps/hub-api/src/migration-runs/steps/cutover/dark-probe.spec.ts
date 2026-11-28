import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DARK_PROBE_CHUNK, DARK_PROBE_MAX_HOSTS, buildDarkProbeScript, classifyDarkHost, darkProbeChunks, parseDarkProbe } from "./dark-probe";
import { expectGolden } from "./testing/golden";

const hosts = ["a.example.com", "b.example.com"];
const line = (h: string, verify: string, status: string, t = "0") => `TUGRA_DARK_PROBE host=${h} verify=${verify} status=${status} traefik404=${t}`;

describe("buildDarkProbeScript", () => {
  it("golden: targets the Tugra proxy container address, never loopback", () => {
    const s = buildDarkProbeScript({ hosts, path: "/health" });
    expectGolden("dark-probe.sh", s);
    expect(s).toContain("--resolve");
    expect(s).not.toContain("127.0.0.1");
    expect(s).toContain("container inspect");
    expect(s).toContain("tugra-proxy");
  });

  it("prints markers only: the response body is written to a temp file and never echoed", () => {
    const s = buildDarkProbeScript({ hosts, path: "/" });
    expect(s).toContain('-o "$T"');
    expect(s).not.toMatch(/cat "\$T"/);
  });

  it("rejects an injection through a host or the path, and an empty or oversized host list", () => {
    expect(() => buildDarkProbeScript({ hosts: ["a.example.com'; rm -rf /; '"], path: "/" })).toThrow();
    expect(() => buildDarkProbeScript({ hosts: ["a.example.com"], path: "/x y" })).toThrow();
    expect(() => buildDarkProbeScript({ hosts: ["a.example.com"], path: "/$(id)" as string })).not.toThrow(); // printable ASCII; shq()-quoted
    expect(buildDarkProbeScript({ hosts: ["a.example.com"], path: "/$(id)" })).toContain("P='/$(id)'");
    expect(() => buildDarkProbeScript({ hosts: [], path: "/" })).toThrow();
    expect(() => buildDarkProbeScript({ hosts: Array.from({ length: DARK_PROBE_CHUNK + 1 }, (_, i) => `h${i}.example.com`), path: "/" })).toThrow();
  });

  it("a long list is split into commands of at most DARK_PROBE_CHUNK hosts (2 x 8 s of timeouts stay far under the command timeout), at most DARK_PROBE_MAX_HOSTS in all", () => {
    const hosts = Array.from({ length: 130 }, (_, i) => `h${i}.example.com`);
    const chunks = darkProbeChunks(hosts);
    expect(chunks.every((c) => c.length > 0 && c.length <= DARK_PROBE_CHUNK)).toBe(true);
    expect(chunks.flat()).toEqual(hosts.slice(0, DARK_PROBE_MAX_HOSTS));
    expect(darkProbeChunks([])).toEqual([]);
    for (const c of chunks) expect(() => buildDarkProbeScript({ hosts: c, path: "/" })).not.toThrow();
  });
});

describe("buildDarkProbeScript, executed (bash, fake docker and curl)", () => {
  let dir: string;
  let bin: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dark-probe-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    const put = (n: string, body: string) => {
      writeFileSync(join(bin, n), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, n), 0o755);
    };
    put("docker", "echo 172.20.0.2 ");
    // every curl takes 2 s (a stand-in for the 8 s timeout): sequentially 2 hosts x 2 curls would need 8 s; in parallel 2 s
    put("curl", [
      'out=""; fmt=""; while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift;; -w) fmt=$2; shift;; esac; shift; done',
      "sleep 2",
      '[ "$out" = /dev/null ] || printf "404 page not found" > "$out"',
      'case "$fmt" in *ssl_verify_result*) printf 0;; *http_code*) printf 200;; esac',
    ].join("\n"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("probes the hosts in parallel and prints one marker line each, in a complete output", () => {
    const hosts = Array.from({ length: 6 }, (_, i) => `h${i}.example.com`);
    const t0 = Date.now();
    const r = spawnSync("bash", ["-c", buildDarkProbeScript({ hosts, path: "/" })], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8" });
    const took = Date.now() - t0;
    const parsed = parseDarkProbe(r.stdout, hosts);
    expect(parsed).toMatchObject({ kind: "ok" });
    if (parsed?.kind === "ok") {
      expect(Object.keys(parsed.hosts).sort()).toEqual([...hosts].sort());
      expect(parsed.hosts["h3.example.com"]).toEqual({ verify: 0, status: 200, traefik404: true });
    }
    // 6 hosts x 2 curls x 2 s = 24 s one after the other; in parallel about 4 s
    expect(took).toBeLessThan(12_000);
  }, 30_000);
});

describe("parseDarkProbe", () => {
  it("parses a complete output and keeps only the hosts that were asked for", () => {
    const out = [line("a.example.com", "0", "200"), line("b.example.com", "21", "200"), line("evil.example.com", "0", "200"), "TUGRA_DARK_PROBE_END"].join("\n");
    const p = parseDarkProbe(out, hosts);
    expect(p).toEqual({ kind: "ok", hosts: { "a.example.com": { verify: 0, status: 200, traefik404: false }, "b.example.com": { verify: 21, status: 200, traefik404: false } } });
  });

  it("a cut output (no END marker, or the agent truncation marker) is null, never a partial pass", () => {
    expect(parseDarkProbe(line("a.example.com", "0", "200"), hosts)).toBeNull();
    expect(parseDarkProbe(`${line("a.example.com", "0", "200")}\nTUGRA_DARK_PROBE_END\n…(truncated)`, hosts)).toBeNull();
  });

  it("no-proxy and unavailable are their own results", () => {
    expect(parseDarkProbe("TUGRA_DARK_PROBE_NOPROXY\n", hosts)).toEqual({ kind: "no-proxy" });
    expect(parseDarkProbe("TUGRA_DARK_PROBE_UNAVAILABLE\n", hosts)).toEqual({ kind: "unavailable" });
  });

  it("status 000 is no answer; a missing verify is unknown", () => {
    const p = parseDarkProbe([line("a.example.com", "x", "000"), "TUGRA_DARK_PROBE_END"].join("\n"), hosts);
    expect(p).toEqual({ kind: "ok", hosts: { "a.example.com": { verify: null, status: null, traefik404: false } } });
  });

  it("a forged marker with a bad shape is ignored", () => {
    const p = parseDarkProbe(["TUGRA_DARK_PROBE host=a.example.com verify=0 status=200 traefik404=1 extra=1", "TUGRA_DARK_PROBE_END"].join("\n"), hosts);
    expect(p).toEqual({ kind: "ok", hosts: {} });
  });
});

describe("classifyDarkHost", () => {
  it("ready needs a verified certificate AND a healthy answer", () => {
    expect(classifyDarkHost({ verify: 0, status: 200, traefik404: false })).toEqual({ tls: "ok", health: "ok", ready: true });
    expect(classifyDarkHost({ verify: 0, status: 302, traefik404: false }).ready).toBe(true);
    expect(classifyDarkHost({ verify: 0, status: 401, traefik404: false }).ready).toBe(true);
  });

  it("a default/untrusted certificate is a TLS failure even when the app answers", () => {
    expect(classifyDarkHost({ verify: 21, status: 200, traefik404: false })).toMatchObject({ tls: "fail", health: "ok", ready: false });
  });

  it("Traefik's own 404 (no router for the host) is not ready; an app 404 is", () => {
    expect(classifyDarkHost({ verify: 0, status: 404, traefik404: true })).toMatchObject({ health: "traefik-404", ready: false });
    expect(classifyDarkHost({ verify: 0, status: 404, traefik404: false }).ready).toBe(true);
  });

  it("no answer is never ready, whatever verify says (a verify of 0 without a connection means nothing)", () => {
    expect(classifyDarkHost({ verify: 0, status: null, traefik404: false })).toMatchObject({ tls: "fail", health: "unreachable", ready: false });
    expect(classifyDarkHost({ verify: null, status: null, traefik404: false })).toMatchObject({ tls: "unknown", ready: false });
    expect(classifyDarkHost(undefined)).toEqual({ tls: "unknown", health: "unknown", ready: false });
  });

  it("a 5xx is not ready", () => {
    expect(classifyDarkHost({ verify: 0, status: 503, traefik404: false }).ready).toBe(false);
  });
});
