import { appUrl } from "./app-url";

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
