import {
  CONTROL_PLANE_REMOVAL_COMMANDS,
  CONTROL_PLANE_STOP_COMMANDS,
  DECOMMISSION_MAX_CONTAINERS,
  REMOVAL_COMMANDS,
  STOP_COMMANDS,
  buildDecommissionDiscoverScript,
  buildDecommissionStopScript,
  parseControlPlaneMarker,
  parseDecommissionDiscover,
  parseDecommissionStop,
  removalCommandFor,
} from "./decommission-script";
import { expectGolden } from "./testing/golden";
import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("decommission scripts (golden)", () => {
  it("discover is read-only, never lists a tugra container", () => {
    const s = buildDecommissionDiscoverScript();
    expectGolden("decommission-discover.sh", s);
    expect(s).toContain("tugra*) continue");
    expect(s).not.toMatch(/docker (stop|rm|kill|update|start) /);
  });

  it("stop stops exact quoted ids and never removes anything", () => {
    const s = buildDecommissionStopScript(["abcdef012345", "b".repeat(64)]);
    expectGolden("decommission-stop.sh", s);
    expect(s).not.toMatch(/docker rm|volume rm|system prune|kill/);
  });

  it("refuses an invalid id, no ids and too many ids", () => {
    expect(() => buildDecommissionStopScript([])).toThrow();
    expect(() => buildDecommissionStopScript(["abc"])).toThrow();
    expect(() => buildDecommissionStopScript(["abcdef012345; reboot"])).toThrow();
    expect(() => buildDecommissionStopScript(Array.from({ length: DECOMMISSION_MAX_CONTAINERS + 1 }, () => "abcdef012345"))).toThrow();
  });

  it("the printed commands are stop/remove commands for the operator and are never part of a built script", () => {
    const script = buildDecommissionStopScript(["abcdef012345"]) + buildDecommissionDiscoverScript();
    for (const c of REMOVAL_COMMANDS) {
      expect(c).toContain("docker rm");
      expect(script).not.toContain(c);
    }
    for (const c of STOP_COMMANDS) expect(c).toContain("docker");
    expect(REMOVAL_COMMANDS.join(" ")).not.toMatch(/volume|-v /);
  });
});

