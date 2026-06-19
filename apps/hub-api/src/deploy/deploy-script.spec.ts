import {
  buildImageRemoveScript,
  buildProxySetupScript,
  buildRemoveScript,
  buildRunScript,
  containerName,
  envFileContent,
  envFileB64,
  gitAuthUrl,
  runTag,
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
    expect(s).toContain("--health-interval=30s");
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

  it("proxy setup script runs Traefik with ACME", () => {
    const s = buildProxySetupScript("me@x.com");
    expect(s).toContain("docker network create tugra-proxy");
    expect(s).toContain("traefik:v3.1");
    expect(s).toContain("acme.email='me@x.com'");
    expect(s).toContain("acme.json");
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
});
