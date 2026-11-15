/**
 * Real-bash execution of the multiline env transport against a stub `docker` binary: the decoded value must reach the
 * docker CLI PROCESS ENVIRONMENT intact (so `-e KEY` can copy it), never argv, and never leak to later commands.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunScript, type AppSpec } from "./deploy-script";
import { buildComposeUpScript } from "./compose-script";
import { mlEnvFlags, mlPrefix, mlPrelude, planEnv } from "./env-render";
import { normalizeFlags } from "../common/env-flags";
import { isHostExportSafeKey } from "../common/env-key";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const bashAvailable = spawnSync("bash", ["-c", "echo ok"]).stdout?.toString().trim() === "ok";
const d = bashAvailable ? describe : describe.skip;

d("multiline env transport (real bash + stub docker)", () => {
  let dir: string;
  let log: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tugra-ml-"));
    log = join(dir, "log");
    // Stub docker: log argv, and for every `-e KEY` log the hex of KEY's value in the CLI process environment.
    writeFileSync(
      join(dir, "docker"),
      [
        "#!/bin/bash",
        'echo "ARGV:$*" >> "$LOG"',
        'if [ "$1" = run ]; then',
        '  prev=""',
        '  for a in "$@"; do',
        '    if [ "$prev" = "-e" ]; then printf "VAL %s %s\\n" "$a" "$(printf %s "${!a}" | od -An -v -tx1 | tr -d " \\n")" >> "$LOG"; fi',
        '    prev="$a"',
        "  done",
        "fi",
        'if [ "$1" = compose ]; then',
        '  for k in PW PEM_KEY PLAIN; do if [ -n "${!k+x}" ]; then printf "CENV %s %s\\n" "$k" "$(printf %s "${!k}" | od -An -v -tx1 | tr -d " \\n")" >> "$LOG"; fi; done',
        "fi",
        "exit 0",
      ].join("\n") + "\n",
    );
    chmodSync(join(dir, "docker"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (script: string) => {
    writeFileSync(log, "");
    const r = spawnSync("bash", ["-c", script], { env: { PATH: `${dir}:${process.env.PATH}`, LOG: log }, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: readFileSync(log, "utf8") };
  };

  const pem = `-----BEGIN PRIVATE KEY-----\n${"QUJD".repeat(4000).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  const values: Record<string, string> = {
    V0: `it's "quoted" $X \`backtick\` back\\slash`,
    V1: "cr\r\nlf\ntrailing newlines\n\n\n",
    V2: "",
    V3: "unicode: é中文🚀\nline2",
    V4: pem,
    V5: "  leading and trailing spaces  \n",
    V6: "$(touch /tmp/pwned_by_tugra_test) ; rm -rf / #\nx",
    V7: "a=b=c\nd=e",
  };

  it("round-trips every awkward value by hash, absent from argv, and not visible to a later command", () => {
    const meta = normalizeFlags(Object.fromEntries(Object.keys(values).map((k) => [k, { multiline: true }])), Object.keys(values));
    const plan = planEnv(values, meta, "docker");
    expect(plan.shell).toHaveLength(Object.keys(values).length);
    const script = [
      "set -e",
      ...mlPrelude(plan.shell),
      `${mlPrefix(plan.shell)}docker run -d --name x ${mlEnvFlags(plan.shell)} img`,
      // a LATER command must see neither the helper vars nor the user keys
      'if env | grep -E "^(TUGRA_ML_|V[0-9]=)" >/dev/null; then echo LEAKED; fi',
      'if [ -n "${TUGRA_ML_0+x}" ]; then echo "SHELLVAR_STILL_SET_IS_FINE"; fi',
    ].join("\n");
    const r = run(script);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("LEAKED");
    for (const [k, v] of Object.entries(values)) {
      expect(r.log).toContain(`VAL ${k} ${hex(v)}\n`);
    }
    const argv = r.log.split("\n").filter((l) => l.startsWith("ARGV:")).join("\n");
    expect(argv).toBe("ARGV:run -d --name x -e V0 -e V1 -e V2 -e V3 -e V4 -e V5 -e V6 -e V7 img");
    expect(r.log).not.toContain("pwned");
  });

  it("bash special / readonly names are refused by the policy, and the `env` prefix never lets bash evaluate them anyway", () => {
    const names = ["UID", "EUID", "PPID", "GROUPS", "RANDOM", "SECONDS", "LINENO", "FUNCNAME", "BASHPID", "SHELLOPTS", "BASHOPTS"];
    for (const k of names) {
      expect(isHostExportSafeKey(k)).toBe(false);
      expect(() => planEnv({ [k]: "a\nb" }, normalizeFlags({ [k]: { multiline: true } }, [k]), "docker")).toThrow(/cannot be a multiline or literal/);
    }
    // defence in depth: even if a name slipped past the policy, a bare `UID="..." cmd` aborts under set -e ("readonly
    // variable") and `GROUPS="..." cmd` is silently dropped; through `env` the value reaches the child intact.
    const shell = [{ key: "UID", value: "v1" }, { key: "GROUPS", value: "v2" }];
    const bare = run(["set -e", ...mlPrelude(shell), 'UID="$TUGRA_ML_0" docker run -e UID img'].join("\n"));
    expect(bare.status).not.toBe(0);
    const viaEnv = run(["set -e", ...mlPrelude(shell), `${mlPrefix(shell)}docker run ${mlEnvFlags(shell)} img`].join("\n"));
    expect(viaEnv.status).toBe(0);
    expect(viaEnv.log).toContain(`VAL UID ${hex("v1")}\n`);
    expect(viaEnv.log).toContain(`VAL GROUPS ${hex("v2")}\n`);
  });

  it("the generated script text carries base64 only, never a raw value", () => {
    const plan = planEnv({ K: "RAWVALUE\nSECOND" }, normalizeFlags({ K: { multiline: true } }, ["K"]), "docker");
    expect(mlPrelude(plan.shell).join("\n")).not.toContain("RAWVALUE");
  });

  it("works end to end through buildRunScript (env path redirected to a temp dir)", () => {
    const app: AppSpec = { id: "abc", image: "nginx:1", env: { PLAIN: "1", PEM_KEY: "l1\nl2\n" }, envMeta: { PEM_KEY: { multiline: true } }, hostPort: null, containerPort: 80 };
    const script = buildRunScript(app, "v1", true).replaceAll("/etc/tugra/env", join(dir, "env"));
    const r = run(script);
    expect(r.status).toBe(0);
    expect(r.log).toContain(`VAL PEM_KEY ${hex("l1\nl2\n")}\n`);
    expect(r.log).toMatch(/ARGV:run -d --name tugra_abc [^\n]*--env-file [^ ]+abc\.env -e PEM_KEY /);
    const envFile = readFileSync(join(dir, "env", "abc.env"), "utf8");
    expect(envFile).toBe("PLAIN=1");
  });

  it("flipping the last plain variable to multiline removes the previous env file on the host", () => {
    const first: AppSpec = { id: "flip", image: "nginx:1", env: { PEM_KEY: "old-plain-secret" }, hostPort: null, containerPort: 80 };
    const redirect = (s: string) => s.replaceAll("/etc/tugra/env", join(dir, "env"));
    expect(run(redirect(buildRunScript(first, "v1", true))).status).toBe(0);
    expect(readFileSync(join(dir, "env", "flip.env"), "utf8")).toBe("PEM_KEY=old-plain-secret");
    const flipped: AppSpec = { ...first, env: { PEM_KEY: "l1\nl2\n" }, envMeta: { PEM_KEY: { multiline: true } } };
    const r = run(redirect(buildRunScript(flipped, "v2", true)));
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "env", "flip.env"))).toBe(false);
    expect(r.log).toContain(`VAL PEM_KEY ${hex("l1\nl2\n")}\n`);
  });

  it("compose: a literal value keeps its $ and a multiline value stays intact in the compose process environment", () => {
    const app: AppSpec = {
      id: "abc",
      source: "COMPOSE",
      composeFile: "services:\n  web:\n    image: nginx",
      env: { PLAIN: "p", PW: "pa$$word${X}", PEM_KEY: "l1\nl2\n" },
      envMeta: { PW: { literal: true }, PEM_KEY: { multiline: true } },
      hostPort: null,
      containerPort: null,
    };
    const script = buildComposeUpScript(app).replaceAll("/etc/tugra", join(dir, "etc"));
    const r = run(script);
    expect(r.status).toBe(0);
    expect(r.log).toContain(`CENV PW ${hex("pa$$word${X}")}\n`);
    expect(r.log).toContain(`CENV PEM_KEY ${hex("l1\nl2\n")}\n`);
    expect(r.log).not.toContain("CENV PLAIN"); // the plain value rides the .env file, not the process env
    expect(readFileSync(join(dir, "etc", "compose", "abc", ".env"), "utf8")).toBe("PLAIN=p");
  });
});
