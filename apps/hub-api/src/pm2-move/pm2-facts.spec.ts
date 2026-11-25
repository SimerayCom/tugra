import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPm2FactsScript, isSafePm2Name, parsePm2Facts, PM2_BEGIN, PM2_END, PM2_FAILED, PM2_MAX_OUT, PM2_OUTDATED, PM2_TOOLARGE, PM2_UNAVAILABLE } from "./pm2-facts";

const fact = (over: Record<string, unknown> = {}) => ({
  name: "app",
  nameExact: true,
  status: "online",
  script: "/home/acme/htdocs/a/s.js",
  cwd: "/home/acme/htdocs/a",
  interpreter: "node",
  mode: "fork",
  instances: 1,
  argsOverflow: false,
  args: ["--x"],
  nodeArgs: [],
  interpreterArgs: [],
  envCount: 2,
  envSkipped: 9,
  envDigest: "c".repeat(64),
  cwdExists: true,
  scriptExists: true,
  cwdUid: 1001,
  cwdGid: 1001,
  ...over,
});
const doc = (users: unknown[], errors: string[] = []) => `${PM2_BEGIN}\n${JSON.stringify({ v: 1, users, errors })}\n${PM2_END}\n`;
const user = (procs: unknown[], over: Record<string, unknown> = {}) => ({ user: "acme", home: "/home/acme", uid: 1001, gid: 1001, daemon: true, procs, ...over });

