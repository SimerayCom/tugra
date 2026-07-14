import { rewriteHostPorts, substituteSelfUrls, type UrlTarget } from "./install-compose";
import type { PortMapping } from "../applications/port-allocator.service";
import type { ExposePort } from "./template-manifest";

const exposure = (over: Partial<ExposePort> & { serviceName: string; containerPort: number }): ExposePort => ({
  defaultMode: "domain",
  public: true,
  ...over,
});

describe("rewriteHostPorts", () => {
  it("rewrites the baked host port in the ports line AND in localhost self-URLs, and returns the mapping", () => {
    const compose = [
      "services:",
      "  gitea:",
      "    image: gitea/gitea",
      "    environment:",
      "      - FQDN_GITEA_3000=localhost:20084",
      "      - GITEA__ROOT_URL=http://localhost:20084/",
      "    ports:",
      '      - "20084:3000"',
      "",
    ].join("\n");
    const { compose: out, portMappings } = rewriteHostPorts(compose, [exposure({ serviceName: "gitea", containerPort: 3000 })], [20500]);
    expect(out).toContain('"20500:3000"'); // ports line rewritten
    expect(out).not.toContain("20084"); // old host port gone everywhere
    expect(out).toContain("localhost:20500"); // self-URLs follow the allocated port
    expect(out).toContain("http://localhost:20500/");
    expect(portMappings).toEqual([{ serviceName: "gitea", containerPort: 3000, hostPort: 20500, mode: "domain" }]);
  });

  it("installing the same template twice yields distinct published ports", () => {
    const compose = 'services:\n  app:\n    image: x\n    ports:\n      - "20001:80"\n';
    const first = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20300]);
    const second = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20301]);
    expect(first.compose).toContain('"20300:80"');
    expect(second.compose).toContain('"20301:80"');
    expect(first.portMappings[0].hostPort).not.toBe(second.portMappings[0].hostPort);
  });

  it("does not corrupt a longer host port that shares a prefix (word boundary on localhost)", () => {
    const compose = 'services:\n  app:\n    environment:\n      - A=localhost:20084\n      - B=localhost:200849\n    ports:\n      - "20084:80"\n';
    const { compose: out } = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500]);
    expect(out).toContain("A=localhost:20500"); // rewritten
    expect(out).toContain("B=localhost:200849"); // NOT corrupted (different port)
  });

  it("anchors the container port so a shorter port never matches a longer one", () => {
    // containerPort 80 must NOT match the ":8080" line
    const compose = 'services:\n  app:\n    ports:\n      - "20001:8080"\n';
    const { compose: out, portMappings } = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500]);
    expect(out).toContain('"20001:8080"'); // untouched (no :80" match)
    expect(portMappings).toEqual([]); // nothing rewritten
  });

  it("is a no-op when there are no exposures (port-less game/system servers)", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const { compose: out, portMappings } = rewriteHostPorts(compose, [], []);
    expect(out).toBe(compose);
    expect(portMappings).toEqual([]);
  });

  it("carries the hostPort mode through from the exposure", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const { portMappings } = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80, defaultMode: "hostPort" })], [20500]);
    expect(portMappings[0].mode).toBe("hostPort");
  });

  it("rewrites a baked localhost port inside a mount's content and returns the rewritten mounts", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const mounts = [{ serviceName: "app", target: "/etc/app.conf", content: "endpoint=localhost:20001\n" }];
    const out = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500], mounts);
    expect(out.mounts).toEqual([{ serviceName: "app", target: "/etc/app.conf", content: "endpoint=localhost:20500\n" }]);
  });

  it("returns mounts unchanged when their content has no baked port reference", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const mounts = [{ serviceName: "app", target: "/etc/app.conf", content: "appendonly yes\n" }];
    const out = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500], mounts);
    expect(out.mounts).toEqual(mounts);
  });

  it("omits the mounts key from the result when none are passed (backward compatible)", () => {
    const compose = 'services:\n  app:\n    ports:\n      - "20001:80"\n';
    const out = rewriteHostPorts(compose, [exposure({ serviceName: "app", containerPort: 80 })], [20500]);
    expect(out).not.toHaveProperty("mounts");
  });
});

