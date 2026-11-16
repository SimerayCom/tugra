import { DARK_PROBE_MAX_HOSTS, buildDarkProbeScript, classifyDarkHost, parseDarkProbe } from "./dark-probe";
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
    expect(() => buildDarkProbeScript({ hosts: Array.from({ length: DARK_PROBE_MAX_HOSTS + 1 }, (_, i) => `h${i}.example.com`), path: "/" })).toThrow();
  });
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