describe("buildPm2FactsScript", () => {
  it("is valid bash and runs the agent image read-only with no network", () => {
    const s = buildPm2FactsScript();
    expect(spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" }).status).toBe(0);
    expect(s).toContain("--network none");
    expect(s).toContain("--cap-drop ALL");
    expect(s).toContain("-v /:/host:ro");
    expect(s).toContain('IMG="$TUGRA_AGENT_IMAGE"');
    expect(s).not.toContain("--env");
  });
  it("narrows by user and name, quoted, and asks for the environment only for one named process", () => {
    const s = buildPm2FactsScript({ user: "acme", name: "my app", withEnv: true });
    expect(s).toContain("'--user=acme'");
    expect(s).toContain("'--name=my app'");
    expect(s).toContain(" --env ");
    expect(spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" }).status).toBe(0);
  });
  it("refuses an environment read without a target, and hostile user / name values", () => {
    expect(() => buildPm2FactsScript({ withEnv: true })).toThrow();
    expect(() => buildPm2FactsScript({ user: "acme", withEnv: true })).toThrow();
    expect(() => buildPm2FactsScript({ user: "a;id" })).toThrow();
    expect(() => buildPm2FactsScript({ user: "acme", name: "x'; id; '" })).toThrow();
    expect(() => buildPm2FactsScript({ user: "acme", name: "all" })).toThrow();
  });
});

describe("the facts script never cuts a document", () => {
  const FAKE_DOCKER = (rc: number, stdout: string, probe = "tugra-pm2-v1") =>
    `#!/bin/bash\nif [[ "$*" == *"pm2 --probe"* ]]; then printf '%s' ${JSON.stringify(probe)}; exit 0; fi\nif [[ "$*" == *"ps -aq"* ]]; then exit 0; fi\nif [[ "$1" == run && "$*" == *"--root=/host"* ]]; then printf '%s' ${JSON.stringify(stdout)}; exit ${rc}; fi\nexit 0\n`;
  const runIt = (docker: string) => {
    const d = mkdtempSync(join(tmpdir(), "pm2facts-"));
    try {
      writeFileSync(join(d, "docker"), docker);
      chmodSync(join(d, "docker"), 0o755);
      writeFileSync(join(d, "timeout"), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ] || [ "$1" -eq "$1" ] 2>/dev/null; do shift; done\nexec "$@"\n');
      chmodSync(join(d, "timeout"), 0o755);
      const script = buildPm2FactsScript({ user: "acme", name: "app", withEnv: true }).replace("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", `export PATH=${d}:$PATH`);
      return spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, TUGRA_AGENT_IMAGE: "agent:1" }, encoding: "utf8" }).stdout;
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  const small = JSON.stringify({ v: 1, users: [], errors: [] });
  it("passes a document within the cap through untouched", () => {
    expect(parsePm2Facts(runIt(FAKE_DOCKER(0, small)))).toMatchObject({ status: "ok" });
  });
  it("a reply over the cap is TOOLARGE, not a truncated JSON that reads as a generic failure", () => {
    const out = runIt(FAKE_DOCKER(0, "x".repeat(PM2_MAX_OUT + 10)));
    expect(out).toContain(PM2_TOOLARGE);
    expect(parsePm2Facts(out)).toEqual({ status: "unavailable", reason: "toolarge" });
  });
  it("the agent's own refusal of an oversized environment (exit 3) is TOOLARGE; any other failure stays a failure", () => {
    expect(parsePm2Facts(runIt(FAKE_DOCKER(3, "")))).toEqual({ status: "unavailable", reason: "toolarge" });
    expect(parsePm2Facts(runIt(FAKE_DOCKER(1, "")))).toEqual({ status: "unavailable", reason: "failed" });
    expect(parsePm2Facts(runIt(FAKE_DOCKER(3, "", "")))).toEqual({ status: "unavailable", reason: "outdated" });
  });
});

describe("isSafePm2Name", () => {
  it.each(["app", "My App-1", "api_v2", "a.b", "x@y:z+1"])("accepts %s", (n) => expect(isSafePm2Name(n)).toBe(true));
  it.each(["", "123", "all", "Default", "-rf", "a'b", 'a"b', "a;b", "a$b", "a\nb", " a", "a ", "a  b", "x".repeat(121)])("refuses %j", (n) => expect(isSafePm2Name(n)).toBe(false));
});

describe("parsePm2Facts", () => {
  it("parses users and processes", () => {
    const r = parsePm2Facts(doc([user([fact(), fact({ name: "w", env: { A: "1" } })])]));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.users).toHaveLength(1);
    expect(r.users[0].procs.map((p) => p.name)).toEqual(["app", "w"]);
    expect(r.users[0].procs[1].env).toEqual({ A: "1" });
    expect(r.truncated).toBe(false);
  });
  it("defaults the optional parts (older / sparse agent output)", () => {
    const r = parsePm2Facts(doc([user([{ name: "x", nameExact: true, status: "stopped", envCount: 0, envDigest: "d".repeat(64) }])]));
    expect(r.status === "ok" && r.users[0].procs[0]).toMatchObject({ script: "", cwd: "", interpreter: "", instances: 1, args: [], cwdExists: false });
  });
  it("drops a malformed process or user on its own and keeps the rest", () => {
    const r = parsePm2Facts(doc([user([fact(), { name: "bad" }, fact({ envDigest: "nothex" }), fact({ name: "ok2" })]), { user: "../../etc", home: "/etc", uid: 0, gid: 0, daemon: true, procs: [] }, user([], { user: "second", home: "/home/second" })]));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.users.map((u) => u.user)).toEqual(["acme", "second"]);
    expect(r.users[0].procs.map((p) => p.name)).toEqual(["app", "ok2"]);
  });
  it("rejects a home that is not /root or /home/<user>, or a user with path characters", () => {
    const r = parsePm2Facts(doc([user([], { home: "/srv/x" }), user([], { user: "a/b" })]));
    expect(r.status === "ok" && r.users).toEqual([]);
  });
  it("reports a trimmed listing", () => {
    const r = parsePm2Facts(doc([user([fact()])], ["truncated"]));
    expect(r.status === "ok" && r.truncated).toBe(true);
  });
  it("tells an outdated agent, a failed run and an unavailable helper apart", () => {
    expect(parsePm2Facts(`${PM2_BEGIN}\n${PM2_OUTDATED} rc=1\n${PM2_END}`)).toEqual({ status: "unavailable", reason: "outdated" });
    expect(parsePm2Facts(`${PM2_BEGIN}\n${PM2_FAILED} rc=1\n${PM2_END}`)).toEqual({ status: "unavailable", reason: "failed" });
    expect(parsePm2Facts(`${PM2_UNAVAILABLE} reason=no-image`)).toEqual({ status: "unavailable", reason: "unavailable" });
  });
  it("an oversized reply is reported as such, never read as a cut document", () => {
    expect(parsePm2Facts(`${PM2_BEGIN}\n${PM2_END}\n${PM2_TOOLARGE}\n`)).toEqual({ status: "unavailable", reason: "toolarge" });
  });
  it("garbage, a wrong schema version or a missing end marker is a failure, never a throw", () => {
    for (const out of ["", "hello", `${PM2_BEGIN}\n{not json\n${PM2_END}`, `${PM2_BEGIN}\n${JSON.stringify({ v: 2, users: [] })}\n${PM2_END}`, `${PM2_BEGIN}\n${JSON.stringify({ v: 1, users: [] })}`]) {
      expect(parsePm2Facts(out)).toEqual({ status: "unavailable", reason: "failed" });
    }
  });
});
