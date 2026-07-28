import {
  buildSwarmProxyEnsureScript,
  buildSwarmProxyStatusScript,
  buildClassicProxyRunningScript,
  buildSwarmProxyTeardownScript,
  SWARM_PROXY_NAME,
} from "./swarm-proxy-script";

describe("swarm-proxy-script builders", () => {
  it("ensure: overlay + node-label pin + swarm-provider Traefik as a single manager-pinned service", () => {
    const s = buildSwarmProxyEnsureScript({ managerNodeId: "node_x", acmeEmail: "ops@acme.io" });
    expect(s).toContain("docker network create -d overlay --attachable 'tugra-swarm'");
    expect(s).toContain("docker node update --label-add tugra.proxy=true 'node_x'");
    expect(s).toContain("--constraint 'node.labels.tugra.proxy==true'");
    expect(s).toContain("docker service create --detach --name tugra-swarm-proxy");
    expect(s).toContain("--replicas 1");
    expect(s).toContain("--publish mode=host,target=80,published=80");
    expect(s).toContain("--publish mode=host,target=443,published=443");
    expect(s).toContain("--providers.swarm=true");
    expect(s).toContain("--providers.swarm.network='tugra-swarm'");
    expect(s).toContain("--certificatesresolvers.le.acme.email='ops@acme.io'");
    expect(s).toContain("--certificatesresolvers.le.acme.httpchallenge=true");
    // Idempotent: only create if absent (never rm+recreate a live proxy → whole-cluster ingress outage).
    expect(s).toContain("if docker service inspect tugra-swarm-proxy >/dev/null 2>&1; then");
  });

  it("ensure: NEVER sets lbswarm (would disable Traefik's per-task health-check labels) and NOT the docker provider", () => {
    const s = buildSwarmProxyEnsureScript({ managerNodeId: "node_x", acmeEmail: "a@b.c" });
    expect(s.toLowerCase()).not.toContain("lbswarm");
    expect(s).not.toContain("--providers.docker");
  });

  it("ensure: falls back to node.role==manager when no swarm node id is known", () => {
    const s = buildSwarmProxyEnsureScript({ managerNodeId: null, acmeEmail: "a@b.c" });
    expect(s).toContain("--constraint 'node.role==manager'");
    expect(s).not.toContain("--label-add");
  });

  it("ensure: shq-quotes the acme email (injection-safe)", () => {
    const s = buildSwarmProxyEnsureScript({ managerNodeId: null, acmeEmail: "x'; rm -rf / #" });
    expect(s).toContain("--certificatesresolvers.le.acme.email='x'\\''; rm -rf / #'");
  });

  it("status / classic-detect / teardown builders", () => {
    expect(buildSwarmProxyStatusScript()).toBe(`docker service ls --filter name=${SWARM_PROXY_NAME} --format '{{.Replicas}}'`);
    expect(buildClassicProxyRunningScript()).toBe("docker ps --filter name=^/tugra-proxy$ --format '{{.Names}}'");
    const teardown = buildSwarmProxyTeardownScript();
    expect(teardown).toContain("docker service rm tugra-swarm-proxy");
    expect(teardown).toContain("echo STILL"); // confirms removal (STILL/GONE) so a masked failure is visible
    expect(teardown).toContain("echo GONE");
  });
});
