import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGpuProbe } from "./gpu-inventory";
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

  it("lists runtime names only and keeps the newline outside the head -c bound", () => {
    expect(s).not.toContain("json .Runtimes");
    expect(s).toContain("{{range $k,$v := .Runtimes}}{{$k}} {{end}}");
    expect(s).toContain(`printf 'TUGRA_RUNTIMES %s\\n' "$(printf %s "$rt" | head -c 2000)"`);
  });

  // Runs the REAL script in one bash with `docker`/`timeout` shell functions standing in for the CLI. The fake
  // answers like Docker 29: the legacy json format would be a 7.5 KB blob, the names format a short list.
  it("on a Docker-29-shaped daemon emits an intact runtimes line, a real DEFRT line, and still runs nvidia-smi", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpuprobe-"));
    try {
      const log = join(dir, "docker.log");
      const harness = `
docker() {
  case "$1" in
    info)
      case "$3" in
        *json*) printf '{"io.containerd.runc.v2":{"status":"%s"}}' "$(head -c 7500 /dev/zero | tr '\\0' x)";;
        *Runtimes*) printf 'io.containerd.runc.v2 nvidia runc ';;
        *DefaultRuntime*) echo runc;;
      esac;;
    run) echo "docker run" >> "${log}"; echo "0, GPU-12345678-aaaa-bbbb-cccc-1234567890ab, NVIDIA GeForce RTX 4090, 24564, 550.54.15";;
    ps|rm) :;;
  esac
}
timeout() { if [ "$1" = "-k" ]; then shift 2; fi; shift; "$@"; }
export TUGRA_AGENT_IMAGE=img:1
eval "$SCRIPT"
`;
      const r = spawnSync("bash", ["--norc", "-c", harness], { env: { ...process.env, SCRIPT: s }, encoding: "utf8" });
      const lines = r.stdout.split("\n");
      expect(lines).toContain("TUGRA_RUNTIMES io.containerd.runc.v2 nvidia runc ");
      expect(lines).toContain("TUGRA_DEFRT runc");
      expect(existsSync(log)).toBe(true); // the in-script nvidia detection still fires on the name list
      const inv = parseGpuProbe(r.stdout);
      if (!inv || "busy" in inv) throw new Error("expected an inventory");
      expect(inv.runtimes).toEqual(["io.containerd.runc.v2", "nvidia", "runc"]);
      expect(inv.defaultRuntime).toBe("runc");
      expect(inv.nvidiaRuntime).toBe(true);
      expect(inv.gpus.some((g) => g.source === "nvidia-smi")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a parameterless constant", () => {
    expect(buildGpuProbeScript.length).toBe(0);
    expect(buildGpuProbeScript()).toBe(buildGpuProbeScript());
    expect(s).not.toMatch(/\$\{(?!d##\*\/\})/);
  });
});
