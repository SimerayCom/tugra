import { injectableBuildArgs, looksSensitiveKey, BUILD_ARG_KEY } from "./build-args";

describe("injectableBuildArgs", () => {
  it("keeps identifier env keys, skips invalid names and counts them", () => {
    const r = injectableBuildArgs({ env: { API_URL: "https://x", "bad-key": "1", "1BAD": "2", ok_2: "3" } });
    expect(Object.keys(r.args)).toEqual(["API_URL", "ok_2"]);
    expect(r.skipped).toBe(2);
  });

  it("never turns a build secret into a build arg", () => {
    const r = injectableBuildArgs({ env: { NPM_TOKEN: "x", A: "1" }, buildSecrets: { NPM_TOKEN: "s" } });
    expect(r.args).toEqual({ A: "1" });
    expect(r.skipped).toBe(1);
  });

  it("explicit build args win over env", () => {
    const r = injectableBuildArgs({ env: { A: "env", B: "b" }, buildArgs: { A: "explicit" } });
    expect(r.args).toEqual({ A: "explicit", B: "b" });
  });

  it("flags secret-looking keys by name only", () => {
    const r = injectableBuildArgs({ env: { DB_PASSWORD: "p", PLAIN: "v" } });
    expect(r.sensitive).toEqual(["DB_PASSWORD"]);
    expect(r.keys).toEqual(["DB_PASSWORD", "PLAIN"]);
  });

  it("refuses an environment too large to ride argv", () => {
    expect(() => injectableBuildArgs({ env: { BIG: "x".repeat(49 * 1024) } })).toThrow(/limit 49152/);
  });

  it("handles an empty / missing env", () => {
    expect(injectableBuildArgs({})).toEqual({ args: {}, keys: [], sensitive: [], skipped: 0 });
  });
});

describe("looksSensitiveKey", () => {
  it.each(["DB_PASSWORD", "GITHUB_TOKEN", "API_KEY", "SECRET", "stripe-secret-key", "AWS_ACCESS_KEY", "PRIVATE_KEY", "AUTH_TOKEN", "SECRETS"])("flags %s", (k) => {
    expect(looksSensitiveKey(k)).toBe(true);
  });
  it.each(["API_URL", "NODE_ENV", "PORT", "TOKENIZER_MODE", "KEYBOARD"])("does not flag %s", (k) => {
    expect(looksSensitiveKey(k)).toBe(false);
  });
  it("BUILD_ARG_KEY is a plain identifier", () => {
    expect(BUILD_ARG_KEY.test("A_1")).toBe(true);
    expect(BUILD_ARG_KEY.test("a-b")).toBe(false);
  });
});