describe("the printed control-plane commands tolerate containers the host does not have", () => {
  // A fake docker on PATH that knows only the named containers (4.7.5: no coolify-realtime, but a coolify-sentinel); a missing
  // one fails `container inspect` and, like the real docker, `stop`/`rm`. Run under the system sh (dash on the CI runners).
  const run = (cmd: string, existing: string[]): { code: number; calls: string[] } => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-dcm-"));
    try {
      writeFileSync(join(dir, "calls.txt"), "");
      writeFileSync(
        join(dir, "docker"),
        [
          "#!/bin/sh",
          'echo "$*" >> "$FAKE_DIR/calls.txt"',
          `case "$1" in container) n="$3" ;; *) n="$2" ;; esac`,
          `case " ${existing.join(" ")} " in *" $n "*) exit 0 ;; esac`,
          'echo "Error: No such container: $n" >&2; exit 1',
          "",
        ].join("\n"),
      );
      chmodSync(join(dir, "docker"), 0o755);
      let code = 0;
      try {
        execFileSync("sh", ["-c", cmd], { env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_DIR: dir }, stdio: "pipe" });
      } catch (e) {
        code = (e as { status: number }).status;
      }
      const calls = execFileSync("cat", [join(dir, "calls.txt")], { encoding: "utf8" }).split("\n").filter((l) => l && !l.startsWith("container inspect"));
      return { code, calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const V475 = ["coolify", "coolify-sentinel", "coolify-redis", "coolify-db", "coolify-proxy"]; // no coolify-realtime
  const V46 = ["coolify", "coolify-realtime", "coolify-redis", "coolify-db", "coolify-proxy"]; // no coolify-sentinel

  it("stops exactly what exists on 4.7.5 (sentinel included, no realtime) and exits 0", () => {
    const r = run(CONTROL_PLANE_STOP_COMMANDS[0], V475);
    expect(r).toEqual({ code: 0, calls: V475.map((n) => `stop ${n}`) });
  });
  it("still stops the 4.1 .. 4.6 set (realtime included) and exits 0", () => {
    expect(run(CONTROL_PLANE_STOP_COMMANDS[0], V46)).toEqual({ code: 0, calls: V46.map((n) => `stop ${n}`) });
  });
  it("the removal command is tolerant the same way, and removes volumes of nothing", () => {
    expect(run(CONTROL_PLANE_REMOVAL_COMMANDS[0], V475)).toEqual({ code: 0, calls: V475.map((n) => `rm ${n}`) });
    expect(run(CONTROL_PLANE_REMOVAL_COMMANDS[0], ["coolify-proxy"])).toEqual({ code: 0, calls: ["rm coolify-proxy"] });
    expect(run(CONTROL_PLANE_REMOVAL_COMMANDS[0], [])).toEqual({ code: 0, calls: [] });
  });
});

describe("parsers", () => {
  it("parseDecommissionDiscover reads containers and fails closed on a cut output", () => {
    const out = ["TUGRA_SRC id=abcdef012345 name=app-1 running=true", "TUGRA_SRC id=0123456789ab name=coolify-proxy running=false", "TUGRA_SRC_END"].join("\n");
    expect(parseDecommissionDiscover(out)).toEqual([{ id: "abcdef012345", name: "app-1", running: true }, { id: "0123456789ab", name: "coolify-proxy", running: false }]);
    expect(parseDecommissionDiscover(out.replace("\nTUGRA_SRC_END", ""))).toBeNull();
    expect(parseDecommissionDiscover(`${out}\n…(truncated)`)).toBeNull();
    expect(parseDecommissionDiscover("TUGRA_SRC_END")).toEqual([]);
  });

  it("ignores forged lines (bad id, bad name)", () => {
    const out = ["TUGRA_SRC id=ZZZ name=x running=true", "TUGRA_SRC id=abcdef012345 name=a;b running=true", "TUGRA_SRC_END"].join("\n");
    expect(parseDecommissionDiscover(out)).toEqual([]);
  });

  it("parseDecommissionStop maps each id to running/stopped/absent", () => {
    const out = ["TUGRA_SRC_STATE id=abcdef012345 running=false", "TUGRA_SRC_STATE id=0123456789ab running=true", "TUGRA_SRC_STATE id=aaaaaaaaaaaa running=absent", "TUGRA_SRC_STATE_END"].join("\n");
    expect(parseDecommissionStop(out)).toEqual({ abcdef012345: false, "0123456789ab": true, aaaaaaaaaaaa: "absent" });
    expect(parseDecommissionStop("TUGRA_SRC_STATE id=abcdef012345 running=false")).toBeNull();
  });

  it("removalCommandFor quotes valid names and drops invalid ones", () => {
    expect(removalCommandFor(["app-1", "db_2"])).toBe("docker rm 'app-1' 'db_2'");
    expect(removalCommandFor(["a;b", "$(id)"])).toBeNull();
    expect(removalCommandFor(["ok", "a b"])).toBe("docker rm 'ok'");
  });
});

describe("the control-plane marker of the discovery fails closed", () => {
  /** Runs the real discovery script with a fake `docker` first on the PATH (a temp dir, never the host's own docker). */
  const run = (dockerBody: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-fake-docker-"));
    try {
      writeFileSync(join(dir, "docker"), `#!/bin/sh\n${dockerBody}\n`);
      chmodSync(join(dir, "docker"), 0o755);
      return execFileSync("/bin/sh", ["-c", buildDecommissionDiscoverScript()], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("a daemon that cannot list containers is unknown, not 'no control plane here'", () => {
    const out = run("exit 1");
    expect(out).toContain("TUGRA_SRC_CP unknown");
    expect(parseControlPlaneMarker(out)).toBeNull();
  });

  it("a readable list says yes for the Coolify image and no for anything else", () => {
    expect(parseControlPlaneMarker(run('echo "coolify ghcr.io/coollabsio/coolify:4.7.5"'))).toBe(true);
    expect(parseControlPlaneMarker(run('echo "web nginx:1"'))).toBe(false);
    expect(parseControlPlaneMarker(run("exit 0"))).toBe(false);
  });

  it("the marker line parses unknown as null", () => {
    expect(parseControlPlaneMarker("TUGRA_SRC_CP unknown\nTUGRA_SRC_END")).toBeNull();
    expect(parseControlPlaneMarker("TUGRA_SRC_CP yes")).toBe(true);
    expect(parseControlPlaneMarker("TUGRA_SRC_CP no")).toBe(false);
  });
});
