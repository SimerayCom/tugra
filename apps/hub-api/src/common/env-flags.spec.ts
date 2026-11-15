import {
  applyEnvFlags, autoMultilineLegacy, BUILD_FLAG_TOTAL_MAX_BYTES, encodeEnvMeta, EnvMeta, EnvMetaCorruptError, flagsToken, ML_KEYS_MAX, ML_TOTAL_MAX_BYTES,
  ML_VALUE_MAX_BYTES, NEWLINE_MESSAGE, normalizeFlags, parseEnvMeta, pruneMeta, validateEnvFlags,
} from "./env-flags";
import { BUILD_ARG_KEY } from "../deploy/build-args";
import { BUILD_SECRETS_MAX_TOTAL_BYTES } from "../applications/dto";

const meta = (o: Record<string, unknown>) => normalizeFlags(o, Object.keys(o));
const codes = (env: Record<string, string>, m: EnvMeta, ctx = {}) => validateEnvFlags(env, m, ctx).map((i) => i.code);

describe("normalizeFlags", () => {
  it("keeps only non-default flags, sorted, with a null prototype", () => {
    const m = normalizeFlags({ Z: { multiline: true, runtime: true }, A: { buildTime: true, runtime: false, literal: false } }, ["A", "Z"]);
    expect(Object.keys(m)).toEqual(["A", "Z"]);
    expect(m.A).toEqual({ buildTime: true, runtime: false });
    expect(m.Z).toEqual({ multiline: true });
    expect(Object.getPrototypeOf(m)).toBeNull();
  });
  it("drops all-default entries, keys not in env, unknown fields and truthy-but-not-true values", () => {
    const m = normalizeFlags({ A: { buildTime: false, runtime: true }, B: { multiline: true }, C: { literal: "yes", bogus: true }, D: null }, ["A", "C", "D"]);
    expect(Object.keys(m)).toEqual([]);
  });
  it("rejects prototype names and non-objects", () => {
    expect(Object.keys(normalizeFlags(JSON.parse('{"__proto__":{"multiline":true},"constructor":{"multiline":true}}'), ["__proto__", "constructor"]))).toEqual([]);
    expect(Object.keys(normalizeFlags(null, ["A"]))).toEqual([]);
    expect(Object.keys(normalizeFlags("x", ["A"]))).toEqual([]);
    expect(Object.keys(normalizeFlags([{ multiline: true }], ["0"]))).toEqual([]);
  });
});

describe("flagsToken / pruneMeta / encode / parse", () => {
  it("tokens use a fixed order", () => {
    expect(flagsToken()).toBe("");
    expect(flagsToken({ buildTime: true })).toBe("build");
    expect(flagsToken({ buildTime: true, runtime: false })).toBe("build-only");
    expect(flagsToken({ buildTime: true, literal: true, multiline: true })).toBe("build+literal+multiline");
    expect(flagsToken({ multiline: true, literal: true })).toBe("literal+multiline");
  });
  it("pruneMeta keeps listed keys only", () => {
    const m = meta({ A: { multiline: true }, B: { literal: true } });
    expect(Object.keys(pruneMeta(m, ["B"]))).toEqual(["B"]);
  });
  it("encode returns null when empty and round-trips otherwise", () => {
    expect(encodeEnvMeta(meta({}))).toBeNull();
    const m = meta({ B: { multiline: true }, A: { buildTime: true, runtime: false } });
    const enc = encodeEnvMeta(m)!;
    expect(enc).toBe('{"v":1,"flags":{"A":{"buildTime":true,"runtime":false},"B":{"multiline":true}}}');
    expect(parseEnvMeta(enc)).toEqual(m);
  });
  it("parse: null is empty; corruption of any kind throws EnvMetaCorruptError", () => {
    expect(Object.keys(parseEnvMeta(null))).toEqual([]);
    for (const bad of ["not json", "null", "[]", '{"v":2,"flags":{}}', '{"v":1}', '{"v":1,"flags":[]}', '{"v":1,"flags":{"A":"x"}}', '{"v":1,"flags":{"A":{"multiline":false}}}', '{"v":1,"flags":{"A":{"runtime":true}}}', '{"v":1,"flags":{"A":{"nope":true}}}', '{"v":1,"flags":{"__proto__":{"multiline":true}}}']) {
      expect(() => parseEnvMeta(bad)).toThrow(EnvMetaCorruptError);
    }
  });
});

