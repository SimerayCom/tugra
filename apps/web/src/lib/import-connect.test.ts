import { describe, it, expect } from "vitest";
import { failureKey, readyToTest, testLineParts } from "./import-connect";
import importNs from "../i18n/locales/en/import.json";

const lookup = (key: string): unknown => key.replace(/^import\./, "").split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), importNs);

describe("readyToTest", () => {
  it("needs an http(s) address and a real-looking token", () => {
    expect(readyToTest("https://coolify.example.com", "12345678")).toBe(true);
    expect(readyToTest(" https://coolify.example.com/ ", " abcdefghij ")).toBe(true);
    expect(readyToTest("coolify.example.com", "12345678")).toBe(false);
    expect(readyToTest("https://", "12345678")).toBe(false);
    expect(readyToTest("https://coolify.example.com", "short")).toBe(false);
    expect(readyToTest("ftp://coolify.example.com", "12345678")).toBe(false);
  });
});

describe("failureKey", () => {
  it("maps every named cause to its sentence and anything else to the generic one", () => {
    for (const c of ["allowed-ips", "api-disabled", "scoped-token", "exceeds-access", "ability", "forbidden", "unauthorized", "rate-limited"]) expect(failureKey(c)).toBe(`import.test.fail.${c}`);
    expect(failureKey("other")).toBe("import.test.fail.other");
    expect(failureKey(undefined)).toBe("import.test.fail.other");
    expect(failureKey("weird")).toBe("import.test.fail.other");
  });
  it("every sentence it can return exists in the locale, and none is a paragraph", () => {
    for (const c of ["allowed-ips", "api-disabled", "scoped-token", "exceeds-access", "ability", "forbidden", "unauthorized", "rate-limited", "other"]) {
      const text = lookup(failureKey(c));
      expect(typeof text, c).toBe("string");
      expect((text as string).length, c).toBeLessThanOrEqual(90);
    }
    for (const k of ["apps", "databases", "services"]) for (const f of ["one", "other"]) expect(typeof lookup(`import.test.${k}_${f}`)).toBe("string");
  });
});

describe("testLineParts", () => {
  it("orders the counts, hides a zero service count and keeps the sensitive flag", () => {
    expect(testLineParts({ ok: true, team: "Acme", apps: 19, databases: 10, services: 0, sensitive: true })).toEqual({ hasTeam: true, counts: [{ key: "apps", n: 19 }, { key: "databases", n: 10 }], sensitive: true });
    expect(testLineParts({ ok: true, apps: 1, databases: 0, services: 3, sensitive: false }).counts.map((c) => c.key)).toEqual(["apps", "databases", "services"]);
  });
  it("a source that cannot count (Dokploy) gives no counts", () => {
    expect(testLineParts({ ok: true, apps: null, databases: null, services: null, sensitive: null })).toEqual({ hasTeam: false, counts: [], sensitive: null });
  });
});
