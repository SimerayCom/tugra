import { hubDatabaseUrl, parsePoolInt, withPoolParams } from "./database-url";

const BASE = "postgresql://tugra:pw@postgres:5432/tugra";

describe("withPoolParams", () => {
  it("adds both parameters to a URL without a query string", () => {
    expect(withPoolParams(BASE, { connectionLimit: 8, poolTimeout: 20 })).toBe(`${BASE}?connection_limit=8&pool_timeout=20`);
  });

  it("extends an existing query string with & (never a second ?)", () => {
    expect(withPoolParams(`${BASE}?schema=public`, { connectionLimit: "10", poolTimeout: "20" })).toBe(
      `${BASE}?schema=public&connection_limit=10&pool_timeout=20`,
    );
  });

  it("does not double the separator after a trailing & or bare ?", () => {
    expect(withPoolParams(`${BASE}?schema=public&`, { connectionLimit: 8 })).toBe(`${BASE}?schema=public&connection_limit=8`);
    expect(withPoolParams(`${BASE}?`, { connectionLimit: 8 })).toBe(`${BASE}?connection_limit=8`);
  });

  it("never overrides a parameter the URL already carries (the operator's explicit URL wins), case-insensitively", () => {
    expect(withPoolParams(`${BASE}?connection_limit=3`, { connectionLimit: 8, poolTimeout: 20 })).toBe(`${BASE}?connection_limit=3&pool_timeout=20`);
    expect(withPoolParams(`${BASE}?schema=public&Pool_Timeout=5&connection_limit=2`, { connectionLimit: 8, poolTimeout: 20 })).toBe(
      `${BASE}?schema=public&Pool_Timeout=5&connection_limit=2`,
    );
  });

  it("keeps a fragment at the end", () => {
    expect(withPoolParams(`${BASE}?schema=public#x`, { connectionLimit: 8 })).toBe(`${BASE}?schema=public&connection_limit=8#x`);
  });

  it("returns the URL byte for byte when there is nothing valid to add", () => {
    for (const v of [undefined, null, "", "abc", "0", "-3", "1.5", "99999999", " "]) {
      expect(withPoolParams(`${BASE}?schema=public`, { connectionLimit: v, poolTimeout: v })).toBe(`${BASE}?schema=public`);
    }
  });

  it("leaves something that is not a scheme:// URL alone", () => {
    expect(withPoolParams("not a url", { connectionLimit: 8 })).toBe("not a url");
    expect(withPoolParams("host=localhost user=x", { connectionLimit: 8 })).toBe("host=localhost user=x");
  });

  it("adds just the one that is set", () => {
    expect(withPoolParams(BASE, { poolTimeout: 30 })).toBe(`${BASE}?pool_timeout=30`);
  });
});

describe("parsePoolInt", () => {
  it("accepts positive integers within the cap and rejects everything else", () => {
    expect(parsePoolInt("16", 1000)).toBe(16);
    expect(parsePoolInt(" 16 ", 1000)).toBe(16);
    expect(parsePoolInt(1000, 1000)).toBe(1000);
    expect(parsePoolInt(1001, 1000)).toBeUndefined();
    expect(parsePoolInt("1e3", 1000)).toBeUndefined();
    expect(parsePoolInt("08", 1000)).toBe(8);
  });
});

describe("hubDatabaseUrl", () => {
  it("is undefined without DATABASE_URL", () => {
    expect(hubDatabaseUrl({})).toBeUndefined();
  });
  it("is the URL untouched when no pool variable is set (an install without a profile)", () => {
    expect(hubDatabaseUrl({ DATABASE_URL: `${BASE}?schema=public` })).toBe(`${BASE}?schema=public`);
    expect(hubDatabaseUrl({ DATABASE_URL: `${BASE}?schema=public`, HUB_DB_CONNECTION_LIMIT: "", HUB_DB_POOL_TIMEOUT: "" })).toBe(`${BASE}?schema=public`);
  });
  it("applies the profile's pool to a copy", () => {
    const env = { DATABASE_URL: `${BASE}?schema=public`, HUB_DB_CONNECTION_LIMIT: "8", HUB_DB_POOL_TIMEOUT: "20" };
    expect(hubDatabaseUrl(env)).toBe(`${BASE}?schema=public&connection_limit=8&pool_timeout=20`);
    expect(env.DATABASE_URL).toBe(`${BASE}?schema=public`);
  });
});
