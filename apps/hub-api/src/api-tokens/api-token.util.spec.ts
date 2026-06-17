import {
  generateApiToken,
  hashToken,
  isApiToken,
  tokenPrefix,
} from "./api-token.util";

describe("api-token.util", () => {
  it("generates a prefixed, unique token", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a).toMatch(/^tugra_pat_/);
    expect(a).not.toBe(b);
  });

  it("hashes deterministically and never equals the raw token", () => {
    const raw = generateApiToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
    expect(hashToken(raw)).not.toBe(raw);
    expect(hashToken(raw)).toHaveLength(64); // sha256 hex
  });

  it("exposes a short display prefix (first 16 chars)", () => {
    expect(tokenPrefix("tugra_pat_abcdefabcdef")).toBe("tugra_pat_abcdef");
  });

  it("recognizes api tokens", () => {
    expect(isApiToken("tugra_pat_x")).toBe(true);
    expect(isApiToken("eyJhbG.jwt.token")).toBe(false);
    expect(isApiToken(undefined)).toBe(false);
  });
});
