import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProbeScript, buildRefreshScript, decideConverge, parseProbeOutput, parseRefreshOutput, plannedServices, type RefreshPlan } from "./stack-converge-script";
import { isBehind } from "./stack-converge.service";

const BASH = execFileSync("sh", ["-c", "command -v bash"]).toString().trim();
const U = "a".repeat(64);
const A = "b".repeat(64);
const H = "c".repeat(64);
const basePlan: RefreshPlan = { project: "tugra", version: "0.1.0-beta.20", refreshUpdater: true, refreshAgent: true, updaterDigest: U, agentDigest: A, hostFilesDigest: H };

describe("decideConverge (what lags the hub)", () => {
  it("an updater or agent on an OLDER release lags; the same or a newer one does not; unknown/unparseable never triggers anything", () => {
    const d = (updaterVersion: string | null, agentVersion: string | null, updaterPresent = true) =>
      decideConverge({ own: "0.1.0-beta.20", updaterVersion, updaterPresent, agentVersion }, isBehind);
    expect(d("0.1.0-beta.17", "0.1.0-beta.18")).toEqual({ refreshUpdater: true, refreshAgent: true });
    expect(d("0.1.0-beta.20", "0.1.0-beta.19")).toEqual({ refreshUpdater: false, refreshAgent: true });
    expect(d("0.1.0-beta.19", "0.1.0-beta.20")).toEqual({ refreshUpdater: true, refreshAgent: false });
    expect(d("0.1.0-beta.20", "0.1.0-beta.20")).toEqual({ refreshUpdater: false, refreshAgent: false });
    expect(d("0.1.0-beta.21", "0.2.0")).toEqual({ refreshUpdater: false, refreshAgent: false }); // never "downgrade" the helpers
    expect(d(null, null)).toEqual({ refreshUpdater: false, refreshAgent: false }); // a source build / unlabeled image
    expect(d("garbage", "dev")).toEqual({ refreshUpdater: false, refreshAgent: false });
    expect(d("0.1.0-beta.1", "0.1.0-beta.18", false)).toEqual({ refreshUpdater: false, refreshAgent: true }); // no updater container: nothing to refresh
  });
});

describe("parseProbeOutput", () => {
  it("reads the version label; falls back to a version-looking tag; never trusts odd values", () => {
    expect(parseProbeOutput("TUGRA_PROBE updater=present\nTUGRA_PROBE version=0.1.0-beta.17\nTUGRA_PROBE image=ghcr.io/simeraycom/tugra-updater:0.1.0-beta.17\nTUGRA_PROBE running=true\n")).toEqual({
      present: true,
      version: "0.1.0-beta.17",
      image: "ghcr.io/simeraycom/tugra-updater:0.1.0-beta.17",
      running: true,
    });
    expect(parseProbeOutput("TUGRA_PROBE updater=present\nTUGRA_PROBE version=<no value>\nTUGRA_PROBE image=ghcr.io/simeraycom/tugra-updater:0.1.0-beta.12\nTUGRA_PROBE running=false").version).toBe("0.1.0-beta.12");
    expect(parseProbeOutput("TUGRA_PROBE updater=present\nTUGRA_PROBE version=\nTUGRA_PROBE image=tugra-updater:latest").version).toBeNull();
    expect(parseProbeOutput("TUGRA_PROBE updater=present\nTUGRA_PROBE version=1.0.0; rm -rf /\nTUGRA_PROBE image=x").version).toBeNull();
    expect(parseProbeOutput("TUGRA_PROBE updater=absent")).toEqual({ present: false, version: null, image: null, running: false });
    expect(parseProbeOutput("docker: command not found")).toEqual({ present: false, version: null, image: null, running: false });
  });
});

