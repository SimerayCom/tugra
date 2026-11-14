import { appLinks, appUrl, primaryHostPort, MAX_APP_LINKS } from "./app-url";

describe("appUrl", () => {
  it("uses the domain with https when https is on", () => {
    expect(appUrl({ domain: "app.example.com", https: true, hostPort: null }, null)).toBe(
      "https://app.example.com",
    );
  });

  it("uses the domain with http when https is off", () => {
    expect(appUrl({ domain: "app.example.com", https: false, hostPort: null }, null)).toBe(
      "http://app.example.com",
    );
  });

  it("prefers the domain even when a host port and IP are present", () => {
    expect(appUrl({ domain: "app.example.com", https: true, hostPort: 8080 }, "203.0.113.7")).toBe(
      "https://app.example.com",
    );
  });

  it("synthesizes http://ip:port for a domainless app that publishes a host port", () => {
    expect(appUrl({ domain: null, https: true, hostPort: 8080 }, "203.0.113.7")).toBe(
      "http://203.0.113.7:8080",
    );
  });

  it("brackets an IPv6 literal", () => {
    expect(appUrl({ domain: null, https: true, hostPort: 8080 }, "2001:db8::1")).toBe(
      "http://[2001:db8::1]:8080",
    );
  });

  it("returns null when there is no reachable public IP", () => {
    expect(appUrl({ domain: null, https: true, hostPort: 8080 }, null)).toBeNull();
    expect(appUrl({ domain: null, https: true, hostPort: 8080 }, undefined)).toBeNull();
  });

  it("returns null when the app publishes no host port (nothing to reach)", () => {
    expect(appUrl({ domain: null, https: true, hostPort: null }, "203.0.113.7")).toBeNull();
  });
});

describe("primaryHostPort", () => {
  const maps = [
    { serviceName: "db", containerPort: 5432, hostPort: 20500, mode: "hostPort" },
    { serviceName: "web", containerPort: 80, hostPort: 20501, mode: "domain" },
  ];

  it("prefers the scalar hostPort when set (docker-run app)", () => {
    expect(primaryHostPort({ hostPort: 8080, source: "IMAGE" }, null)).toBe(8080);
  });

  it("uses the web-matched portMappings entry for a COMPOSE app", () => {
    expect(primaryHostPort({ hostPort: null, source: "COMPOSE", portMappings: maps }, { service: "web", port: 80 })).toBe(20501);
  });

  it("falls back to the first published mapping when the web service can't be inferred", () => {
    expect(primaryHostPort({ hostPort: null, source: "COMPOSE", portMappings: maps }, null)).toBe(20500);
  });

  it("returns null for a COMPOSE app with no portMappings", () => {
    expect(primaryHostPort({ hostPort: null, source: "COMPOSE", portMappings: [] }, null)).toBeNull();
    expect(primaryHostPort({ hostPort: null, source: "COMPOSE" }, null)).toBeNull();
  });

  it("returns null for a non-array portMappings (defensive Prisma JsonValue)", () => {
    expect(primaryHostPort({ hostPort: null, source: "COMPOSE", portMappings: "oops" as unknown }, null)).toBeNull();
  });

  it("returns null for a non-COMPOSE domainless app with no scalar hostPort", () => {
    expect(primaryHostPort({ hostPort: null, source: "IMAGE", portMappings: maps }, null)).toBeNull();
  });
});

