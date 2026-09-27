import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SwarmProxyService } from "./swarm-proxy.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ConfigService } from "@nestjs/config";

function make(opts: {
  swarmStatus?: string;
  swarmManagerId?: string | null;
  managerStatus?: string;
  swarmNodeId?: string | null;
  backupManagerId?: string | null; // FLEET-G: an online backup manager for status() failover
  classicDomainApps?: number;
  classicProxyOutput?: string; // buildClassicProxyRunningScript output
  proxyReplicas?: string; // buildSwarmProxyStatusScript output
  certMode?: string;
  dnsProvider?: string | null;
  dnsCredsEnc?: string | null;
  decrypt?: string; // what crypto.decrypt returns (the dnsCreds JSON), or throw if undefined+dnsCredsEnc set
} = {}) {
  const cluster = { swarmStatus: opts.swarmStatus ?? "ACTIVE", swarmManagerId: opts.swarmManagerId ?? "mgr" };
  const prisma = {
    cluster: { findUnique: jest.fn().mockResolvedValue(cluster) },
    server: {
      findUnique: jest.fn().mockResolvedValue({
        id: "mgr",
        status: opts.managerStatus ?? "ONLINE",
        swarmNodeId: opts.swarmNodeId ?? "node_1",
        certMode: opts.certMode ?? "http",
        dnsProvider: opts.dnsProvider ?? null,
        dnsCredsEnc: opts.dnsCredsEnc ?? null,
      }),
      findFirst: jest.fn().mockResolvedValue(opts.backupManagerId ? { id: opts.backupManagerId } : null),
    },
    application: { count: jest.fn().mockResolvedValue(opts.classicDomainApps ?? 0) },
  } as unknown as PrismaService;
  const send = jest.fn(async (_serverId: string, cmd: string, _cap: string) => {
    if (cmd.includes("docker ps --filter name=^/tugra-proxy$")) return { exitCode: 0, output: opts.classicProxyOutput ?? "" };
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
