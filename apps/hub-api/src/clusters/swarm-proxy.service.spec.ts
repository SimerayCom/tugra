import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SwarmProxyService } from "./swarm-proxy.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ConfigService } from "@nestjs/config";

interface OtherMember { id: string; name: string; status: string; swarmNodeId: string | null; publicIp?: string | null }
function make(opts: {
  swarmStatus?: string;
  swarmManagerId?: string | null;
  managerStatus?: string;
  managerName?: string;
  managerPublicIp?: string | null;
  swarmNodeId?: string | null;
  backupManagerId?: string | null; // FLEET-G: an online backup manager for status() failover
  ingressReplicas?: number; // FLEET-H: desired ingress replica count on the cluster
  otherMembers?: OtherMember[]; // FLEET-H: other cluster members (for the ingress pool + coexistence guard)
  classicDomainApps?: number;
  classicAppsByServer?: Record<string, number>; // FLEET-H: classic domain-app count keyed by serverId
  classicProxyOutput?: string; // buildClassicProxyRunningScript output (any server)
  classicProxyOnServer?: string; // FLEET-H: a classic tugra-proxy runs only on THIS serverId
  proxyReplicas?: string; // buildSwarmProxyStatusScript output
  certMode?: string;
  dnsProvider?: string | null;
  dnsCredsEnc?: string | null;
  decrypt?: string; // what crypto.decrypt returns (the dnsCreds JSON), or throw if undefined+dnsCredsEnc set
} = {}) {
  const swarmNodeId = opts.swarmNodeId ?? "node_1";
  const managerName = opts.managerName ?? "mgr-host";
  const others = opts.otherMembers ?? [];
  const cluster = { swarmStatus: opts.swarmStatus ?? "ACTIVE", swarmManagerId: opts.swarmManagerId ?? "mgr", ingressReplicas: opts.ingressReplicas ?? 1 };
  const prisma = {
    cluster: { findUnique: jest.fn().mockResolvedValue(cluster) },
    server: {
      findUnique: jest.fn().mockResolvedValue({
        id: "mgr",
        name: managerName,
        status: opts.managerStatus ?? "ONLINE",
        publicIp: opts.managerPublicIp ?? "1.1.1.1",
        swarmNodeId,
        certMode: opts.certMode ?? "http",
        dnsProvider: opts.dnsProvider ?? null,
        dnsCredsEnc: opts.dnsCredsEnc ?? null,
      }),
      findFirst: jest.fn().mockResolvedValue(opts.backupManagerId ? { id: opts.backupManagerId } : null),
      // Two shapes: resolveIngressPool's extra-members query (where.status === "ONLINE"), else ensure()'s
      // all-joined coexistence query (includes the manager row).
      findMany: jest.fn(async (args: { where?: { status?: string }; take?: number }) => {
        if (args?.where?.status === "ONLINE") {
          return others
            .filter((o) => o.status === "ONLINE" && o.swarmNodeId)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, args.take ?? others.length)
            .map((o) => ({ id: o.id, name: o.name, swarmNodeId: o.swarmNodeId, publicIp: o.publicIp ?? null }));
        }
        return [{ id: "mgr", name: managerName, swarmNodeId }, ...others]
          .filter((s) => s.swarmNodeId)
          .map((s) => ({ id: s.id, name: s.name, swarmNodeId: s.swarmNodeId }));
      }),
    },
    application: {
      count: jest.fn(async (args: { where?: { serverId?: { in?: string[] } } }) => {
        if (opts.classicAppsByServer) {
          const ids = args?.where?.serverId?.in ?? [];
          return ids.reduce((sum, id) => sum + (opts.classicAppsByServer![id] ?? 0), 0);
        }
        return opts.classicDomainApps ?? 0;
      }),
    },
  } as unknown as PrismaService;
  const send = jest.fn(async (serverId: string, cmd: string, _cap: string) => {
    if (cmd.includes("docker ps --filter name=^/tugra-proxy$")) {
      const out = opts.classicProxyOnServer ? (serverId === opts.classicProxyOnServer ? "tugra-proxy" : "") : (opts.classicProxyOutput ?? "");
      return { exitCode: 0, output: out };
    }
    if (cmd.includes("docker service ls --filter name=tugra-swarm-proxy")) return { exitCode: 0, output: opts.proxyReplicas ?? "1/1" };
    return { exitCode: 0, output: "" };
  });
  const agent = { sendCommand: send } as unknown as AgentWsServer;
  const config = { get: () => "ops@x.io" } as unknown as ConfigService;
  const crypto = {
    decrypt: jest.fn(() => {
      if (opts.decrypt === undefined) throw new Error("decrypt failed");
      return opts.decrypt;
    }),
  } as unknown as import("../crypto/crypto.service").CryptoService;
  return { svc: new SwarmProxyService(prisma, agent, config, crypto), send };
}