describe("substituteSelfUrls", () => {
  const pm = (over: Partial<PortMapping> & { hostPort: number }): PortMapping => ({
    serviceName: "app",
    containerPort: 80,
    mode: "domain",
    ...over,
  });
  const target = (over: Partial<UrlTarget> = {}): UrlTarget => ({
    domain: "app-x.1-2-3-4.sslip.io",
    https: false,
    serverIp: "1.2.3.4",
    web: { service: "app", port: 80 },
    ...over,
  });
  const compose = [
    "services:",
    "  app:",
    "    ports:",
    '      - "20500:80"',
    "    environment:",
    "      - APP_URL=http://localhost:20500/api",
    "      - FQDN=localhost:20500",
    "",
  ].join("\n");

  it("domain mode (primary) → swaps the magic domain, DROPS the port, keeps the trailing path", () => {
    const { compose: out } = substituteSelfUrls(compose, [pm({ hostPort: 20500 })], target());
    expect(out).toContain("APP_URL=http://app-x.1-2-3-4.sslip.io/api"); // http (https:false), no :20500
    expect(out).toContain("FQDN=app-x.1-2-3-4.sslip.io"); // bare fqdn → bare domain
    expect(out).not.toContain("localhost:20500");
    expect(out).toContain('"20500:80"'); // published ports line untouched
  });

  it("uses https for a TLS domain", () => {
    const { compose: out } = substituteSelfUrls(compose, [pm({ hostPort: 20500 })], target({ domain: "d.example.com", https: true }));
    expect(out).toContain("APP_URL=https://d.example.com/api");
  });

  it("hostPort mode → serverIp:hostPort (port KEPT), even when a domain exists", () => {
    const { compose: out } = substituteSelfUrls(compose, [pm({ hostPort: 20500, mode: "hostPort" })], target({ domain: "d.example.com", https: true }));
    expect(out).toContain("APP_URL=http://1.2.3.4:20500/api");
    expect(out).toContain("FQDN=1.2.3.4:20500");
  });

  it("brackets an IPv6 server address", () => {
    const { compose: out } = substituteSelfUrls(compose, [pm({ hostPort: 20500, mode: "hostPort" })], target({ domain: null, serverIp: "2001:db8::1", web: null }));
    expect(out).toContain("APP_URL=http://[2001:db8::1]:20500/api");
    expect(out).toContain("FQDN=[2001:db8::1]:20500");
  });

  it("leaves localhost when there is neither a domain nor a server IP", () => {
    const { compose: out } = substituteSelfUrls(compose, [pm({ hostPort: 20500 })], target({ domain: null, serverIp: null, web: null }));
    expect(out).toContain("APP_URL=http://localhost:20500/api");
  });

  it("never touches an internal healthcheck on the CONTAINER port (keyed on the host port)", () => {
    const c = "services:\n  app:\n    healthcheck:\n      test: curl http://localhost:80/health\n    environment:\n      - APP_URL=http://localhost:20500\n";
    const { compose: out } = substituteSelfUrls(c, [pm({ hostPort: 20500, mode: "hostPort" })], target({ domain: null, web: null }));
    expect(out).toContain("http://localhost:80/health"); // container-internal, untouched
    expect(out).toContain("APP_URL=http://1.2.3.4:20500");
  });

  it("does not corrupt a longer host port sharing a prefix (word boundary)", () => {
    const c = "- A=localhost:20500\n- B=localhost:205009\n";
    const { compose: out } = substituteSelfUrls(c, [pm({ hostPort: 20500, mode: "hostPort" })], target({ domain: null, web: null }));
    expect(out).toContain("A=1.2.3.4:20500");
    expect(out).toContain("B=localhost:205009"); // different port → untouched
  });

  it("multi-exposure: only the primary takes the domain; other services → serverIp:hostPort", () => {
    const c = "- WEB=http://localhost:20500\n- API=http://localhost:20501\n";
    const pms = [pm({ serviceName: "web", hostPort: 20500 }), pm({ serviceName: "api", containerPort: 3000, hostPort: 20501 })];
    const { compose: out } = substituteSelfUrls(c, pms, target({ domain: "d.example.com", https: true, web: { service: "web", port: 80 } }));
    expect(out).toContain("WEB=https://d.example.com");
    expect(out).toContain("API=http://1.2.3.4:20501"); // non-primary, even though mode:domain
  });

  it("an explicit hostPort-mode primary never takes the domain", () => {
    const c = "- WEB=http://localhost:20500\n";
    const { compose: out } = substituteSelfUrls(c, [pm({ serviceName: "web", hostPort: 20500, mode: "hostPort" })], target({ domain: "d.example.com", https: true, web: { service: "web", port: 80 } }));
    expect(out).toContain("WEB=http://1.2.3.4:20500");
  });

  it("substitutes inside mount bodies and returns the rewritten mounts", () => {
    const mounts = [{ serviceName: "app", target: "/etc/c", content: "base=http://localhost:20500\n" }];
    const { mounts: out } = substituteSelfUrls("services:\n  app:\n    image: x\n", [pm({ hostPort: 20500 })], target({ domain: "d.example.com", https: true }), mounts);
    expect(out).toEqual([{ serviceName: "app", target: "/etc/c", content: "base=https://d.example.com\n" }]);
  });

  it("is a no-op for empty portMappings, and omits the mounts key when none are passed", () => {
    const c = "- A=http://localhost:20500\n";
    expect(substituteSelfUrls(c, [], target()).compose).toBe(c);
    expect(substituteSelfUrls(c, [pm({ hostPort: 20500 })], target())).not.toHaveProperty("mounts");
  });

  it("is idempotent (a second pass changes nothing)", () => {
    const once = substituteSelfUrls(compose, [pm({ hostPort: 20500 })], target()).compose;
    const twice = substituteSelfUrls(once, [pm({ hostPort: 20500 })], target()).compose;
    expect(twice).toBe(once);
  });

  it("refuses to bake a malformed server IP (YAML-injection defense) — leaves localhost", () => {
    const c = "      - APP_URL=http://localhost:20500\n";
    const evil = "203.0.113.7\n      - EXTRA=pwned"; // a newline would inject a fresh YAML line
    const { compose: out } = substituteSelfUrls(c, [pm({ hostPort: 20500, mode: "hostPort" })], target({ domain: null, serverIp: evil, web: null }));
    expect(out).toBe(c); // not a valid IP → nothing baked, no injection
    expect(out).not.toContain("EXTRA=pwned");
  });
});
