import {
  serviceName,
  updateMonitorSec,
  buildServiceDeployScript,
  buildServiceScaleScript,
  buildServiceRestartScript,
  buildServiceRemoveScript,
  buildServicePsScript,
  buildServiceLogsScript,
  parseServiceImageDigest,
  type ServiceDeployOpts,
} from "./service-script";

function opts(over: Partial<ServiceDeployOpts> = {}): ServiceDeployOpts {
  return {
    serviceName: "tugra_abc",
    ref: "ghcr.io/org/tugra_abc:v1",
    replicas: 3,
    network: "tugra-swarm",
    env: {},
    pollSec: 60,
    ...over,
  };
}

describe("service-script builders", () => {
  it("serviceName mirrors the classic container name", () => {
    expect(serviceName({ id: "abc" })).toBe("tugra_abc");
  });

  it("update-monitor covers health start-period + all retries (else 'completed' is a false positive)", () => {
    expect(updateMonitorSec("curl -f localhost")).toBe(60); // 30 start + 3*10 retries
    expect(updateMonitorSec(null)).toBe(15);
  });

  it("deploy is existence-driven (inspect → update, else create) with all rollout-safety flags", () => {
    const s = buildServiceDeployScript(opts({ healthCmd: "curl -f localhost", memoryMb: 256, cpus: 1.5 }));
    expect(s).toContain("docker service inspect 'tugra_abc' >/dev/null 2>&1");
    expect(s).toContain("docker service create --detach");
    expect(s).toContain("docker service update --detach");
    expect(s).toContain("--name 'tugra_abc'");
    expect(s).toContain("--replicas 3");
    expect(s).toContain("--network 'tugra-swarm'");
    expect(s).toContain("--with-registry-auth");
    expect(s).toContain("--update-failure-action rollback");
    expect(s).toContain("--update-monitor 60s");
    expect(s).toContain("--restart-max-attempts 3");
    expect(s).toContain("--update-order start-first");
    expect(s).toContain("--limit-memory 256m");
    expect(s).toContain("--limit-cpu 1.5");
    expect(s).toContain("--health-cmd 'curl -f localhost'");
    expect(s).toContain("'ghcr.io/org/tugra_abc:v1'");
  });

  it("attaches SERVICE labels via --label (never --container-label, which the swarm provider can't see)", () => {
    const s = buildServiceDeployScript(opts({ labels: ["traefik.enable=true", "traefik.http.routers.r.rule=Host(`x.io`)"] }));
    expect(s).toContain("--label 'traefik.enable=true'");
    expect(s).not.toContain("--container-label");
  });

  it("passes env by NAME only, loaded from a 0600 file WITHOUT executing it (no RCE via env values)", () => {
    const s = buildServiceDeployScript(opts({ env: { FOO: "s3cr3tVALUE" } }));
    expect(s).toContain("--env 'FOO'"); // name only — value never in argv
    expect(s).not.toContain("--env 'FOO='");
    expect(s).not.toContain("s3cr3tVALUE"); // value is base64'd into the env file, never plaintext in the script
    expect(s).toContain("chmod 600");
    // The file is read as DATA (read + export), NEVER sourced — a value like `X=$(rm -rf /)` must stay inert.
    expect(s).toContain("while IFS='=' read -r TUGRA_K TUGRA_V");
    expect(s).toContain('export "$TUGRA_K=$TUGRA_V"');
    expect(s).not.toContain(". /etc/tugra/env"); // never `.`/source the KEY=VALUE file
    expect(s).not.toContain("set -a");
  });

  it("no env → no env-file loading and no --env flags", () => {
    const s = buildServiceDeployScript(opts({ env: {} }));
    expect(s).not.toContain("--env ");
    expect(s).not.toContain("read -r TUGRA_K");
  });

  it("poll uses UpdateStatus for the UPDATE path (not a task count, which would falsely converge instantly)", () => {
    const s = buildServiceDeployScript(opts());
    expect(s).toContain('if [ "$TUGRA_MODE" = update ]; then');
    expect(s).toContain('"$TUGRA_ST" = "completed"'); // update convergence via UpdateStatus, not ps count
    // ps-based Running count is the CREATE path only.
    expect(s).toContain("grep -c '^Running'");
  });

  it("UPDATE re-applies labels/publish/env (a config change on redeploy must take effect, not just the image)", () => {
    const s = buildServiceDeployScript(opts({ labels: ["traefik.enable=true"], publish: ["8080:80"], env: { FOO: "x" } }));
    expect(s).toContain("docker service update --detach --image");
    expect(s).toContain("--label-add 'traefik.enable=true'"); // update variant, not just --label on create
    expect(s).toContain("--publish-add '8080:80'");
    expect(s).toContain('set -- "$@" --env-add "$TUGRA_K=$TUGRA_V"'); // env re-applied on update (arg array, space-safe)
    // create branch still uses the name-only form (values off argv).
    expect(s).toContain("--env 'FOO'");
    expect(s).toContain('export "$TUGRA_K=$TUGRA_V"');
  });

  it("publishes routing-mesh ports for domain-less reachability", () => {
    const s = buildServiceDeployScript(opts({ publish: ["8080:80"] }));
    expect(s).toContain("--publish '8080:80'");
  });

  it("poll classifies converged (0) / rolled_back (3) / paused → failed, and captures the pinned digest", () => {
    const s = buildServiceDeployScript(opts());
    expect(s).toContain("docker service ps 'tugra_abc' --filter desired-state=running");
    expect(s).toContain('"$TUGRA_ST" = "rollback_completed"');
    expect(s).toContain('echo "TUGRA_ROLLOUT: rolled_back"; exit 3');
    expect(s).toContain('echo "TUGRA_ROLLOUT: converged"; exit 0');
    expect(s).toContain("{{.Spec.TaskTemplate.ContainerSpec.Image}}"); // digest capture
    expect(s).toContain("TUGRA_SVC_DIGEST=");
  });

  it("tears down a never-converged FIRST CREATE (create/update stay in lockstep with Docker)", () => {
    const s = buildServiceDeployScript(opts());
    expect(s).toContain('[ "$TUGRA_MODE" = create ] && docker service rm \'tugra_abc\'');
  });

  it("neutralizes shell injection in serviceName / ref / label / env-key / publish via shq", () => {
    const s = buildServiceDeployScript(
      opts({ serviceName: "x'; rm -rf / #", ref: "r'; evil", labels: ["l'; bad"], env: { "K'; boom": "v" }, publish: ["p'; nope"] }),
    );
    // Every dangerous value is wrapped by shq — the `; rm` sits INSIDE single quotes, never as a bare token.
    expect(s).toContain("--name 'x'\\''; rm -rf / #'");
    expect(s).toContain("--label 'l'\\''; bad'");
    expect(s).toContain("--env 'K'\\''; boom'");
    expect(s).toContain("--publish 'p'\\''; nope'");
  });

  it("scale / restart / remove / ps / logs builders", () => {
    expect(buildServiceScaleScript("tugra_abc", 0)).toBe("docker service scale --detach 'tugra_abc'=0");
    expect(buildServiceScaleScript("tugra_abc", 5)).toBe("docker service scale --detach 'tugra_abc'=5");
    const restart = buildServiceRestartScript("tugra_abc", 3, 60);
    expect(restart).toContain("docker service update --detach --force 'tugra_abc'");
    expect(restart).toContain("TUGRA_ROLLOUT"); // restart is async → same poll machinery
    expect(buildServiceRemoveScript("tugra_abc")).toBe("docker service rm 'tugra_abc' 2>/dev/null || true");
    expect(buildServicePsScript("tugra_abc")).toBe("docker service ps 'tugra_abc' --format '{{json .}}'");
    expect(buildServiceLogsScript("tugra_abc", 50)).toBe("docker service logs --tail 50 'tugra_abc'");
  });

  it("parseServiceImageDigest extracts the swarm-pinned ref@sha256", () => {
    expect(parseServiceImageDigest("noise\nTUGRA_SVC_DIGEST=ghcr.io/org/app@sha256:abcd\nmore")).toBe("ghcr.io/org/app@sha256:abcd");
    expect(parseServiceImageDigest("no marker here")).toBeNull();
  });
});