/** Extract the tugra.proxy.confighash value from the ensure script the service dispatched. */
function confighashFromSend(send: jest.Mock): string | null {
  const call = send.mock.calls.find((c) => (c[1] as string).includes("tugra.proxy.confighash="));
  const m = call ? /tugra\.proxy\.confighash='([0-9a-f]+)'/.exec(call[1] as string) : null;
  return m ? m[1] : null;
}
/** The ensure (docker service create) script the service dispatched, if any. */
function ensureScript(send: jest.Mock): string | undefined {
  return send.mock.calls.map((c) => c[1] as string).find((s) => s.includes("docker service create --detach --name tugra-swarm-proxy"));
}

describe("SwarmProxyService.ensure", () => {
  it("stands up the overlay + swarm-Traefik on the manager and verifies it reached 1/1", async () => {
    const { svc, send } = make();
    await svc.ensure("c1");
    const ensureCall = send.mock.calls.find((c) => (c[1] as string).includes("docker service create --detach --name tugra-swarm-proxy"));
    expect(ensureCall).toBeTruthy();
    expect(ensureCall![0]).toBe("mgr");
    expect(ensureCall![2]).toBe("swarm");
    expect(ensureCall![1]).toContain("docker node update --label-add tugra.proxy=true 'node_1'");
  });

  it("with a le-dns manager: adds the le-dns resolver + a hash-named DNS-creds secret (creds never plaintext)", async () => {
    const { svc, send } = make({ certMode: "le-dns", dnsProvider: "cloudflare", dnsCredsEnc: "enc", decrypt: JSON.stringify({ CF_DNS_API_TOKEN: "s3cr3tTOKEN" }) });
    await svc.ensure("c1");
    const call = send.mock.calls.find((c) => (c[1] as string).includes("docker service create --detach"));
    expect(call![1]).toContain("--certificatesresolvers.le-dns.acme.dnschallenge.provider='cloudflare'");
    expect(call![1]).toContain("--secret source='tugra-swarm-dns-c1-"); // hash-named, cluster-scoped
    expect(call![1]).toContain("docker secret create");
    expect(call![1]).not.toContain("s3cr3tTOKEN"); // base64'd into the secret body, never plaintext in the script
  });

  it("with a le-dns manager but UNREADABLE creds: falls back to HTTP-01 only (fail-safe, no le-dns/secret)", async () => {
    const { svc, send } = make({ certMode: "le-dns", dnsProvider: "cloudflare", dnsCredsEnc: "enc" }); // decrypt throws
    await svc.ensure("c1");
    const call = send.mock.calls.find((c) => (c[1] as string).includes("docker service create --detach"));
    expect(call![1]).not.toContain("le-dns");
    expect(call![1]).not.toContain("--secret ");
  });

  it("refuses when the manager also hosts classic domain-routed apps (:80/:443 collision)", async () => {
    const { svc } = make({ classicDomainApps: 2 });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses when a classic tugra-proxy container is running on the manager", async () => {
    const { svc } = make({ classicProxyOutput: "tugra-proxy" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("errors when the swarm proxy never reaches 1/1 (e.g. pin/constraint didn't take)", async () => {
    const { svc } = make({ proxyReplicas: "0/1" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("errors when the manager is offline", async () => {
    const { svc } = make({ managerStatus: "OFFLINE" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("blocks a non-formed swarm", async () => {
    const { svc } = make({ swarmStatus: "NONE" });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("SwarmProxyService.status (FLEET-G failover)", () => {
  it("dispatches the cluster-wide `docker service ls` read to the primary when it is online", async () => {
    const { svc, send } = make({ proxyReplicas: "1/1" });
    const r = await svc.status("c1");
    const call = send.mock.calls.find((c) => (c[1] as string).includes("docker service ls --filter name=tugra-swarm-proxy"));
    expect(call![0]).toBe("mgr");
    expect(r).toEqual({ exitCode: 0, output: "1/1" });
  });

  it("fails over to a backup online manager when the primary is offline", async () => {
    const { svc, send } = make({ managerStatus: "OFFLINE", backupManagerId: "mgr2", proxyReplicas: "1/1" });
    const r = await svc.status("c1");
    const call = send.mock.calls.find((c) => (c[1] as string).includes("docker service ls --filter name=tugra-swarm-proxy"));
    expect(call![0]).toBe("mgr2"); // dispatched to the backup, not the offline primary
    expect(r.output).toBe("1/1");
  });

  it("throws when the primary is offline and no other manager is online", async () => {
    const { svc } = make({ managerStatus: "OFFLINE" }); // no backupManagerId → findFirst returns null
    await expect(svc.status("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("SwarmProxyService ingress HA (FLEET-H)", () => {
  const leDns = { certMode: "le-dns", dnsProvider: "cloudflare", dnsCredsEnc: "enc", decrypt: JSON.stringify({ CF_DNS_API_TOKEN: "s3cr3t" }) };
  const member = (over: Partial<OtherMember> = {}): OtherMember => ({ id: "w1", name: "node-b", status: "ONLINE", swarmNodeId: "node_2", publicIp: "2.2.2.2", ...over });

  it("2 replicas + le-dns + one online joined member: labels BOTH nodes, --replicas 2, accepts 2/2", async () => {
    const { svc, send } = make({ ingressReplicas: 2, otherMembers: [member()], proxyReplicas: "2/2", ...leDns });
    await svc.ensure("c1");
    const script = ensureScript(send)!;
    expect(script).toContain("docker node update --label-add tugra.proxy=true 'node_1'");
    expect(script).toContain("docker node update --label-add tugra.proxy=true 'node_2'");
    expect(script).toContain("--replicas 2");
    expect(script).toContain("--certificatesresolvers.le-dns.acme.dnschallenge=true");
  });

  it("2 replicas: status check requires 2/2 and rejects 1/2", async () => {
    const { svc } = make({ ingressReplicas: 2, otherMembers: [member()], proxyReplicas: "1/2", ...leDns });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("2 replicas WITHOUT le-dns (http): refused with a DNS-01 message, no docker service create dispatched", async () => {
    const { svc, send } = make({ ingressReplicas: 2, otherMembers: [member()], certMode: "http" });
    await expect(svc.ensure("c1")).rejects.toThrow(/DNS-01|le-dns/i);
    expect(ensureScript(send)).toBeUndefined(); // gated before any service-create command
  });

  it("3 replicas but zero other online members: pool degrades to size 1, succeeds with --replicas 1 (no DNS-01 needed)", async () => {
    const { svc, send } = make({ ingressReplicas: 3, otherMembers: [], proxyReplicas: "1/1", certMode: "http" });
    await svc.ensure("c1");
    const script = ensureScript(send)!;
    expect(script).toContain("--replicas 1");
    expect(script).not.toContain("--replicas 3");
  });

  it("coexistence guard is swarm-WIDE: a WORKER (not the manager) hosting a classic domain app refuses ensure", async () => {
    const { svc } = make({ ingressReplicas: 2, otherMembers: [member()], classicAppsByServer: { w1: 1 }, ...leDns });
    await expect(svc.ensure("c1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("coexistence guard is swarm-WIDE: a WORKER running a classic tugra-proxy container refuses ensure, naming it", async () => {
    const { svc } = make({ ingressReplicas: 2, otherMembers: [member()], classicProxyOnServer: "w1", ...leDns });
    await expect(svc.ensure("c1")).rejects.toThrow(/node-b/); // refusal names the offending worker
  });

  it("folds the pool into the confighash: replicas 1 vs 2 produce DIFFERENT confighash labels", async () => {
    const one = make({ ingressReplicas: 1, proxyReplicas: "1/1", ...leDns });
    await one.svc.ensure("c1");
    const two = make({ ingressReplicas: 2, otherMembers: [member()], proxyReplicas: "2/2", ...leDns });
    await two.svc.ensure("c1");
    const h1 = confighashFromSend(one.send);
    const h2 = confighashFromSend(two.send);
    expect(h1).toBeTruthy();
    expect(h2).toBeTruthy();
    expect(h1).not.toBe(h2); // pool change is detected → rm+recreate, not silently skipped
  });

  it("ingressInfo() returns the resolved pool (manager first, capped at ingressReplicas)", async () => {
    const { svc } = make({ ingressReplicas: 2, otherMembers: [member(), member({ id: "w2", name: "node-c", swarmNodeId: "node_3", publicIp: "3.3.3.3" })] });
    const info = await svc.ingressInfo("c1");
    expect(info.replicas).toBe(2); // capped at ingressReplicas even though 2 other members exist
    expect(info.nodes[0]).toEqual({ id: "mgr", name: "mgr-host", ip: "1.1.1.1" }); // manager first
    expect(info.nodes[1]).toEqual({ id: "w1", name: "node-b", ip: "2.2.2.2" });
  });

  it("ingressInfo() with replicas=1 returns just the manager", async () => {
    const { svc } = make({ ingressReplicas: 1, otherMembers: [member()] });
    const info = await svc.ingressInfo("c1");
    expect(info).toEqual({ replicas: 1, nodes: [{ id: "mgr", name: "mgr-host", ip: "1.1.1.1" }] });
  });

  it("scale-down cleanup: a joined member NOT in the pool gets its tugra.proxy label stripped (F3)", async () => {
    // ingressReplicas 1 → pool is just the manager, but w1 is still a joined member (a leftover from a prior
    // 2-replica pool). ensure() must emit a --label-rm for w1's node id so it can't host a stray ingress task.
    const { svc, send } = make({ ingressReplicas: 1, otherMembers: [member()], proxyReplicas: "1/1", certMode: "http" });
    await svc.ensure("c1");
    const script = ensureScript(send)!;
    expect(script).toContain("docker node update --label-rm tugra.proxy 'node_2'");
    expect(script).toContain("docker node update --label-add tugra.proxy=true 'node_1'"); // manager stays labeled
    expect(script).not.toContain("--label-add tugra.proxy=true 'node_2'"); // w1 is NOT re-added to the pool
  });

  it("DNS-01 gate fails fast: refused BEFORE the per-node coexistence livechecks are dispatched (F2)", async () => {
    const { svc, send } = make({ ingressReplicas: 2, otherMembers: [member()], certMode: "http" });
    await expect(svc.ensure("c1")).rejects.toThrow(/DNS-01|le-dns/i);
    // no classic-proxy livecheck should have been dispatched (the gate is ahead of the coexistence guard)
    expect(send.mock.calls.some((c) => (c[1] as string).includes("docker ps --filter name=^/tugra-proxy$"))).toBe(false);
  });
});
