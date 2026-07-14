import { appUrl, primaryHostPort } from "./app-url";

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
