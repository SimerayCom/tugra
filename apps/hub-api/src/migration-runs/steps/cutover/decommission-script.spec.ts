import {
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
