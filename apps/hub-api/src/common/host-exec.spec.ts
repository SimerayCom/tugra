import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_TEST_FN, hostUnavailableReason, onHostNamespaces, onHostNetwork, withHostContext } from "./host-exec";

/**
 * The scripts are really executed (under bash, against fake docker/timeout binaries on PATH): the agent's own shell is a container,
 * so what matters is WHAT it hands to docker and that nothing falls back to running in the container.
 */
let dir: string;
let bin: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "host-exec-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  // `timeout [-k N] SECS cmd...` without coreutils' timeout (absent on macOS)
  writeBin("timeout", 'while [ "$1" = "-k" ]; do shift 2; done; shift; exec "$@"');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeBin = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const run = (script: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_DIR: dir, ...env }, encoding: "utf8" });

/** A docker that records `run` and, like the real one, executes the helper's `-c` program with the piped stdin. */
const FAKE_DOCKER_NET = `
case "$1" in
  inspect) echo "tenant-image-by-hostname"; exit 0;;
  rm) echo "rm $*" >> "$FAKE_DIR/rm.log"; exit 0;;
  run)
    echo "$@" > "$FAKE_DIR/run-args"
    prog=""; while [ $# -gt 0 ]; do if [ "$1" = "-c" ]; then prog="$2"; break; fi; shift; done
    TUGRA_FAKE_TMP="$FAKE_DIR" exec bash -c "\${prog//\\/tmp\\//$FAKE_DIR/}";;
esac
exit 1`;

describe("onHostNetwork", () => {
  it("runs the script on the host network of a throwaway container of the agent's own image, with the docker socket", () => {
    writeBin("docker", FAKE_DOCKER_NET);
    const r = run(onHostNetwork("echo inner-ran; echo $((2+3))"), { TUGRA_AGENT_IMAGE: "sha256:agentimage" });
    expect(r.stdout).toContain("inner-ran");
    expect(r.stdout).toContain("5");
    const args = readFileSync(join(dir, "run-args"), "utf8");
    expect(args).toContain("--network host");
    expect(args).toContain("-v /var/run/docker.sock:/var/run/docker.sock");
    expect(args).toContain("--pull never");
    expect(args).toContain("--label tugra.role=host-net-helper");
    expect(args).toMatch(/--name tugra-hx-\d+-\d+/);
    expect(args).toContain("sha256:agentimage");
    expect(args).not.toContain("--privileged");
  });

  it("no agent image: it says so and exits 1, it never runs the script in the container and never resolves an image from the hostname", () => {
    writeBin("docker", FAKE_DOCKER_NET);
    const r = run(onHostNetwork("echo SHOULD-NOT-RUN"), {});
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("TUGRA_HOST_UNAVAILABLE reason=no-image");
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(existsSync(join(dir, "run-args"))).toBe(false);
    expect(onHostNetwork("x")).not.toContain("hostname");
    expect(onHostNetwork("x")).not.toContain("docker inspect");
  });

  it("a command that reads stdin cannot swallow the rest of the script (the script is a file, stdin is /dev/null)", () => {
    writeBin("docker", FAKE_DOCKER_NET);
    const r = run(onHostNetwork("echo before; cat; read -r x; echo after"), { TUGRA_AGENT_IMAGE: "img" });
    expect(r.stdout).toContain("before");
    expect(r.stdout).toContain("after");
  });

  it("the exit code of the script is the exit code of the command", () => {
    writeBin("docker", FAKE_DOCKER_NET);
    expect(run(onHostNetwork("exit 7"), { TUGRA_AGENT_IMAGE: "img" }).status).toBe(7);
  });

  it("a script with quotes and dollars arrives untouched (base64), and the helper is bounded by its own deadline", () => {
    writeBin("docker", FAKE_DOCKER_NET);
    const body = `X='a "b" $HOME'; printf '%s\\n' "$X" 'it'"'"'s'`;
    const r = run(onHostNetwork(body, { deadlineSec: 30 }), { TUGRA_AGENT_IMAGE: "img" });
    expect(r.stdout).toContain('a "b" $HOME');
    expect(r.stdout).toContain("it's");
    expect(onHostNetwork("x", { deadlineSec: 30 })).toContain("timeout -k 5 30 bash");
    expect(() => onHostNetwork("x", { deadlineSec: 1 })).toThrow();
  });
});

