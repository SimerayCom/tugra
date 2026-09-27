import {
  serviceName,
  updateMonitorSec,
  buildOverlayEnsureScript,
  buildServiceDeployScript,
  buildServiceScaleScript,
  buildServiceRestartScript,
  buildServiceRemoveScript,
  buildServicePsScript,
  buildServiceLogsScript,
  parseServiceImageDigest,
  parseSwarmTasks,
  appEnvSecretPrefix,
  buildInspectEntrypointScript,
  parseImageEntrypointCmd,
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

  it("overlay ensure is idempotent and encrypted (IPsec ESP for inter-node traffic) by default", () => {
    expect(buildOverlayEnsureScript()).toBe("docker network create -d overlay --opt encrypted --attachable 'tugra-swarm' 2>/dev/null || true");
    expect(buildOverlayEnsureScript("custom-net")).toContain("--attachable 'custom-net'");
  });

  it("deploy is existence-driven (inspect → update, else create) with all rollout-safety flags", () => {
    const s = buildServiceDeployScript(opts({ healthCmd: "curl -f localhost", memoryMb: 256, cpus: 1.5, reserveMemoryMb: 128, reserveCpus: 0.5 }));
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
    expect(s).toContain("--reserve-memory 128m");
    expect(s).toContain("--reserve-cpu 0.5");
    expect(s).toContain("--health-cmd 'curl -f localhost'");
    expect(s).toContain("'ghcr.io/org/tugra_abc:v1'");
  });

  it("omits --reserve-* when reservations are unset (mirrors the --limit-* falsy guard)", () => {
    const s = buildServiceDeployScript(opts({ memoryMb: 256, cpus: 1 }));
    expect(s).not.toContain("--reserve-memory");
    expect(s).not.toContain("--reserve-cpu");
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
    // scale now polls to convergence (create-mode) instead of fire-and-forget, so a stop/start confirms the
    // tasks reached the target count.
    const scale0 = buildServiceScaleScript("tugra_abc", 0, 30);
    expect(scale0).toContain("docker service scale --detach 'tugra_abc'=0");
    expect(scale0).toContain("TUGRA_MODE=create");
    expect(scale0).toContain("TUGRA_ROLLOUT"); // proves it polls
    expect(buildServiceScaleScript("tugra_abc", 5, 30)).toContain("docker service scale --detach 'tugra_abc'=5");
    const restart = buildServiceRestartScript("tugra_abc", 3, 60);
    expect(restart).toContain("docker service update --detach --force 'tugra_abc'");
    expect(restart).toContain("TUGRA_ROLLOUT"); // restart is async → same poll machinery
    expect(buildServiceRemoveScript("tugra_abc")).toContain("docker service rm 'tugra_abc' 2>/dev/null || true");
    expect(buildServiceRemoveScript("tugra_abc")).toContain("docker secret ls --filter name='tugra-appenv-tugra_abc'"); // FLEET-F: prune env secrets too
    expect(buildServicePsScript("tugra_abc")).toBe("docker service ps 'tugra_abc' --format '{{json .}}'");
    expect(buildServiceLogsScript("tugra_abc", 50)).toBe("docker service logs --timestamps --tail 50 'tugra_abc'");
    expect(buildServiceLogsScript("tugra_abc", 50, "1h")).toBe("docker service logs --timestamps --tail 50 --since '1h' 'tugra_abc'");
  });

  it("parseServiceImageDigest extracts the swarm-pinned ref@sha256", () => {
    expect(parseServiceImageDigest("noise\nTUGRA_SVC_DIGEST=ghcr.io/org/app@sha256:abcd\nmore")).toBe("ghcr.io/org/app@sha256:abcd");
    expect(parseServiceImageDigest("no marker here")).toBeNull();
  });

  it("parseSwarmTasks maps each `docker service ps` JSON line to a structured task (slot/node/state)", () => {
    const out = [
      JSON.stringify({ Name: "tugra_abc.1", Node: "eu-1", DesiredState: "Running", CurrentState: "Running 4 minutes ago", Error: "" }),
      JSON.stringify({ Name: "tugra_abc.2", Node: "eu-2", DesiredState: "Running", CurrentState: "Preparing", Error: "" }),
      JSON.stringify({ Name: "tugra_abc.3", Node: "eu-3", DesiredState: "Shutdown", CurrentState: "Failed 2 minutes ago", Error: "task: non-zero exit (1)" }),
    ].join("\n");
    expect(parseSwarmTasks(out)).toEqual([
      { slot: "tugra_abc.1", node: "eu-1", desiredState: "Running", currentState: "Running 4 minutes ago", error: "" },
      { slot: "tugra_abc.2", node: "eu-2", desiredState: "Running", currentState: "Preparing", error: "" },
      { slot: "tugra_abc.3", node: "eu-3", desiredState: "Shutdown", currentState: "Failed 2 minutes ago", error: "task: non-zero exit (1)" },
    ]);
  });

  it("parseSwarmTasks skips malformed lines and tolerates missing fields", () => {
    const out = ["not json", "", JSON.stringify({ Name: "tugra_abc.1" }), "  "].join("\n");
    expect(parseSwarmTasks(out)).toEqual([{ slot: "tugra_abc.1", node: "", desiredState: "", currentState: "", error: "" }]);
    expect(parseSwarmTasks("")).toEqual([]);
  });

  // ── FLEET-D placement ──
  it("create embeds --constraint and --placement-pref for the given expressions", () => {
    const s = buildServiceDeployScript(opts({ constraints: ["node.hostname==web-1", "node.labels.zone==east"], placementPrefs: ["spread=node.labels.zone"] }));
    expect(s).toContain("docker service create --detach");
    expect(s).toContain("--constraint 'node.hostname==web-1'");
    expect(s).toContain("--constraint 'node.labels.zone==east'");
    expect(s).toContain("--placement-pref 'spread=node.labels.zone'");
  });

  it("update does a FULL remove-then-add diff: inspect current, rm each, then add the desired set", () => {
    const s = buildServiceDeployScript(opts({ constraints: ["node.hostname==web-2"], placementPrefs: ["spread=node.labels.zone"] }));
    // inspect the live service's current constraints + preferences
    expect(s).toContain("docker service inspect 'tugra_abc' --format '{{range .Spec.TaskTemplate.Placement.Constraints}}");
    expect(s).toContain("docker service inspect 'tugra_abc' --format '{{range .Spec.TaskTemplate.Placement.Preferences}}");
    // remove-every-current loops + add-desired
    expect(s).toContain('set -- "$@" --constraint-rm "$TUGRA_X"');
    expect(s).toContain('set -- "$@" --placement-pref-rm "$TUGRA_X"');
    expect(s).toContain(`set -- "$@" --constraint-add 'node.hostname==web-2'`);
    expect(s).toContain(`set -- "$@" --placement-pref-add 'spread=node.labels.zone'`);
  });

  it("update with an EMPTY desired set STILL strips the live service's stale constraints (no add)", () => {
    const s = buildServiceDeployScript(opts({ constraints: [], placementPrefs: [] }));
    expect(s).toContain('set -- "$@" --constraint-rm "$TUGRA_X"'); // remove loop still runs
    expect(s).not.toContain("--constraint-add"); // nothing to add
    expect(s).not.toContain("--placement-pref-add");
  });

  it("a changed pin never leaves BOTH constraints active (the AND-unschedulable regression)", () => {
    // A→B change: the script removes whatever is live (via the inspect loop) before adding B; it never emits a
    // hardcoded --constraint-add for the OLD value, so A and B can't both end up active.
    const s = buildServiceDeployScript(opts({ constraints: ["node.hostname==B"] }));
    expect(s).toContain(`set -- "$@" --constraint-add 'node.hostname==B'`);
    expect(s).not.toContain("node.hostname==A");
  });

  it("placement args append onto the SAME $@ list as env --env-add (one update invocation)", () => {
    const s = buildServiceDeployScript(opts({ env: { FOO: "bar" }, constraints: ["node.role==worker"] }));
    const envIdx = s.indexOf("--env-add");
    const placeIdx = s.indexOf("TUGRA_CUR_C=");
    expect(envIdx).toBeGreaterThan(-1);
    expect(placeIdx).toBeGreaterThan(envIdx); // placement build spliced AFTER env build
    expect((s.match(/docker service update --detach/g) ?? []).length).toBe(1);
  });

  it("placement expressions are shq-quoted in both create and update positions (injection-safe)", () => {
    // A value with a quote must be escaped via the '\'' idiom, never left to break out of quoting.
    const s = buildServiceDeployScript(opts({ constraints: ["node.labels.x==a'b"] }));
    expect(s).toContain(`--constraint 'node.labels.x==a'\\''b'`);
    expect(s).toContain(`--constraint-add 'node.labels.x==a'\\''b'`);
  });

  // ── FLEET-E named-volume mounts ──
  it("emits --mount on create and --mount-add on update for each named volume", () => {
    const s = buildServiceDeployScript(opts({ mounts: [{ source: "tugra_appv_app1_data", target: "/var/lib/data" }] }));
    expect(s).toContain("--mount 'type=volume,source=tugra_appv_app1_data,destination=/var/lib/data'");
    expect(s).toContain("--mount-add 'type=volume,source=tugra_appv_app1_data,destination=/var/lib/data'");
  });

  it("emits no --mount flags for a stateless service (mounts omitted)", () => {
    const s = buildServiceDeployScript(opts({ memoryMb: 128 }));
    expect(s).not.toContain("--mount");
  });

  // ── FLEET-F env → docker secret ──
  const es = { name: "tugra-appenv-tugra_abc-abc123def456", confighash: "abc123def456", credsB64: "Rk9PPWJhcg==" }; // envFileB64({FOO:"bar"})

  it("appEnvSecretPrefix builds the per-app secret prefix", () => {
    expect(appEnvSecretPrefix("tugra_abc")).toBe("tugra-appenv-tugra_abc");
  });

  it("no envSecret → no --secret / --entrypoint / envhash label (classic env path unchanged, ref last on create)", () => {
    const s = buildServiceDeployScript(opts({ env: { FOO: "bar" } }));
    expect(s).not.toContain("--secret ");
    expect(s).not.toContain("tugra.app.envhash");
    expect(s).not.toContain("--entrypoint");
    expect(s).toContain("--env 'FOO'"); // classic name-only env still used
  });

  it("CREATE with envSecret mounts the secret, wraps the entrypoint, and re-supplies the image's real cmd", () => {
    const s = buildServiceDeployScript(opts({ envSecret: es, imageEntrypoint: [], imageCmd: ["node", "server.js"] }));
    expect(s).toContain(`--secret source='${es.name}',target=app_env`);
    expect(s).toContain(`--label tugra.app.envhash='${es.confighash}'`);
    expect(s).toContain("--entrypoint sh");
    expect(s).toContain('exec "$@"'); // wrapper execs the real command
    expect(s).toContain("read -r k v"); // wrapper loads /run/secrets file (never `. /run/secrets`)
    expect(s).not.toContain(". /run/secrets");
    expect(s).toContain(" app 'node' 'server.js'"); // $0 placeholder (literal "app") + real entrypoint+cmd, each shq'd
    expect(s).toContain(es.credsB64); // base64 body present to MINT the secret
    expect(s).not.toContain("FOO=bar"); // but never the raw plaintext value
    expect(s).toContain(`docker secret inspect '${es.name}'`); // idempotent mint
  });

  it("UPDATE with envSecret scrubs plaintext env, reconciles the secret on hash change, and rewraps args", () => {
    const s = buildServiceDeployScript(opts({ envSecret: es, imageEntrypoint: [], imageCmd: ["node", "server.js"] }));
    expect(s).toContain("ContainerSpec.Env"); // scrub reads currently-attached env
    expect(s).toContain('--env-rm "$TUGRA_EK"'); // and removes each
    expect(s).toContain('index .Spec.Labels "tugra.app.envhash"'); // runtime confighash check
    expect(s).toContain(`set -- "$@" --secret-add source='${es.name}',target=app_env --label-add tugra.app.envhash='${es.confighash}'`);
    expect(s).toContain(`TUGRA_OLD_SECRET='tugra-appenv-tugra_abc'"-$TUGRA_CUR"`); // static prefix shq'd, runtime hash appended
    expect(s).toContain(`set -- "$@" --secret-rm "$TUGRA_OLD_SECRET"`);
    // review fix: the superseded secret OBJECT is deleted after the update (not just detached)
    expect(s).toContain(`docker secret rm "$TUGRA_OLD_SECRET"`);
    expect(s).toContain(`--args '`); // rewrapped entrypoint args on update
  });

  it("plaintext fallback for a shell-less image recreates a previously-wrapped service (review P1)", () => {
    const s = buildServiceDeployScript(opts({ env: { FOO: "bar" }, envFallbackNoShell: true }));
    expect(s).not.toContain("--secret source="); // no secret path
    expect(s).toContain('TUGRA_WAS_WRAPPED=$(docker service inspect'); // detect a stale wrapper
    expect(s).toContain('if [ -n "$TUGRA_WAS_WRAPPED" ]; then'); // and recreate instead of a broken update
    expect(s).toContain("--env 'FOO'"); // classic plaintext env still applied
  });

  it("a plain no-env update stays byte-identical (no wrapped-recreate probe)", () => {
    const s = buildServiceDeployScript(opts({ env: {} }));
    expect(s).not.toContain("TUGRA_WAS_WRAPPED"); // no extra probe for classic/no-env apps
    expect(s).not.toContain("tugra.app.envhash");
  });

  it("envSecret tokens are shq'd (injection-safe) in create and update", () => {
    const evil = { name: "x'; rm -rf / #", confighash: "h'h", credsB64: "eA==" };
    const s = buildServiceDeployScript(opts({ envSecret: evil, imageEntrypoint: ["a'b"], imageCmd: [] }));
    expect(s).toContain("'x'\\''; rm -rf / #'"); // name escaped
    expect(s).toContain("'a'\\''b'"); // entrypoint token escaped
  });

  it("buildInspectEntrypointScript pulls, reads entrypoint/cmd, and probes for a shell", () => {
    const s = buildInspectEntrypointScript("ghcr.io/o/app:1", { user: "u", token: "t" });
    expect(s).toContain("docker pull -q 'ghcr.io/o/app:1'");
    expect(s).toContain("login -u 'u' --password-stdin"); // registryLoginPrelude when auth given
    expect(s).toContain("TUGRA_ENTRYPOINT=$(docker inspect 'ghcr.io/o/app:1' --format '{{json .Config.Entrypoint}}')");
    expect(s).toContain("TUGRA_CMD=$(docker inspect 'ghcr.io/o/app:1' --format '{{json .Config.Cmd}}')");
    expect(s).toContain("--entrypoint /bin/sh 'ghcr.io/o/app:1' -c ':'"); // shell probe
    expect(s).toContain("TUGRA_HAS_SHELL=yes");
  });

  it("parseImageEntrypointCmd handles null, arrays, shell flag, and malformed input", () => {
    expect(parseImageEntrypointCmd('TUGRA_ENTRYPOINT=null\nTUGRA_CMD=["node","server.js"]\nTUGRA_HAS_SHELL=yes')).toEqual({ entrypoint: [], cmd: ["node", "server.js"], hasShell: true });
    expect(parseImageEntrypointCmd('TUGRA_ENTRYPOINT=["/bin/tini","--"]\nTUGRA_CMD=["sh -c echo"]\nTUGRA_HAS_SHELL=no')).toEqual({ entrypoint: ["/bin/tini", "--"], cmd: ["sh -c echo"], hasShell: false });
    expect(parseImageEntrypointCmd("garbage")).toEqual({ entrypoint: [], cmd: [], hasShell: false });
  });
});
