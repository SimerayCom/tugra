import { autoFlagMultiline, mapSourceEnvFlags } from "./env-auto-flags";

describe("autoFlagMultiline", () => {
  it("flags only values with a line break, keeps provided flags, never mutates its input", () => {
    const given = { A: { literal: true } };
    const out = autoFlagMultiline({ A: "x", PEM: "a\nb", B: "c\r\nd" }, given);
    expect(out).toEqual({ A: { literal: true }, PEM: { multiline: true }, B: { multiline: true } });
    expect(given).toEqual({ A: { literal: true } });
  });
  it("no line breaks -> no flags", () => {
    expect(autoFlagMultiline({ A: "x" })).toEqual({});
  });
  it("common PEM variable names are accepted as multiline (the deny list only covers names that steer the docker CLI)", () => {
    const names = ["SSH_PRIVATE_KEY", "GIT_SSH_KEY", "GIT_DEPLOY_KEY", "SSL_KEY", "SSL_CERT"];
    const out = autoFlagMultiline(Object.fromEntries(names.map((k) => [k, "-----BEGIN-----\nx\n-----END-----\n"])));
    expect(Object.keys(out).sort()).toEqual([...names].sort());
    for (const k of names) expect(out[k]).toEqual({ multiline: true });
  });
  it("a line break on a name that cannot be multiline throws, naming the key only", () => {
    for (const k of ["LD_PRELOAD", "a.b", "http_proxy", "SSH_AUTH_SOCK", "UID"]) {
      expect(() => autoFlagMultiline({ [k]: "SECRETVALUE\nx" })).toThrow(`env var "${k}" has a line break but its name cannot be a multiline variable`);
    }
    try {
      autoFlagMultiline({ LD_PRELOAD: "SECRETVALUE\nx" });
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRETVALUE");
    }
  });
});

describe("mapSourceEnvFlags", () => {
  const vals = { A: "1", B: "2", PEM: "x\ny" };
  it("carries Coolify's four flags for a Git app", () => {
    const r = mapSourceEnvFlags(vals, { A: { buildTime: true, runtime: false }, B: { literal: true }, PEM: { multiline: true } }, "GIT");
    expect(r.flags).toEqual({ A: { buildTime: true, runtime: false }, B: { literal: true }, PEM: { multiline: true } });
    expect(r.warnings).toEqual([]);
  });
  it("runtime:false is kept only with buildTime on a Git app; otherwise dropped with a warning", () => {
    const r = mapSourceEnvFlags(vals, { A: { runtime: false }, B: { buildTime: true, runtime: false } }, "IMAGE");
    expect(r.flags).toEqual({ PEM: { multiline: true } }); // B's buildTime dropped too, so its runtime:false cannot stay
    expect(r.warnings.join("|")).toContain('env var "A": runtime off flag not carried');
    expect(r.warnings.join("|")).toContain('env var "B": build time flag not carried');
    expect(r.warnings.join("|")).toContain('env var "B": runtime off flag not carried');
  });
  it("build time on an invalid build-arg name is dropped with a warning", () => {
    const r = mapSourceEnvFlags({ "a.b": "x" }, { "a.b": { buildTime: true } }, "GIT");
    expect(r.flags).toEqual({});
    expect(r.warnings).toHaveLength(1);
  });
  it("literal on a Compose app needs a host-safe name; inert elsewhere", () => {
    expect(mapSourceEnvFlags({ DOCKER_HOST: "x" }, { DOCKER_HOST: { literal: true } }, "COMPOSE").warnings).toHaveLength(1);
    expect(mapSourceEnvFlags({ DOCKER_HOST: "x" }, { DOCKER_HOST: { literal: true } }, "IMAGE").flags).toEqual({ DOCKER_HOST: { literal: true } });
  });
  it("a Coolify multiline flag on a single-line value of an unflaggable name is dropped with a warning; a real line break fails", () => {
    expect(mapSourceEnvFlags({ "a.b": "x" }, { "a.b": { multiline: true } }, "IMAGE").warnings).toHaveLength(1);
    expect(() => mapSourceEnvFlags({ "a.b": "x\ny" }, { "a.b": { multiline: true } }, "IMAGE")).toThrow(/cannot be a multiline variable/);
  });
  it("flags for keys without a value are ignored; no flags and no line breaks is empty", () => {
    expect(mapSourceEnvFlags({ A: "1" }, { GONE: { multiline: true } }, "GIT")).toEqual({ flags: {}, warnings: [] });
    expect(mapSourceEnvFlags({ A: "1" }, undefined, "GIT")).toEqual({ flags: {}, warnings: [] });
  });
});
