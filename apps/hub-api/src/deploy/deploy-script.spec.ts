import {
  buildImageRemoveScript,
  buildRestartScript,
  buildStartScript,
  buildProxySetupScript,
  buildProxyLogsScript,
  buildProxyRestartScript,
  buildProxyStatusScript,
  buildProxyStopScript,
  buildRemoveScript,
  buildRunScript,
  buildRollingDeployScript,
  buildRecreateDeployScript,
  buildHealthGateFragment,
  resolveHealthProbe,
  rolloutName,
  HEALTH_PROBE_IMAGE,
  containerName,
  envFileContent,
  envFileB64,
  gitAuthUrl,
  runTag,
  staticDockerfile,
  staticNginxConf,
  traefikLabels,
  type AppSpec,
} from "./deploy-script";

const base: AppSpec = {
  id: "abc",
  image: "nginx:1.27",
  env: {},
  hostPort: null,
  containerPort: 80,
};

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
      });
      // HTTP on a host-port app probes localhost over the host network, pinned to the app's
      // OWN published port — a custom healthCheckPort is IGNORED so it can't scan other ports
      expect(resolveHealthProbe({ ...base, hostPort: 8080, healthCheckType: "HTTP", healthCheckPath: "/health", healthCheckPort: 9999 })).toEqual({
        kind: "httpExternal",
        port: 8080,
        path: "/health",
        onHost: true,
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
    expect(s).toContain("docker pull 'nginx:1.27'");
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
    expect(nixpacks).toContain("nixpacks build /etc/tugra/builds/abc --name tugra_abc:v1 --env 'API_URL=https://api.x'");
    const railpack = buildRunScript({ ...git, buildType: "RAILPACK" }, "v1");
    expect(railpack).toContain("--env 'API_URL=https://api.x'");
  });

  it("adds no build-arg/env flags when there are no build args", () => {
    const s = buildRunScript({ ...base, source: "GIT", gitUrl: "https://x/y.git", buildType: "DOCKERFILE" }, "v1");
    expect(s).not.toContain("--build-arg");
    expect(s).not.toContain("--env ");
  });

  it("appends custom docker options to docker run verbatim", () => {
    const s = buildRunScript({ ...base, dockerOptions: "--cap-add=NET_ADMIN --dns 1.1.1.1" }, "v1");
    expect(s).toContain("--cap-add=NET_ADMIN --dns 1.1.1.1");
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
    expect(s).toContain("git clone --depth 1 --branch 'main' 'https://github.com/x/y.git'");
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

  it("proxy setup script runs Traefik with the HTTP-01 resolver by default (no DNS resolver)", () => {
    const s = buildProxySetupScript({ acmeEmail: "me@x.com" });
    expect(s).toContain("docker network create tugra-proxy");
    expect(s).toContain("traefik:v3.1");
    expect(s).toContain("acme.email='me@x.com'");
    expect(s).toContain("certificatesresolvers.le.acme.httpchallenge=true");
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
    expect(s).toContain("git clone --depth 1 --branch 'dev' 'https://github.com/u/r.git'");
    expect(s).toContain("nixpacks build /etc/tugra/builds/abc --name tugra_abc:v2");
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
    expect(s).toContain("docker build -t tugra_abc:v3 -f /etc/tugra/builds/abc/docker/Dockerfile");
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
});

describe("static helpers", () => {
  it("staticNginxConf falls back to index.html for SPA routes", () => {
    expect(staticNginxConf()).toContain("try_files $uri $uri/ /index.html");
  });

  it("staticDockerfile defaults the output dir to dist", () => {
    expect(staticDockerfile("npm run build")).toContain("COPY --from=build /app/dist");
  });
});
