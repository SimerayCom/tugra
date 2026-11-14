import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidEnvKey, isLinkEnvKeyAllowed, isValidUserEnvKey, isSafeEnvValue, isHostExportSafeKey, isSafeMultilineValue, ML_VALUE_MAX_BYTES, ENV_KEY_MAX } from "./env-key";

describe("isValidEnvKey", () => {
  it("accepts POSIX-ish names", () => {
    for (const k of ["FOO", "_bar", "A1", "DATABASE_URL", "x"]) expect(isValidEnvKey(k)).toBe(true);
  });

  it("rejects empty, bad chars, leading digit, reserved names, and over-length", () => {
    for (const k of ["", "1BAD", "has space", "WITH-DASH", "a=b", "__proto__", "constructor", "prototype"]) {
      expect(isValidEnvKey(k)).toBe(false);
    }
    expect(isValidEnvKey("A".repeat(ENV_KEY_MAX))).toBe(true);
    expect(isValidEnvKey("A".repeat(ENV_KEY_MAX + 1))).toBe(false);
  });
});

describe("isLinkEnvKeyAllowed", () => {
  it("accepts ordinary connection-string names", () => {
    for (const k of ["DATABASE_URL", "REDIS_URL", "MY_DB", "POSTGRES_URI"]) expect(isLinkEnvKeyAllowed(k)).toBe(true);
  });

  it("rejects runtime-hijacking names a link must never inject", () => {
    for (const k of ["PATH", "HOME", "SHELL", "PORT", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DOCKER_HOST", "COMPOSE_FILE", "TUGRA_SECRET"]) {
      expect(isLinkEnvKeyAllowed(k)).toBe(false);
    }
  });

  it("still rejects anything that isn't a valid env key", () => {
    expect(isLinkEnvKeyAllowed("1BAD")).toBe(false);
    expect(isLinkEnvKeyAllowed("has space")).toBe(false);
  });
});

describe("isValidUserEnvKey", () => {
  it("accepts legitimate container env keys the strict POSIX regex rejects (dots, dashes, colons, leading digit)", () => {
    for (const k of ["FOO", "spring.profiles.active", "my-app.setting", "a:b", "1BAD", "DATABASE_URL"]) {
      expect(isValidUserEnvKey(k)).toBe(true);
    }
  });

  it("rejects only what actually corrupts the --env-file (=, whitespace, newline, control chars, NUL, reserved, over-length)", () => {
    for (const k of ["", "a=b", "has space", "with\ttab", "line\nbreak", "nul\u0000byte", "__proto__", "constructor", "prototype"]) {
      expect(isValidUserEnvKey(k)).toBe(false);
    }
    expect(isValidUserEnvKey("A".repeat(ENV_KEY_MAX))).toBe(true);
    expect(isValidUserEnvKey("A".repeat(ENV_KEY_MAX + 1))).toBe(false);
  });
});

describe("isSafeEnvValue", () => {
  it("accepts ordinary values", () => {
    for (const v of ["", "bar", "a b c", "postgres://u:p@h:5432/db", "with=equals"]) expect(isSafeEnvValue(v)).toBe(true);
  });

  it("rejects values that would inject a second env-file line (newline, CR, NUL)", () => {
    for (const v of ["x\nTUGRA_FOO=bar", "x\rY=1", "nul\u0000"]) expect(isSafeEnvValue(v)).toBe(false);
  });
});

describe("isHostExportSafeKey (SECURITY-CRITICAL policy fixture)", () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, "../../test/fixtures/env-key-policy.json"), "utf8")) as { key: string; safe: boolean }[];
  it.each(fixture.map((f) => [f.key, f.safe] as const))("%j -> %s", (key, safe) => {
    expect(isHostExportSafeKey(key)).toBe(safe);
  });
});

describe("isSafeMultilineValue", () => {
  it("allows LF/CR/empty and rejects NUL", () => {
    expect(isSafeMultilineValue("a\nb\r\nc\n")).toBe(true);
    expect(isSafeMultilineValue("")).toBe(true);
    expect(isSafeMultilineValue("a\u0000b")).toBe(false);
  });
  it("counts utf8 bytes at the 16 KiB boundary", () => {
    expect(isSafeMultilineValue("a".repeat(ML_VALUE_MAX_BYTES))).toBe(true);
    expect(isSafeMultilineValue("a".repeat(ML_VALUE_MAX_BYTES + 1))).toBe(false);
    expect(isSafeMultilineValue("\u00e9".repeat(ML_VALUE_MAX_BYTES / 2))).toBe(true); // 2 bytes each
    expect(isSafeMultilineValue("\u00e9".repeat(ML_VALUE_MAX_BYTES / 2 + 1))).toBe(false);
  });
});
