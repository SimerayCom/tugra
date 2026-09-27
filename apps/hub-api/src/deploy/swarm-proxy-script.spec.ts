import {
  buildSwarmProxyEnsureScript,
  buildSwarmProxyStatusScript,
  buildClassicProxyRunningScript,
  buildSwarmProxyTeardownScript,
  SWARM_PROXY_NAME,
} from "./swarm-proxy-script";

type EnsureOpts = Parameters<typeof buildSwarmProxyEnsureScript>[0];
function ensure(over: Partial<EnsureOpts> = {}): string {
  return buildSwarmProxyEnsureScript({
    managerNodeId: "node_x",
    acmeEmail: "ops@acme.io",
    confighash: "h4sh",
    secretPrefix: "tugra-swarm-dns-c1",
    ...over,
  });
}

describe("swarm-proxy-script builders", () => {
  it("ensure: overlay + node-label pin + swarm-provider Traefik as a single manager-pinned service", () => {
    const s = ensure();
    expect(s).toContain("docker network create -d overlay --opt encrypted --attachable 'tugra-swarm'");
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
  });

  it("ensure: wraps traefik in `sh -c` passing flags as $@ (no nested quoting) + a safe read-loop, never sourcing", () => {
    const s = ensure();
    expect(s).toContain("--entrypoint sh");
    expect(s).toContain('exec traefik "$@"');
    expect(s).toContain("read -r k v"); // safe read-loop (not `. /run/secrets/...`)
    expect(s).toContain('export "$k=$v"');
    expect(s).not.toContain(". /run/secrets");
    // the traefik flags come after `traefik` as argv words, not embedded in the wrapper's single-quoted string
    expect(s).toContain("traefik --providers.swarm=true");
  });

  it("ensure: reconciles on the confighash label — skip if unchanged, rm+recreate if changed", () => {
    const s = ensure({ confighash: "h4sh" });
    expect(s).toContain(`{{index .Spec.Labels "tugra.proxy.confighash"}}`);
    expect(s).toContain("--label tugra.proxy.confighash='h4sh'");
    expect(s).toContain(`[ "$TUGRA_CUR" = 'h4sh' ]`);
    expect(s).toContain('echo "swarm proxy up to date"'); // skip branch
    expect(s).toContain("docker service rm tugra-swarm-proxy >/dev/null 2>&1 || true"); // recreate branch
  });

  it("ensure WITH dns: le-dns resolver + a Docker secret + acme-dns.json (wildcard DNS-01)", () => {
    const s = ensure({ dns: { provider: "cloudflare", credsB64: "Q0ZfVE9LRU49eA==", secretName: "tugra-swarm-dns-c1-h4sh" } });
    expect(s).toContain("--certificatesresolvers.le-dns.acme.dnschallenge=true");
    expect(s).toContain("--certificatesresolvers.le-dns.acme.dnschallenge.provider='cloudflare'");
    expect(s).toContain("--certificatesresolvers.le-dns.acme.storage=/letsencrypt/acme-dns.json");
    expect(s).toContain("--secret source='tugra-swarm-dns-c1-h4sh',target=dns_env");
    // immutable secret: create only if this exact hash-version is absent
    expect(s).toContain("docker secret inspect 'tugra-swarm-dns-c1-h4sh' >/dev/null 2>&1 || printf %s 'Q0ZfVE9LRU49eA==' | base64 -d | docker secret create 'tugra-swarm-dns-c1-h4sh' -");
    expect(s).toContain("touch /etc/tugra/letsencrypt-swarm/acme-dns.json");
    // prune stale secrets != the desired one
    expect(s).toContain("docker secret ls --filter name='tugra-swarm-dns-c1'");
    expect(s).toContain(`[ "$s" != 'tugra-swarm-dns-c1-h4sh' ]`);
  });

  it("ensure WITHOUT dns: no le-dns resolver + no secret, but the wrapper is still present", () => {
    const s = ensure({ dns: null });
    expect(s).not.toContain("le-dns");
    expect(s).not.toContain("--secret ");
    expect(s).not.toContain("docker secret create");
    expect(s).toContain('exec traefik "$@"'); // single code path — wrapper always present
    // prune still runs, removing ALL of this cluster's dns secrets (desired = "")
    expect(s).toContain(`[ "$s" != '' ]`);
  });

  it("ensure: never sets lbswarm, never the docker provider; shq-quotes email + provider (injection-safe)", () => {
    const s = ensure({ acmeEmail: "x'; rm -rf / #", dns: { provider: "y'; bad", credsB64: "eA==", secretName: "tugra-swarm-dns-c1-z" } });
    expect(s.toLowerCase()).not.toContain("lbswarm");
    expect(s).not.toContain("--providers.docker");
    expect(s).toContain("--certificatesresolvers.le.acme.email='x'\\''; rm -rf / #'");
    expect(s).toContain("--certificatesresolvers.le-dns.acme.dnschallenge.provider='y'\\''; bad'");
  });

  it("ensure: falls back to node.role==manager when no swarm node id is known", () => {
    const s = ensure({ managerNodeId: null });
    expect(s).toContain("--constraint 'node.role==manager'");
    expect(s).not.toContain("--label-add");
  });

  it("status / classic-detect / teardown builders", () => {
    expect(buildSwarmProxyStatusScript()).toBe(`docker service ls --filter name=${SWARM_PROXY_NAME} --format '{{.Replicas}}'`);
    expect(buildClassicProxyRunningScript()).toBe("docker ps --filter name=^/tugra-proxy$ --format '{{.Names}}'");
    const teardown = buildSwarmProxyTeardownScript("tugra-swarm-dns-c1");
    expect(teardown).toContain("docker service rm tugra-swarm-proxy");
    expect(teardown).toContain("docker secret ls --filter name='tugra-swarm-dns-c1'"); // prune the cluster's dns secrets
    expect(teardown).toContain("echo STILL");
    expect(teardown).toContain("echo GONE");
  });
});
