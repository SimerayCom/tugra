import { createHash } from "node:crypto";
import {
  clampScopes,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  isValidCodeVerifier,
  maxScopesForPermissions,
  parseScopes,
  redirectHost,
  redirectUriMatches,
  verifyPkceS256,
  wwwAuthenticate,
} from "./oauth.util";
import { TEAM_PERMISSIONS } from "@tugra/shared";

// RFC 7636 appendix B test vector.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE S256", () => {
  it("accepts the RFC 7636 vector", () => {
    expect(verifyPkceS256(VERIFIER, CHALLENGE)).toBe(true);
    expect(createHash("sha256").update(VERIFIER).digest("base64url")).toBe(CHALLENGE);
  });
  it("rejects a different verifier", () => {
    expect(verifyPkceS256("A".repeat(43), CHALLENGE)).toBe(false);
  });
  it("rejects a verifier that is too short, too long or has bad characters", () => {
    expect(isValidCodeVerifier("short")).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier(`${"a".repeat(42)}!`)).toBe(false);
    expect(verifyPkceS256("short", CHALLENGE)).toBe(false);
  });
  it("only accepts a 43-char base64url challenge (never a plain verifier-style value)", () => {
    expect(isValidCodeChallenge(CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge("a".repeat(44))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(42) + "+")).toBe(false);
  });
});

describe("redirect URIs", () => {
  it.each(["https://app.example.com/cb", "http://localhost:8080/cb", "http://127.0.0.1/cb", "https://example.com/a?b=1"])("allows %s", (u) => {
    expect(isAllowedRedirectUri(u)).toBe(true);
  });
  it.each([
    "http://example.com/cb",
    "myapp://callback",
    "javascript:alert(1)",
    "https://example.com/cb#frag",
    "https://user:pw@example.com/cb",
    "/relative",
    "not a url",
    "",
  ])("refuses %s", (u) => {
    expect(isAllowedRedirectUri(u)).toBe(false);
  });
  it("matches registered URIs exactly", () => {
    const reg = ["https://app.example.com/cb"];
    expect(redirectUriMatches(reg, "https://app.example.com/cb")).toBe(true);
    expect(redirectUriMatches(reg, "https://app.example.com/cb/")).toBe(false);
    expect(redirectUriMatches(reg, "https://app.example.com/cb?x=1")).toBe(false);
    expect(redirectUriMatches(reg, "https://app.example.com/cbx")).toBe(false);
    expect(redirectUriMatches(reg, undefined)).toBe(false);
  });
  it("shows the host (with port) for the consent screen", () => {
    expect(redirectHost("http://localhost:3118/callback")).toBe("localhost:3118");
    expect(redirectHost("https://claude.ai/api/mcp/auth_callback")).toBe("claude.ai");
  });
});

describe("scopes", () => {
  it("parses a scope string and drops unknown values", () => {
    expect(parseScopes("read write bogus  deploy read")).toEqual(["read", "write", "deploy"]);
    expect(parseScopes(undefined)).toEqual([]);
  });
  it("a viewer (no permissions) is limited to read", () => {
    expect(maxScopesForPermissions(new Set())).toEqual(["read"]);
    expect(clampScopes(["read", "write", "deploy", "admin", "read:secrets"], new Set())).toEqual(["read"]);
  });
  it("write needs a configuration permission, deploy needs apps:deploy", () => {
    expect(maxScopesForPermissions(new Set(["monitors"]))).toEqual(["read", "write"]);
    expect(maxScopesForPermissions(new Set(["apps:deploy"]))).toEqual(["read", "deploy"]);
    expect(clampScopes(["write", "deploy", "admin"], new Set(["apps:deploy"]))).toEqual(["deploy"]);
  });
  it("secrets and admin only come with the full permission set", () => {
    const all = new Set<string>(TEAM_PERMISSIONS);
    expect(maxScopesForPermissions(all)).toEqual(["read", "write", "deploy", "read:secrets", "admin"]);
    const almost = new Set(all);
    almost.delete("terminal");
    expect(maxScopesForPermissions(almost)).not.toContain("admin");
    expect(maxScopesForPermissions(almost)).not.toContain("read:secrets");
  });
  it("never returns an empty set", () => {
    expect(clampScopes(["deploy"], new Set(["monitors"]))).toEqual(["read"]);
  });
});

describe("WWW-Authenticate", () => {
  it("carries the resource metadata URL", () => {
    expect(wwwAuthenticate("https://h/.well-known/oauth-protected-resource/api/v1/mcp")).toBe(
      'Bearer resource_metadata="https://h/.well-known/oauth-protected-resource/api/v1/mcp"',
    );
  });
});
