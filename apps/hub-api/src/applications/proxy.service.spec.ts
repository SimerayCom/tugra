import { ProxyService } from "./proxy.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { ProxyConfigService, ResolvedProxyConfig } from "../proxy-config/proxy-config.service";

function make(
  cfg: ResolvedProxyConfig,
  result: { exitCode: number; output: string } = { exitCode: 0, output: "" },
  { swarmManaged = 0 }: { swarmManaged?: number } = {},
) {
  const sent: string[] = [];
  const agentWs = {
    sendCommand: jest.fn((_id: string, script: string) => {
      sent.push(script);
      return Promise.resolve(result);
    }),
  } as unknown as AgentWsServer;
  const prisma = {
    cluster: { count: jest.fn().mockResolvedValue(swarmManaged) },
  } as unknown as PrismaService;
  const proxyConfig = { resolveFor: jest.fn().mockResolvedValue(cfg) } as unknown as ProxyConfigService;
  const svc = new ProxyService(agentWs, prisma, proxyConfig);
  return { svc, sent };
}

// The proxy is recreated on EVERY domained deploy via ensureProxy, so it must honor the server's bind mode —
// otherwise a deploy would silently re-publish :80/:443 or fail where another web server holds them.
describe("ProxyService.ensureProxy — proxy bind (resolved via ProxyConfigService)", () => {
  it("publishes :80/:443 on all interfaces by default (public) — unchanged behavior", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "public" });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("-p 80:80 -p 443:443");
  });

  it("publishes NO host ports for a tunnel-only (none) server, so deploys never re-open :80/:443", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "none" });
    await svc.ensureProxy("s1");
    expect(sent[0]).not.toMatch(/ -p \d/);
    expect(sent[0]).not.toContain("127.0.0.1:80");
  });

  it("binds :80/:443 to loopback only for a loopback server", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "loopback" });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("-p 127.0.0.1:80:80 -p 127.0.0.1:443:443");
    expect(sent[0]).not.toContain("-p 80:80 -p 443:443");
  });

  it("throws (with the agent output) on a non-zero exit instead of reporting a successful deploy", async () => {
    const { svc } = make({ acmeEmail: "me@x.com", bind: "public" }, { exitCode: 125, output: "docker: port is already allocated" });
    await expect(svc.ensureProxy("s1")).rejects.toThrow(/port is already allocated/);
  });

  it("refuses on a swarm-manager server (swarm ingress owns :80/:443)", async () => {
    const { svc } = make({ acmeEmail: "me@x.com", bind: "public" }, { exitCode: 0, output: "" }, { swarmManaged: 1 });
    await expect(svc.ensureProxy("s1")).rejects.toThrow(/swarm manager/);
  });

  // --- Panel-TLS (DİLİM 1): resolveFor decides panel; ensureProxy must carry it into the script ----------
  it("local server with a panel config: a domained deploy (re)writes the panel router (never drops it)", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "public", panel: { domain: "app.example.com", resolver: "le" } });
    await svc.ensureProxy("s1");
    expect(sent[0]).toContain("/etc/tugra/proxy-dynamic/panel.yml");
    expect(sent[0]).toContain("docker network connect tugra-panel tugra-proxy");
    expect(sent[0]).toContain("--providers.file.directory=/dynamic");
  });

  it("non-local server (no panel in the resolved config): no panel router write, no tugra-panel connect", async () => {
    const { svc, sent } = make({ acmeEmail: "me@x.com", bind: "public" });
    await svc.ensureProxy("s1");
    expect(sent[0]).not.toContain("proxy-dynamic/panel.yml");
    expect(sent[0]).not.toContain("network connect tugra-panel");
    // file provider is still always mounted (so a later panel write survives) — apps unaffected
    expect(sent[0]).toContain("--providers.file.directory=/dynamic");
  });
});

// A controllable harness: each agent command stays PENDING until settle(i) is called, so a reconcile can be
// held "in flight" while more calls arrive. resolveFor returns configs[i] for the i-th pass (last repeats), so
// a trailing reconcile can be proven to re-read the FINAL desired state.
type Res = { exitCode: number; output: string };
function harness(args: { configs?: ResolvedProxyConfig[]; swarmManaged?: number } = {}) {
  const configs = args.configs ?? [{ acmeEmail: "me@x.com", bind: "public" }];
  const sent: string[] = [];
  const ids: string[] = [];
  const pending: Array<{ resolve: (r: Res) => void; reject: (e: unknown) => void }> = [];
  let sendCount = 0;
  const sendCommand = jest.fn((id: string, script: string) => {
    ids.push(id);
    sent.push(script);
    return new Promise<Res>((resolve, reject) => {
      pending[sendCount++] = { resolve, reject };
    });
  });
  const agentWs = { sendCommand } as unknown as AgentWsServer;
  let resolveForCount = 0;
  const resolveFor = jest.fn((_id: string) => {
    const cfg = configs[Math.min(resolveForCount, configs.length - 1)];
    resolveForCount++;
    return Promise.resolve(cfg);
  });
  const prisma = { cluster: { count: jest.fn().mockResolvedValue(args.swarmManaged ?? 0) } } as unknown as PrismaService;
  const proxyConfig = { resolveFor } as unknown as ProxyConfigService;
  const svc = new ProxyService(agentWs, prisma, proxyConfig);
  const settle = (i: number, r: Res = { exitCode: 0, output: "" }) => pending[i].resolve(r);
  const flush = () => new Promise<void>((r) => setImmediate(r)); // let the microtask queue drain
  return { svc, sent, ids, settle, resolveFor, sendCommand, flush };
}