describe("validateEnvFlags", () => {
  it("is clean for flag-free single-line env", () => {
    expect(validateEnvFlags({ A: "x", B: "" }, meta({}), { source: "GIT" })).toEqual([]);
  });
  it("FLAG_KEY_MISSING only in write mode", () => {
    const m = normalizeFlags({ GONE: { multiline: true } }, ["GONE"]);
    expect(codes({ A: "x" }, m)).toEqual(["FLAG_KEY_MISSING"]);
    expect(codes({ A: "x" }, m, { mode: "deploy" })).toEqual([]);
  });
  it("VALUE_NUL always; VALUE_NEWLINE without multiline keeps the exact legacy message", () => {
    expect(codes({ A: "a\u0000b" }, meta({ A: { multiline: true } }))).toContain("VALUE_NUL");
    const i = validateEnvFlags({ A: "a\nb" }, meta({}), {});
    expect(i).toEqual([{ key: "A", code: "VALUE_NEWLINE", message: "environment value must not contain a newline" }]);
    expect(NEWLINE_MESSAGE).toBe("environment value must not contain a newline");
    expect(codes({ A: "a\rb" }, meta({}))).toEqual(["VALUE_NEWLINE"]);
    expect(codes({ A: "a\nb" }, meta({ A: { multiline: true } }))).toEqual([]);
  });
  it("ML_KEY needs a host-export-safe name", () => {
    expect(codes({ LD_PRELOAD: "a\nb" }, meta({ LD_PRELOAD: { multiline: true } }))).toEqual(["ML_KEY"]);
    expect(codes({ "a.b": "a\nb" }, meta({ "a.b": { multiline: true } }))).toEqual(["ML_KEY"]);
  });
  it("ML_SIZE boundaries: per value, key count, total", () => {
    expect(codes({ K: "a".repeat(ML_VALUE_MAX_BYTES) }, meta({ K: { multiline: true } }))).toEqual([]);
    expect(codes({ K: "a".repeat(ML_VALUE_MAX_BYTES + 1) }, meta({ K: { multiline: true } }))).toEqual(["ML_SIZE"]);
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, "x\ny"]));
    const mk = (n: number) => { const e = many(n); return codes(e, normalizeFlags(Object.fromEntries(Object.keys(e).map((k) => [k, { multiline: true }])), Object.keys(e))); };
    expect(mk(ML_KEYS_MAX)).toEqual([]);
    expect(mk(ML_KEYS_MAX + 1)).toEqual(["ML_SIZE"]);
    const big = { A: "a".repeat(16 * 1024), B: "b".repeat(16 * 1024), C: "c".repeat(16 * 1024), D: "d" };
    const bm = normalizeFlags(Object.fromEntries(Object.keys(big).map((k) => [k, { multiline: true }])), Object.keys(big));
    expect(ML_TOTAL_MAX_BYTES).toBe(48 * 1024);
    expect(codes(big, bm)).toEqual(["ML_SIZE"]);
  });
  it("LITERAL_KEY only on COMPOSE and only with a source", () => {
    const m = meta({ BASH_ENV: { literal: true } });
    expect(codes({ BASH_ENV: "x" }, m, { source: "COMPOSE" })).toEqual(["LITERAL_KEY"]);
    expect(codes({ BASH_ENV: "x" }, m, { source: "IMAGE" })).toEqual([]);
    expect(codes({ BASH_ENV: "x" }, m, {})).toEqual([]);
    expect(codes({ PEM: "x" }, meta({ PEM: { literal: true } }), { source: "COMPOSE" })).toEqual([]);
  });
  it("BUILD_SOURCE: write rejects buildTime and runtime:false off GIT; deploy only throws for runtime:false", () => {
    const bt = meta({ K: { buildTime: true } });
    expect(codes({ K: "v" }, bt, { source: "IMAGE" })).toEqual(["BUILD_SOURCE"]);
    expect(codes({ K: "v" }, bt, { source: "COMPOSE", mode: "write" })).toEqual(["BUILD_SOURCE"]);
    expect(codes({ K: "v" }, bt, { source: "IMAGE", mode: "deploy" })).toEqual([]);
    expect(codes({ K: "v" }, bt, { source: "GIT" })).toEqual([]);
    expect(codes({ K: "v" }, bt, {})).toEqual([]);
    const only = meta({ K: { buildTime: true, runtime: false } });
    expect(codes({ K: "v" }, only, { source: "IMAGE", mode: "deploy" })).toEqual(["BUILD_SOURCE"]);
    expect(validateEnvFlags({ K: "v" }, only, { source: "IMAGE", mode: "deploy" })[0].message).toBe("variable K is build-only but this app has no build step");
  });
  it("BUILD_KEY follows BUILD_ARG_KEY (not the link deny list) and RUNTIME_OFF_NEEDS_BUILD", () => {
    expect(codes({ HTTP_PROXY: "x" }, meta({ HTTP_PROXY: { buildTime: true } }), { source: "GIT" })).toEqual([]);
    expect(codes({ "a.b": "x" }, meta({ "a.b": { buildTime: true } }), { source: "GIT" })).toEqual(["BUILD_KEY"]);
    expect(codes({ K: "x" }, meta({ K: { runtime: false } }), { source: "GIT" })).toEqual(["RUNTIME_OFF_NEEDS_BUILD"]);
    expect(BUILD_ARG_KEY.source).toBe(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.source);
  });
  it("BUILD_SIZE boundary", () => {
    expect(BUILD_FLAG_TOTAL_MAX_BYTES).toBe(BUILD_SECRETS_MAX_TOTAL_BYTES);
    const room = BUILD_FLAG_TOTAL_MAX_BYTES - "K=".length;
    expect(codes({ K: "a".repeat(room) }, meta({ K: { buildTime: true } }), { source: "GIT" })).toEqual([]);
    expect(codes({ K: "a".repeat(room + 1) }, meta({ K: { buildTime: true } }), { source: "GIT" })).toEqual(["BUILD_SIZE"]);
  });
  it("a buildTime key that names a build secret is not a write error", () => {
    expect(codes({ K: "v" }, meta({ K: { buildTime: true } }), { source: "GIT", buildSecretKeys: new Set(["K"]) })).toEqual([]);
  });
  it("issues come out in sorted key order", () => {
    const e = { Z: "a\nb", A: "a\nb" };
    expect(validateEnvFlags(e, meta({}), {}).map((i) => i.key)).toEqual(["A", "Z"]);
  });
});

