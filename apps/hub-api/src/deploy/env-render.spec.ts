import { assertScriptFits, mlEnvFlags, mlPrefix, mlPrelude, planEnv, SCRIPT_MAX_BYTES } from "./env-render";
import { normalizeFlags } from "../common/env-flags";

const meta = (o: Record<string, unknown>) => normalizeFlags(o, Object.keys(o));

describe("planEnv", () => {
  it("no meta and plain values: fileEnv equals env, nothing else", () => {
    for (const t of ["docker", "compose", "swarm"] as const) {
      const p = planEnv({ A: "1", B: "two words" }, undefined, t);
      expect(p.fileEnv).toEqual({ A: "1", B: "two words" });
      expect(p.shell).toEqual([]);
      expect(p.b64Keys.size).toBe(0);
    }
  });
  it("runtime:false keys are skipped", () => {
    const p = planEnv({ A: "1", B: "2" }, meta({ B: { buildTime: true, runtime: false } }), "docker");
    expect(p.fileEnv).toEqual({ A: "1" });
  });
  it("an unflagged newline throws, naming the key but never the value", () => {
    expect(() => planEnv({ SECRET_KEY: "line1\nTOPSECRET" }, undefined, "docker")).toThrow(/"SECRET_KEY" contains a line break but is not marked multiline/);
    try {
      planEnv({ SECRET_KEY: "line1\nTOPSECRET" }, undefined, "docker");
    } catch (e) {
      expect((e as Error).message).not.toContain("TOPSECRET");
    }
    expect(() => planEnv({ A: "a\rb" }, undefined, "swarm")).toThrow(/line break/);
  });
  it("NUL throws", () => {
    expect(() => planEnv({ A: "a\u0000b" }, meta({ A: { multiline: true } }), "docker")).toThrow(/NUL/);
  });
  it("host-affecting keys cannot be multiline or compose-literal even if stored flags say so", () => {
    for (const k of ["DOCKER_HOST", "LD_PRELOAD", "GIT_ASKPASS", "https_proxy", "BASH_ENV"]) {
      expect(() => planEnv({ [k]: "a\nb" }, meta({ [k]: { multiline: true } }), "docker")).toThrow(/cannot be a multiline or literal/);
      expect(() => planEnv({ [k]: "x" }, meta({ [k]: { literal: true } }), "compose")).toThrow(/cannot be a multiline or literal/);
    }
  });
  it("literal is inert for docker and swarm (value stays in the file)", () => {
    for (const t of ["docker", "swarm"] as const) {
      const p = planEnv({ P: "pa$$word${X}" }, meta({ P: { literal: true } }), t);
      expect(p.fileEnv).toEqual({ P: "pa$$word${X}" });
      expect(p.shell).toEqual([]);
    }
    // inert on docker/swarm also means a reserved name is allowed there
    expect(() => planEnv({ PATH: "x" }, meta({ PATH: { literal: true } }), "docker")).not.toThrow();
  });
  it("placement matrix", () => {
    const m = meta({ ML: { multiline: true }, LIT: { literal: true } });
    const env = { ML: "a\nb", LIT: "$x", PLAIN: "p" };
    const d = planEnv(env, m, "docker");
    expect(d.fileEnv).toEqual({ LIT: "$x", PLAIN: "p" });
    expect(d.shell).toEqual([{ key: "ML", value: "a\nb" }]);
    const c = planEnv(env, m, "compose");
    expect(c.fileEnv).toEqual({ PLAIN: "p" });
    expect(c.shell.map((s) => s.key)).toEqual(["LIT", "ML"]);
    const s = planEnv(env, m, "swarm");
    expect(s.fileEnv).toEqual(env);
    expect([...s.b64Keys]).toEqual(["ML"]);
    expect(s.shell).toEqual([]);
  });
  it("ignores buildTime on compose", () => {
    const p = planEnv({ K: "v" }, meta({ K: { buildTime: true } }), "compose");
    expect(p.fileEnv).toEqual({ K: "v" });
  });
});

describe("mlPrelude / mlPrefix / mlEnvFlags", () => {
  const shell = [{ key: "A", value: "x\ny" }, { key: "B_B", value: "it's" }];
  it("are empty for no shell vars", () => {
    expect(mlPrelude([])).toEqual([]);
    expect(mlPrefix([])).toBe("");
    expect(mlEnvFlags([])).toBe("");
  });
  it("shapes", () => {
    const lines = mlPrelude(shell);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("echo 'TUGRA_ENV_ML: 2 multiline variable(s) via the docker CLI environment (never argv, never the env file): A, B_B'");
    expect(lines[1]).toBe(`TUGRA_ML_0=$(printf %s '${Buffer.from("x\ny").toString("base64")}' | base64 -d; printf x); TUGRA_ML_0=\${TUGRA_ML_0%x}`);
    expect(mlPrefix(shell)).toBe('env A="$TUGRA_ML_0" B_B="$TUGRA_ML_1" ');
    expect(mlEnvFlags(shell)).toBe("-e A -e B_B");
  });
  it("the marker carries key names only, never values", () => {
    expect(mlPrelude(shell)[0]).not.toContain("x\ny");
    expect(mlPrelude(shell)[0]).not.toContain("it's");
  });
  it("payload is base64 only (no raw value in the script)", () => {
    expect(mlPrelude([{ key: "K", value: "TOPSECRET\nPEM" }]).join("\n")).not.toContain("TOPSECRET");
  });
  it("a non-identifier key is refused at the final guard", () => {
    expect(() => mlPrefix([{ key: "a.b", value: "x" }])).toThrow();
    expect(() => mlEnvFlags([{ key: "a b", value: "x" }])).toThrow();
  });
});

describe("assertScriptFits", () => {
  it("passes at the limit and throws one byte over", () => {
    expect(() => assertScriptFits("a".repeat(SCRIPT_MAX_BYTES))).not.toThrow();
    expect(() => assertScriptFits("a".repeat(SCRIPT_MAX_BYTES + 1))).toThrow(`TUGRA: deploy script is ${SCRIPT_MAX_BYTES + 1} bytes; limit 122880 (the script travels as one bash -c argument)`);
  });
});