describe("appLinks", () => {
  const none = { serviceDomains: [] as { service: string; hostname: string }[] };
  const mk = (over: Partial<Parameters<typeof appLinks>[0]> = {}) => ({ domain: null, extraDomains: [], source: "IMAGE", portMappings: null, ...over });

  it("a domained app's primary link carries its host and keeps links[0].url === url", () => {
    const url = appUrl({ domain: "app.example.com", https: true, hostPort: null }, null);
    expect(appLinks(mk({ domain: "app.example.com" }), { ...none, publicIp: null, primaryUrl: url })).toEqual([
      { kind: "primary", url: "https://app.example.com", host: "app.example.com", label: null },
    ]);
    const http = appUrl({ domain: "app.example.com", https: false, hostPort: null }, null);
    expect(appLinks(mk({ domain: "app.example.com" }), { ...none, publicIp: null, primaryUrl: http })[0].url).toBe("http://app.example.com");
  });

  it("a domainless app with a host port links to ip:port with no host; without an IP it has no links", () => {
    const url = appUrl({ domain: null, https: true, hostPort: 8080 }, "203.0.113.7");
    expect(appLinks(mk(), { ...none, publicIp: "203.0.113.7", primaryUrl: url })).toEqual([
      { kind: "primary", url: "http://203.0.113.7:8080", host: null, label: null },
    ]);
    expect(appLinks(mk(), { ...none, publicIp: null, primaryUrl: null })).toEqual([]);
  });

  it("brackets an IPv6 literal on a compose port link", () => {
    const links = appLinks(
      mk({ source: "COMPOSE", portMappings: [{ serviceName: "db", containerPort: 5432, hostPort: 15432, mode: "hostPort" }] }),
      { ...none, publicIp: "2001:db8::1", primaryUrl: null },
    );
    expect(links).toEqual([{ kind: "port", url: "http://[2001:db8::1]:15432", host: null, label: "db:5432" }]);
  });

  it("aliases and service domains are https even when the primary is plain http", () => {
    const links = appLinks(mk({ domain: "app.example.com", extraDomains: ["alias.example.com"] }), {
      publicIp: null,
      primaryUrl: "http://app.example.com",
      serviceDomains: [{ service: "api", hostname: "api.example.com" }],
    });
    expect(links.map((l) => [l.kind, l.url, l.host, l.label])).toEqual([
      ["primary", "http://app.example.com", "app.example.com", null],
      ["alias", "https://alias.example.com", "alias.example.com", null],
      ["service", "https://api.example.com", "api.example.com", "api"],
    ]);
  });

  it("dedupes by url (first wins) and skips an alias equal to the primary or its www/bare twin", () => {
    const links = appLinks(mk({ domain: "www.example.com", extraDomains: ["www.example.com", "example.com", "WWW.example.com", "b.example.com", "b.example.com"] }), {
      publicIp: null,
      primaryUrl: "https://www.example.com",
      serviceDomains: [{ service: "web", hostname: "b.example.com" }],
    });
    expect(links.map((l) => l.url)).toEqual(["https://www.example.com", "https://b.example.com"]);
    expect(links[1].kind).toBe("alias"); // first writer wins over the service row
  });

  it("only hostPort-mode compose mappings become port links", () => {
    const links = appLinks(
      mk({
        source: "COMPOSE",
        domain: "app.example.com",
        portMappings: [
          { serviceName: "web", containerPort: 80, hostPort: 8081, mode: "domain" },
          { serviceName: "db", containerPort: 5432, hostPort: 15432, mode: "hostPort" },
        ],
      }),
      { ...none, publicIp: "203.0.113.7", primaryUrl: "https://app.example.com" },
    );
    expect(links.map((l) => l.url)).toEqual(["https://app.example.com", "http://203.0.113.7:15432"]);
    // a non-compose app never gets port links from stale mappings, nor does a compose app with no IP
    expect(appLinks(mk({ source: "GIT", portMappings: [{ serviceName: "x", containerPort: 1, hostPort: 2, mode: "hostPort" }] }), { ...none, publicIp: "1.1.1.1", primaryUrl: null })).toEqual([]);
    expect(appLinks(mk({ source: "COMPOSE", portMappings: [{ serviceName: "x", containerPort: 1, hostPort: 2, mode: "hostPort" }] }), { ...none, publicIp: null, primaryUrl: null })).toEqual([]);
  });

  it("caps the list", () => {
    const extra = Array.from({ length: 80 }, (_, i) => `a${i}.example.com`);
    expect(appLinks(mk({ domain: "app.example.com", extraDomains: extra }), { ...none, publicIp: null, primaryUrl: "https://app.example.com" })).toHaveLength(MAX_APP_LINKS);
  });

  it("every emitted url is http(s)", () => {
    const links = appLinks(mk({ domain: "app.example.com", extraDomains: ["x.example.com"] }), { publicIp: "1.2.3.4", primaryUrl: "https://app.example.com", serviceDomains: [{ service: "s", hostname: "s.example.com" }] });
    for (const l of links) expect(l.url).toMatch(/^https?:\/\//);
  });
});
