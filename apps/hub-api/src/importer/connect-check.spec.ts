import { classifyConnectFailure, suggestScopeLabel } from "./connect-check";

describe("classifyConnectFailure", () => {
  const msg = (status: number, m?: string) => `Coolify API error ${status}${m ? `: "${m}"` : ""} (hint)`;
  it("names the single 403 cause from Coolify's message", () => {
    expect(classifyConnectFailure(msg(403, "You are not allowed to access the API."))).toBe("allowed-ips");
    expect(classifyConnectFailure(msg(403, "API is disabled."))).toBe("api-disabled");
    expect(classifyConnectFailure(msg(403, "This API token has more access than you have in this team. Revoke it"))).toBe("exceeds-access");
    expect(classifyConnectFailure(msg(403, "This API token is limited to selected projects, environments"))).toBe("scoped-token");
    expect(classifyConnectFailure(msg(403, "Missing required permissions: read"))).toBe("ability");
  });
  it("a 403 without a recognisable message is just forbidden (no IP guess)", () => {
    expect(classifyConnectFailure(msg(403))).toBe("forbidden");
    expect(classifyConnectFailure(msg(403, "something else"))).toBe("forbidden");
  });
  it("maps 401 and 429, and leaves everything else as other", () => {
    expect(classifyConnectFailure(msg(401))).toBe("unauthorized");
    expect(classifyConnectFailure(msg(429))).toBe("rate-limited");
    expect(classifyConnectFailure("Coolify API error 429 — requests paused, rate-limited")).toBe("rate-limited");
    expect(classifyConnectFailure(msg(500))).toBe("other");
    expect(classifyConnectFailure("connect ECONNREFUSED")).toBe("other");
    expect(classifyConnectFailure(undefined)).toBe("other");
  });
});

describe("suggestScopeLabel", () => {
  it("slugs a team name into a valid label", () => {
    expect(suggestScopeLabel("Acme Team")).toBe("acme-team");
    expect(suggestScopeLabel("  Ünïcode  Crew! ")).toBe("unicode-crew");
    expect(suggestScopeLabel("a.b_c-d")).toBe("a.b_c-d");
  });
  it("is empty when nothing usable is left and never exceeds 64 chars", () => {
    expect(suggestScopeLabel("!!!")).toBe("");
    expect(suggestScopeLabel(undefined)).toBe("");
    const long = suggestScopeLabel("x".repeat(63) + " y");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z0-9._-]{1,64}$/);
  });
});
