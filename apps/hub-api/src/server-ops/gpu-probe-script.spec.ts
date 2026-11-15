import { spawnSync } from "node:child_process";
import { buildGpuProbeScript, GPU_PROBE_BEGIN, GPU_PROBE_END } from "./gpu-probe-script";

describe("gpu-probe-script", () => {
  const s = buildGpuProbeScript();

  it("is bracketed by the begin/end markers and always exits 0", () => {
    const lines = s.trimEnd().split("\n");
    expect(lines[1]).toBe(`echo "${GPU_PROBE_BEGIN}"`);
    expect(lines[lines.length - 2]).toBe(`echo "${GPU_PROBE_END}"`);
    expect(lines[lines.length - 1]).toBe("exit 0");
  });

  it("runs the nvidia-smi helper unprivileged, offline, read-only and pull-never", () => {
    for (const flag of ["--gpus all", "--network none", "--cap-drop ALL", "--read-only", "--pull never", "--label tugra.role=gpu-probe", "--security-opt no-new-privileges", "--pids-limit 64", '"$TUGRA_AGENT_IMAGE"', "--entrypoint timeout", "-k 5 25 nvidia-smi"]) {
      expect(s).toContain(flag);
    }
  });

  it("never leaves a permanent busy lock: unique per-run name, stale probe containers reaped, failed run removed", () => {
    expect(s).not.toContain("--name tugra-gpuprobe ");
    expect(s).toContain('--name "$pn"');
    expect(s).toContain('pn="tugra-gpuprobe-$$-$(date +%s)"');
    expect(s).toContain("docker ps -aq --filter label=tugra.role=gpu-probe");
    expect(s).toContain('docker rm -f "$o"');
    expect(s).toContain('docker rm -f "$pn"');
    // the stale-container sweep runs BEFORE the new container starts
    expect(s.indexOf("docker ps -aq --filter label=tugra.role=gpu-probe")).toBeLessThan(s.indexOf("docker run --rm"));
  });

  it("is syntactically valid for both sh and bash", () => {
    for (const sh of ["sh", "bash"]) {
      const r = spawnSync(sh, ["-n"], { input: s, encoding: "utf8" });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }
  });

  it("never escalates or borrows the patch/inspect machinery", () => {
    for (const bad of ["--privileged", "--pid=host", "nsenter", "tugra-patch", "docker inspect", "-v ", "--volume", "--mount"]) {
      expect(s).not.toContain(bad);
    }
  });

  it("keeps shell escapes intact (printf newlines, ${d##*/})", () => {
    expect(s).toContain("printf 'TUGRA_PCI %s %s %s %s\\n'");
    expect(s).toContain('b="${d##*/}"');
    expect(s).toContain("tr '\\n' ' '");
  });

  it("is a parameterless constant", () => {
    expect(buildGpuProbeScript.length).toBe(0);
    expect(buildGpuProbeScript()).toBe(buildGpuProbeScript());
    expect(s).not.toMatch(/\$\{(?!d##\*\/\})/);
  });
});