describe("applyEnvFlags", () => {
  const base = { secretRefKeys: new Set<string>(), buildSecretKeys: new Set<string>(), builds: true };
  it("empty meta: env identical to merged, no build args", () => {
    const merged = { A: "1", B: "2" };
    const r = applyEnvFlags({ ...base, merged, appEnv: merged, meta: meta({}) });
    expect(r.env).toEqual(merged);
    expect(r.buildArgs).toEqual({});
    expect(r.buildFlagKeys).toEqual([]);
    expect(r.droppedForBuildSecret).toEqual([]);
  });
  it("runtime:false removes the key from env; build values come from appEnv only", () => {
    const r = applyEnvFlags({
      ...base,
      merged: { K: "merged-shared-or-link", R: "r", OTHER: "o" },
      appEnv: { K: "own", R: "r" },
      meta: meta({ K: { buildTime: true, runtime: false }, R: { buildTime: true } }),
    });
    expect(r.env).toEqual({ R: "r", OTHER: "o" });
    expect(r.buildArgs).toEqual({ K: "own", R: "r" });
    expect(r.buildFlagKeys).toEqual(["K", "R"]);
  });
  it("a buildTime key absent from appEnv (shared/link only) is never build-injected", () => {
    const r = applyEnvFlags({ ...base, merged: { S: "shared" }, appEnv: {}, meta: meta({ S: { buildTime: true } }) });
    expect(r.buildArgs).toEqual({});
  });
  it("builds:false (rollback / non-GIT) yields no build args", () => {
    const r = applyEnvFlags({ ...base, builds: false, merged: { K: "v" }, appEnv: { K: "v" }, meta: meta({ K: { buildTime: true } }) });
    expect(r.buildArgs).toEqual({});
  });
  it("a Vault-ref key with buildTime or runtime:false throws; literal/multiline are allowed", () => {
    const secretRefKeys = new Set(["V"]);
    expect(() => applyEnvFlags({ ...base, secretRefKeys, merged: { V: "x" }, appEnv: { V: "x" }, meta: meta({ V: { buildTime: true } }) })).toThrow(/comes from a secret reference/);
    expect(() => applyEnvFlags({ ...base, secretRefKeys, merged: { V: "x" }, appEnv: { V: "x" }, meta: meta({ V: { buildTime: true, runtime: false } }) })).toThrow(/V/);
    expect(() => applyEnvFlags({ ...base, secretRefKeys, merged: { V: "x" }, appEnv: { V: "x" }, meta: meta({ V: { multiline: true, literal: true } }) })).not.toThrow();
  });
  it("a build-secret collision is dropped from build args and reported", () => {
    const r = applyEnvFlags({ ...base, buildSecretKeys: new Set(["K"]), merged: { K: "v", J: "w" }, appEnv: { K: "v", J: "w" }, meta: meta({ K: { buildTime: true }, J: { buildTime: true } }) });
    expect(r.buildArgs).toEqual({ J: "w" });
    expect(r.droppedForBuildSecret).toEqual(["K"]);
    expect(r.buildFlagKeys).toEqual(["J"]);
  });
});