describe("buildRefreshScript (the exact commands)", () => {
  it("is valid bash for every combination", () => {
    for (const refreshUpdater of [true, false])
      for (const refreshAgent of [true, false]) {
        if (!refreshUpdater && !refreshAgent) continue;
        for (const withHost of [true, false]) {
          const script = buildRefreshScript({ ...basePlan, refreshUpdater, refreshAgent, hostFilesDigest: withHost ? H : undefined });
          expect(spawnSync(BASH, ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
        }
      }
    expect(spawnSync(BASH, ["-n"], { input: buildProbeScript("tugra"), encoding: "utf8" }).status).toBe(0);
  });

  it("pulls the agent ONLY by its signed per-platform digest and the updater by its signed index digest; the agent needs a digest", () => {
    const s = buildRefreshScript(basePlan);
    expect(s).toContain(`pull_release "$UPD_REPO" '${U}'`);
    expect(s).toContain(`pull_release "$AGENT_REPO" '${A}'`);
    expect(s).toContain('docker pull "$repo@sha256:$d"');
    expect(s).toContain(`"TUGRA_STEP error=version-mismatch`);
    expect(() => buildRefreshScript({ ...basePlan, agentDigest: undefined })).toThrow(/signed platform digest/);
    // an updater-only refresh is allowed without digests (plain tag pull; the updater index never failed)
    expect(buildRefreshScript({ ...basePlan, refreshAgent: false, agentDigest: undefined, updaterDigest: undefined, hostFilesDigest: undefined })).toContain(`pull_release "$UPD_REPO" ''`);
  });

  it("recreates only the lagging services, with --no-deps, through a detached delayed helper; never compose pull/down/rm/stop", () => {
    expect(plannedServices(basePlan)).toEqual(["tugra-updater", "agent"]);
    expect(plannedServices({ refreshUpdater: false, refreshAgent: true })).toEqual(["agent"]);
    const s = buildRefreshScript(basePlan);
    expect(s).toMatch(/docker run -d --rm --name tugra-updater-refresh .*up -d --no-deps "\$@"' sh "\$SRC" tugra-updater agent /);
    expect(s).not.toMatch(/compose (pull|down|stop|rm|kill|restart)/);
    expect(s).not.toMatch(/postgres|redis|hub-api/);
    const onlyAgent = buildRefreshScript({ ...basePlan, refreshUpdater: false });
    expect(onlyAgent).toMatch(/sh "\$SRC" agent >/);
    expect(onlyAgent).not.toMatch(/sh "\$SRC" tugra-updater/);
  });

  it("applies the signed host files in the NEW updater image only for a lagging updater, before the recreate", () => {
    const s = buildRefreshScript(basePlan);
    const hf = s.indexOf("--apply-host-files");
    expect(hf).toBeGreaterThan(-1);
    expect(s).toContain("/opt/tugra/scripts/update.sh --apply-host-files \"$VERSION\" 'cccccccc");
    expect(s).toContain('-e TUGRA_REPO_DIR="$SRC"');
    expect(hf).toBeGreaterThan(s.indexOf("pull_release"));
    expect(hf).toBeLessThan(s.indexOf("docker run -d --rm"));
    expect(buildRefreshScript({ ...basePlan, hostFilesDigest: undefined })).not.toContain("--apply-host-files");
  });

  it("rejects anything that is not a plain version / 64-hex digest / compose project (nothing reaches the shell unvalidated)", () => {
    expect(() => buildRefreshScript({ ...basePlan, version: "1.0.0; reboot" })).toThrow();
    expect(() => buildRefreshScript({ ...basePlan, updaterDigest: "abc" })).toThrow();
    expect(() => buildRefreshScript({ ...basePlan, agentDigest: "$(id)" })).toThrow();
    expect(() => buildRefreshScript({ ...basePlan, hostFilesDigest: "x".repeat(64) })).toThrow();
    expect(() => buildRefreshScript({ ...basePlan, project: "tu gra" })).toThrow();
    expect(() => buildRefreshScript({ ...basePlan, updaterRepo: "ghcr.io/x/y;id" })).toThrow();
    expect(() => buildProbeScript("a;b")).toThrow();
    expect(() => buildRefreshScript({ ...basePlan, refreshUpdater: false, refreshAgent: false })).toThrow(/nothing to refresh/);
  });

  describe("run against a docker shim (runner-independent)", () => {
    const dir = mkdtempSync(join(tmpdir(), "converge-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    // docker: logs everything; ps -aq prints a container id (unless SHIM_NO_UPDATER); inspect answers the mount/label/id queries.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
echo "docker $*" >> "$SHIM_LOG"
case "$1" in
  ps) [ -n "$SHIM_NO_UPDATER" ] || echo cid1; exit 0 ;;
  inspect) echo "\${SHIM_SRC-/srv/tugra}"; exit 0 ;;
  pull) [ -n "$SHIM_PULL_FAIL" ] && exit 1; exit 0 ;;
  image) case "$*" in *"{{.Id}}"*) echo "sha256:imgid"; exit 0 ;; *) echo "\${SHIM_LABEL:-0.1.0-beta.20}"; exit 0 ;; esac ;;
  run) case "$*" in *--apply-host-files*) [ -n "$SHIM_HF_FAIL" ] && exit 1 ;; esac; [ -n "$SHIM_HELPER_FAIL" ] && [[ "$*" == *"-d --rm"* ]] && exit 1; exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    const exec = (plan: RefreshPlan, env: Record<string, string> = {}) => {
      const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
      writeFileSync(log, "");
      const r = spawnSync(BASH, ["-c", buildRefreshScript(plan)], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, SHIM_LOG: log, ...env } as NodeJS.ProcessEnv });
      return { r, calls: readFileSync(log, "utf8").split("\n").filter(Boolean), res: parseRefreshOutput(r.status ?? -1, r.stdout) };
    };

    it("happy path: pulls by digest, tags, applies host files, schedules the helper for both services", () => {
      const { calls, res } = exec(basePlan);
      expect(res).toEqual({ ok: true, scheduled: ["tugra-updater", "agent"], hostFiles: "applied", error: null });
      expect(calls).toContain(`docker pull ghcr.io/simeraycom/tugra-updater@sha256:${U}`);
      expect(calls).toContain(`docker pull ghcr.io/simeraycom/tugra-agent@sha256:${A}`);
      expect(calls).toContain("docker tag sha256:imgid ghcr.io/simeraycom/tugra-updater:0.1.0-beta.20");
      expect(calls).toContain("docker tag sha256:imgid ghcr.io/simeraycom/tugra-agent:0.1.0-beta.20");
      expect(calls.some((c) => c.includes("--entrypoint bash ghcr.io/simeraycom/tugra-updater:0.1.0-beta.20 /opt/tugra/scripts/update.sh --apply-host-files 0.1.0-beta.20 " + H))).toBe(true);
      const helper = calls.find((c) => c.startsWith("docker run -d --rm --name tugra-updater-refresh")) as string;
      expect(helper).toContain("-v /srv/tugra:/srv/tugra");
      expect(helper).toMatch(/sh \/srv\/tugra tugra-updater agent$/);
      // outside the helper's own command line the agent runs no compose, and stops/removes nothing but a stale helper
      expect(calls.filter((c) => !c.startsWith("docker run -d --rm --name tugra-updater-refresh")).some((c) => /docker compose|docker (stop|restart|kill)|docker rm -f (?!tugra-updater-refresh)/.test(c))).toBe(false);
      expect(calls.findIndex((c) => c.includes("--apply-host-files"))).toBeLessThan(calls.findIndex((c) => c.startsWith("docker run -d")));
    });

    it("a pulled image whose version label is another release aborts BEFORE anything is changed (no host files, no helper)", () => {
      const { calls, res } = exec(basePlan, { SHIM_LABEL: "0.1.0-beta.18" });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/version-mismatch|pull-updater/);
      expect(calls.some((c) => c.includes("--apply-host-files") || c.startsWith("docker run -d"))).toBe(false);
      expect(calls.some((c) => c.startsWith("docker tag "))).toBe(false);
    });

    it("a failed pull aborts with nothing changed", () => {
      const { calls, res } = exec(basePlan, { SHIM_PULL_FAIL: "1" });
      expect(res).toMatchObject({ ok: false, error: "pull-updater" });
      expect(calls.some((c) => c.startsWith("docker run"))).toBe(false);
    });

    it("failed host files do not stop the refresh (the image refresh still helps) and are reported", () => {
      const { res } = exec(basePlan, { SHIM_HF_FAIL: "1" });
      expect(res).toMatchObject({ ok: true, hostFiles: "failed", scheduled: ["tugra-updater", "agent"] });
    });

    it("no updater container / no checkout path are reported, nothing is pulled", () => {
      const a = exec(basePlan, { SHIM_NO_UPDATER: "1" });
      expect(a.res).toMatchObject({ ok: false, error: "no-updater-container" });
      expect(a.calls.some((c) => c.startsWith("docker pull"))).toBe(false);
      const b = exec(basePlan, { SHIM_SRC: "" });
      expect(b.res).toMatchObject({ ok: false, error: "no-checkout-path" });
    });

    it("a helper that cannot be started is a failure (nothing was recreated)", () => {
      expect(exec(basePlan, { SHIM_HELPER_FAIL: "1" }).res).toMatchObject({ ok: false, error: "helper-start" });
    });
  });
});

describe("parseRefreshOutput", () => {
  it("success needs exit 0 AND a scheduled line", () => {
    expect(parseRefreshOutput(0, "TUGRA_STEP scheduled=agent\n").ok).toBe(true);
    expect(parseRefreshOutput(0, "").ok).toBe(false);
    expect(parseRefreshOutput(4, "TUGRA_STEP error=pull-agent\n")).toMatchObject({ ok: false, error: "pull-agent" });
  });
});
