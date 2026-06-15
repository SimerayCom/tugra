import {
  buildProxySetupScript,
  buildRemoveScript,
  buildRunScript,
  containerName,
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
  it("names the container deterministically", () => {
    expect(containerName({ id: "abc" })).toBe("tugra_abc");
  });

  it("pulls, removes old, and runs the image", () => {
    const s = buildRunScript(base);
    expect(s).toContain("docker pull 'nginx:1.27'");
    expect(s).toContain("docker rm -f tugra_abc");
    expect(s).toContain("docker run -d --name tugra_abc --restart unless-stopped 'nginx:1.27'");
  });

  it("adds env (-e) and port (-p) flags when no domain", () => {
    const s = buildRunScript({ ...base, env: { FOO: "bar baz" }, hostPort: 8080, containerPort: 3000 });
    expect(s).toContain("-e 'FOO=bar baz'");
    expect(s).toContain("-p 8080:3000");
    expect(s).not.toContain("tugra-proxy");
  });

  it("with a domain, joins the proxy network + Traefik labels, no -p", () => {
    const s = buildRunScript({ ...base, domain: "app.example.com", hostPort: 8080 });
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

  it("builds a remove script", () => {
    expect(buildRemoveScript({ id: "abc" })).toContain("docker rm -f tugra_abc");
  });
});
