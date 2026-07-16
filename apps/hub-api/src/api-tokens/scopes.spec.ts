import { canReadSecrets, methodDefaultScope, scopeSatisfies, SCOPES } from "./scopes";

describe("methodDefaultScope", () => {
  it("maps read methods to read", () => {
    for (const m of ["GET", "get", "HEAD", "OPTIONS"]) expect(methodDefaultScope(m)).toBe("read");
  });
  it("maps mutating methods to write", () => {
    for (const m of ["POST", "PUT", "PATCH", "post", "put"]) expect(methodDefaultScope(m)).toBe("write");
  });
  it("maps DELETE to admin (destructive)", () => {
    expect(methodDefaultScope("DELETE")).toBe("admin");
    expect(methodDefaultScope("delete")).toBe("admin");
  });
  it("falls back to read for missing/unknown methods (fail-safe read)", () => {
    expect(methodDefaultScope(undefined as unknown as string)).toBe("read");
    expect(methodDefaultScope("TRACE")).toBe("read");
  });
});

describe("scopeSatisfies", () => {
  it("wildcard and admin satisfy every required scope", () => {
    for (const holder of [["*"], ["admin"]]) {
      for (const req of SCOPES) expect(scopeSatisfies(holder, req)).toBe(true);
    }
  });

  it("read is implied by ANY non-empty grant", () => {
    for (const holder of [["read"], ["write"], ["deploy"], ["read:secrets"], ["admin"], ["*"]]) {
      expect(scopeSatisfies(holder, "read")).toBe(true);
    }
    expect(scopeSatisfies([], "read")).toBe(false); // empty grants nothing
  });

  it("write / deploy / read:secrets are independent of each other", () => {
    expect(scopeSatisfies(["write"], "deploy")).toBe(false);
    expect(scopeSatisfies(["deploy"], "write")).toBe(false);
    expect(scopeSatisfies(["write"], "read:secrets")).toBe(false);
    expect(scopeSatisfies(["read:secrets"], "write")).toBe(false);
    expect(scopeSatisfies(["read"], "write")).toBe(false);
    expect(scopeSatisfies(["read"], "deploy")).toBe(false);
  });

  it("an exact grant satisfies its own requirement", () => {
    expect(scopeSatisfies(["write"], "write")).toBe(true);
    expect(scopeSatisfies(["deploy"], "deploy")).toBe(true);
    expect(scopeSatisfies(["read:secrets"], "read:secrets")).toBe(true);
    expect(scopeSatisfies(["read", "deploy"], "deploy")).toBe(true);
  });

  it("empty scopes satisfy nothing (fail-closed)", () => {
    for (const req of SCOPES) expect(scopeSatisfies([], req)).toBe(false);
  });
});

describe("canReadSecrets", () => {
  it("only read:secrets, admin, or wildcard unlock secrets", () => {
    expect(canReadSecrets(["read:secrets"])).toBe(true);
    expect(canReadSecrets(["admin"])).toBe(true);
    expect(canReadSecrets(["*"])).toBe(true);
    expect(canReadSecrets(["read", "read:secrets"])).toBe(true);
  });
  it("read / write / deploy do NOT unlock secrets", () => {
    expect(canReadSecrets(["read"])).toBe(false);
    expect(canReadSecrets(["write"])).toBe(false);
    expect(canReadSecrets(["deploy"])).toBe(false);
    expect(canReadSecrets(["read", "write", "deploy"])).toBe(false);
    expect(canReadSecrets([])).toBe(false);
  });
});