describe("onHostNamespaces", () => {
  it("is a privileged host-pid helper that nsenters PID 1, from the agent's own image only, never pulled", () => {
    const s = onHostNamespaces("echo hi");
    expect(s).toContain('IMG="${TUGRA_AGENT_IMAGE:-}"');
    expect(s).toContain("--pull never");
    expect(s).toContain("--privileged --pid=host --userns=host");
    expect(s).toContain("nsenter -t 1 -m -u -i -n -p");
    expect(s).toContain("--label tugra.role=host-ns-helper");
    expect(s).not.toContain("hostname");
    expect(s).not.toContain("docker inspect");
    expect(s).toContain("TUGRA_HOST_UNAVAILABLE reason=not-host-pid");
    expect(s).toContain("TUGRA_HOST_UNAVAILABLE reason=userns");
    expect(s).toContain("TUGRA_HOST_UNAVAILABLE reason=no-nsenter");
  });

  it("no agent image: fail closed, nothing is run", () => {
    writeBin("docker", `echo "$@" >> "$FAKE_DIR/docker.log"; exit 0`);
    const r = run(onHostNamespaces("echo SHOULD-NOT-RUN"), {});
    expect(r.status).toBe(1);
    expect(hostUnavailableReason(r.stdout)).toBe("no-image");
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(existsSync(join(dir, "docker.log"))).toBe(false);
  });

  it("the payload is the script, and the host-side runner executes it with the host's bash", () => {
    writeBin("docker", `[ "$1" = run ] && echo "$@" > "$FAKE_DIR/run-args"; exit 0`);
    const script = `echo "on the host: $((6*7))"`;
    run(onHostNamespaces(script), { TUGRA_AGENT_IMAGE: "img" });
    const args = readFileSync(join(dir, "run-args"), "utf8");
    const payload = /TUGRA_HX_B64=([A-Za-z0-9+/=]+)/.exec(args)![1];
    const runner = Buffer.from(/TUGRA_HX_RUN=([A-Za-z0-9+/=]+)/.exec(args)![1], "base64").toString("utf8");
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(script);
    // what nsenter would start on the host: the runner under /bin/sh, with the payload in its environment
    const r = spawnSync("/bin/sh", ["-c", runner], { env: { PATH: process.env.PATH, TUGRA_HX_B64: payload }, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("on the host: 42");
  });

  it("two helpers never share a name (no global mutex that a bulk command could starve)", () => {
    expect(onHostNamespaces("a")).toContain('--name "$HN"');
    expect(onHostNamespaces("a")).toContain("HN=\"tugra-hx-$$-$(date +%s)\"");
  });
});

describe("withHostContext / hostUnavailableReason", () => {
  it("no flag: the script as it is; hostNetwork and hostNamespaces wrap it; namespaces win", () => {
    expect(withHostContext("echo x")).toBe("echo x");
    expect(withHostContext("echo x", {})).toBe("echo x");
    expect(withHostContext("echo x", { hostNetwork: true })).toBe(onHostNetwork("echo x"));
    expect(withHostContext("echo x", { hostNamespaces: true })).toBe(onHostNamespaces("echo x"));
    expect(withHostContext("echo x", { hostNetwork: true, hostNamespaces: true })).toBe(onHostNamespaces("echo x"));
  });
  it("reads the reason out of an output", () => {
    expect(hostUnavailableReason("blah\nTUGRA_HOST_UNAVAILABLE reason=no-nsenter\n")).toBe("no-nsenter");
    expect(hostUnavailableReason("all good")).toBeNull();
  });
});

describe("HOST_TEST_FN: does a HOST path exist, asked through the daemon (the agent's filesystem cannot see it)", () => {
  // docker run ... --mount type=bind,src=<parent>,dst=/x,readonly --entrypoint test IMG <flag> /x/<base>
  const FAKE = `
case "$1" in
  run)
    echo "$@" >> "$FAKE_DIR/docker.log"
    [ -e "$FAKE_DIR/daemon-broken" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 125; }
    src=$(printf '%s' "$*" | sed -n 's/.*src=\\([^,]*\\),dst=.*/\\1/p')
    [ -d "$src" ] || { echo "docker: Error response from daemon: invalid mount config for type \\"bind\\": bind source path does not exist: $src" >&2; exit 125; }
    while [ "$1" != "IMG" ] && [ $# -gt 0 ]; do shift; done; shift
    flag="$1"; target="$2"; base="\${target#/x/}"
    case "$flag" in -d) [ -d "$src/$base" ];; -f) [ -f "$src/$base" ];; *) [ -e "$src/$base" ];; esac
    exit $?;;
esac
exit 1`;
  const probe = (flag: string, path: string, env: Record<string, string> = { TUGRA_AGENT_IMAGE: "IMG" }): number => {
    const r = run(`${HOST_TEST_FN}\ntugra_host_test ${flag} '${path}'; echo "rc=$?"`, env);
    return Number(/rc=(\d+)/.exec(r.stdout)![1]);
  };

  it("0 when it is there (file or directory as asked), 1 when it is not, 2 when it cannot tell", () => {
    writeBin("docker", FAKE);
    mkdirSync(join(dir, "data"));
    writeFileSync(join(dir, "data", "f.txt"), "x");
    expect(probe("-d", join(dir, "data"))).toBe(0);
    expect(probe("-f", join(dir, "data", "f.txt"))).toBe(0);
    expect(probe("-d", join(dir, "data", "f.txt"))).toBe(1); // a file is not a directory
    expect(probe("-d", join(dir, "nope"))).toBe(1); // parent exists, the path does not
    expect(probe("-d", join(dir, "no-parent", "nope"))).toBe(1); // the daemon refuses the bind: missing
    writeFileSync(join(dir, "daemon-broken"), "");
    expect(probe("-d", join(dir, "data"))).toBe(2); // a daemon trouble is not "missing"
  });
  it("2 with no agent image, a relative path, or a path the --mount syntax cannot carry", () => {
    writeBin("docker", FAKE);
    expect(probe("-d", join(dir, "data"), {})).toBe(2);
    expect(probe("-d", "relative/path")).toBe(2);
    expect(probe("-d", `${dir}/a,b`)).toBe(2);
    expect(existsSync(join(dir, "docker.log"))).toBe(false);
  });
  it("asks with a read-only bind, no network, no capabilities, never a pull", () => {
    writeBin("docker", FAKE);
    mkdirSync(join(dir, "data"));
    probe("-d", join(dir, "data"));
    const log = readFileSync(join(dir, "docker.log"), "utf8");
    expect(log).toContain("--pull never");
    expect(log).toContain("--network none");
    expect(log).toContain("--cap-drop ALL");
    // root without DAC_READ_SEARCH cannot traverse a 0700 parent owned by another account: that would read as "missing"
    expect(log).toContain("--cap-add DAC_READ_SEARCH");
    expect(log).toContain(`type=bind,src=${dir},dst=/x,readonly`);
    expect(log).toContain("--entrypoint test");
  });
});

describe("the size guard", () => {
  it("refuses a script that would not fit one command argument, naming the problem", () => {
    const huge = `echo ${"x".repeat(100_000)}`; // base64 of this alone is over the limit
    expect(() => onHostNamespaces(huge)).toThrow(/too large/);
    expect(() => onHostNetwork(huge)).toThrow(/too large/);
  });
  it("accepts a script comfortably under the limit", () => {
    expect(() => onHostNamespaces(`echo ${"x".repeat(60_000)}`)).not.toThrow();
  });
});
