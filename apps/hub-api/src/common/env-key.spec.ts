import { isValidEnvKey, isLinkEnvKeyAllowed, ENV_KEY_MAX } from "./env-key";

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
