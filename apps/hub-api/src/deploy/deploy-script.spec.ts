import {
  buildImageRemoveScript,
  buildProxySetupScript,
  buildRemoveScript,
  buildRunScript,
  containerName,
  envFileContent,
  envFileB64,
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