// Coalescing: a per-server single-flight-with-trailing so a deploy burst collapses to one trailing reconcile of
// the final state — never N recreates, last change never dropped.
describe("ProxyService.ensureProxy — per-server coalescing", () => {
  it("collapses a burst during one in-flight reconcile to a SINGLE trailing reconcile of the final state", async () => {
    const h = harness({
      configs: [
        { acmeEmail: "me@x.com", bind: "public" }, // leader pass
        { acmeEmail: "me@x.com", bind: "none" }, // trailing pass must see the FINAL state
      ],
    });
    const pA = h.svc.ensureProxy("s1"); // leader
    await h.flush();
    expect(h.sent).toHaveLength(1); // leader reconcile in flight

    const pB = h.svc.ensureProxy("s1"); // arrive during the in-flight pass → join the trailing cohort
    const pC = h.svc.ensureProxy("s1");
    await h.flush();
    expect(h.sent).toHaveLength(1); // B & C did NOT each start a reconcile

    h.settle(0); // leader completes
    await pA;
    await h.flush();
    expect(h.sent).toHaveLength(2); // exactly ONE trailing reconcile
    expect(h.resolveFor).toHaveBeenCalledTimes(2);
    expect(h.sent[1]).not.toMatch(/ -p \d/); // it re-read resolveFor → final state (bind:none → no port publish)

    h.settle(1);
    await Promise.all([pB, pC]);
    expect(h.sent).toHaveLength(2); // no third round-trip
    expect(h.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("reconciles different serverIds independently (no cross-server blocking)", async () => {
    const h = harness();
    const p1 = h.svc.ensureProxy("s1");
    const p2 = h.svc.ensureProxy("s2");
    await h.flush();
    expect(h.sent).toHaveLength(2); // both leaders ran at once
    expect(h.ids).toEqual(["s1", "s2"]);
    h.settle(0);
    h.settle(1);
    await Promise.all([p1, p2]);
  });

  it("a non-zero reconcile throws to ALL awaiters of that coalesced cycle (fail-loud preserved)", async () => {
    const h = harness();
    const pA = h.svc.ensureProxy("s1");
    await h.flush();
    const pB = h.svc.ensureProxy("s1");
    const pC = h.svc.ensureProxy("s1");
    const bCaught = pB.catch((e) => e); // attach early (avoid unhandled-rejection noise)
    const cCaught = pC.catch((e) => e);
    await h.flush();

    h.settle(0); // leader ok
    await pA;
    await h.flush();
    h.settle(1, { exitCode: 1, output: "port taken" }); // trailing cycle fails
    const [be, ce] = await Promise.all([bCaught, cCaught]);
    expect(String(be)).toMatch(/port taken/);
    expect(String(ce)).toMatch(/port taken/);
  });

  it("clears the per-server entry after a thrown leader pass so the NEXT call re-arms (no stuck state)", async () => {
    const h = harness();
    const pA = h.svc.ensureProxy("s1");
    const aCaught = pA.catch((e) => e);
    await h.flush();
    h.settle(0, { exitCode: 1, output: "boom" }); // leader throws, no trailing cohort
    expect(String(await aCaught)).toMatch(/boom/);
    await h.flush();
    // a fresh call becomes a brand-new leader and reconciles again
    const pB = h.svc.ensureProxy("s1");
    await h.flush();
    expect(h.sent).toHaveLength(2);
    h.settle(1);
    await pB;
  });

  it("force runs immediately and bypasses the coalescer (and omits the reconcile gate)", async () => {
    const h = harness();
    const pLeader = h.svc.ensureProxy("s1"); // non-force leader, held in flight
    await h.flush();
    expect(h.sent).toHaveLength(1);
    const pForce = h.svc.ensureProxy("s1", { force: true }); // must NOT wait for the leader
    await h.flush();
    expect(h.sent).toHaveLength(2); // fired immediately, concurrently with the in-flight leader
    expect(h.sent[0]).toContain("exit 0; fi"); // coalesced deploy path keeps the gate
    expect(h.sent[1]).not.toContain("exit 0; fi"); // force path omits it
    h.settle(0);
    h.settle(1);
    await Promise.all([pLeader, pForce]);
  });

  it("the deploy path sends the CONDITIONAL, self-healing script (gate decides skip-vs-recreate on the agent)", async () => {
    const h = harness();
    const p = h.svc.ensureProxy("s1");
    await h.flush();
    const s = h.sent[0];
    expect(s).toContain(`{{index .Config.Labels "tugra.proxy.confighash"}}`); // compare the stamped hash
    expect(s).toContain("{{.State.Status}}"); // ...and the container state (self-heal on absent/unhealthy)
    expect(s).toContain('if [ "$CUR" = "$DESIRED" ] && [ "$STATE" = "running" ]; then');
    expect(s).toContain("docker rm -f tugra-proxy"); // the recreate branch is present for a miss / self-heal
    h.settle(0);
    await p;
  });

  it("refuses on a swarm-manager host before sending anything, and leaves no stuck entry", async () => {
    const h = harness({ swarmManaged: 1 });
    await expect(h.svc.ensureProxy("s1")).rejects.toThrow(/swarm manager/);
    expect(h.sent).toHaveLength(0);
    // entry was cleared → a (non-swarm) retry would reconcile; prove re-arm by issuing another call
    await expect(h.svc.ensureProxy("s1")).rejects.toThrow(/swarm manager/);
  });
});