describe("autoMultilineLegacy (render-time upgrade of values stored before the Multiline flag)", () => {
  it("flags every unflagged line-break value whose name is host-export safe, merging with existing flags, never mutating the input", () => {
    const given = meta({ PEM: { literal: true } });
    const r = autoMultilineLegacy({ PEM: "a\nb", SSH_PRIVATE_KEY: "x\r\ny", OK: "plain" }, given);
    expect(r.issue).toBeNull();
    expect(r.keys).toEqual(["PEM", "SSH_PRIVATE_KEY"]);
    expect(r.meta).toEqual({ PEM: { literal: true, multiline: true }, SSH_PRIVATE_KEY: { multiline: true } });
    expect(given).toEqual({ PEM: { literal: true } });
  });
  it("returns the SAME meta (no change) when nothing needs upgrading, and skips already-multiline and build-only keys", () => {
    const m = meta({ ML: { multiline: true }, B: { buildTime: true, runtime: false } });
    const r = autoMultilineLegacy({ ML: "a\nb", B: "c\nd", P: "p" }, m);
    expect(r.keys).toEqual([]);
    expect(r.meta).toBe(m);
    expect(r.issue).toBeNull();
  });
  it("a name that cannot be multiline, a NUL or an oversize value is an issue naming the key (never the value)", () => {
    for (const [k, v] of [["PATH", "SECRETVAL\nx"], ["a.b", "SECRETVAL\nx"], ["K", "SECRETVAL\u0000\nx"], ["K", "SECRETVAL\n" + "a".repeat(ML_VALUE_MAX_BYTES)]] as const) {
      const r = autoMultilineLegacy({ [k]: v }, meta({}));
      expect(r.issue?.key).toBe(k);
      expect(r.issue?.message).toContain(JSON.stringify(k));
      expect(r.issue?.message).toContain("rename it or remove the line break");
      expect(r.issue?.message).not.toContain("SECRETVAL");
    }
  });
});
