import { AgentUpdateService, normalizeArch, agentImageRef } from "./agent-update.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { UpdateService } from "../update/update.service";
import type { ConfigService } from "@nestjs/config";

const OK_ENTRY = {
  status: "ok" as const,
  channel: "stable",
  entry: { version: "0.2.0", agentSha256: { amd64: "aaa", arm64: "bbb" } },
};

function make(over: {
  server?: Record<string, unknown> | null;
  servers?: Record<string, unknown>[];
  perms?: Map<string, Set<string>>;
  verified?: unknown;
  sent?: boolean;
  online?: boolean;
  agentImage?: string;
}) {
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const requirePermission = jest.fn().mockResolvedValue(undefined);
  const access = {
    requirePermission,
    permissionsByTeam: jest.fn().mockResolvedValue(over.perms ?? new Map()),
  } as unknown as TeamAccessService;
  const sendAgentUpdate = jest.fn().mockResolvedValue(over.sent ?? true);
  const agentWs = {
    sendAgentUpdate,
    isOnline: jest.fn().mockReturnValue(over.online ?? false),
  } as unknown as AgentWsServer;
  const update = {
    verifyLatestEntry: jest.fn().mockResolvedValue(over.verified ?? OK_ENTRY),
  } as unknown as UpdateService;
  const prisma = {
    server: {
      findUnique: jest.fn().mockResolvedValue(over.server ?? null),
      findMany: jest.fn().mockResolvedValue(over.servers ?? []),
    },
  } as unknown as PrismaService;
  const config = { get: jest.fn().mockReturnValue(over.agentImage) } as unknown as ConfigService;
  const svc = new AgentUpdateService(prisma, access, audit, agentWs, update, config);
  return { svc, audit, access, sendAgentUpdate, agentWs, update, requirePermission };
}

describe("normalizeArch", () => {
  it("maps uname arches to docker platform arches; unknown → null", () => {
    expect(normalizeArch("x86_64")).toBe("amd64");
    expect(normalizeArch("aarch64")).toBe("arm64");
    expect(normalizeArch("amd64")).toBe("amd64");
    expect(normalizeArch("arm64")).toBe("arm64");
    expect(normalizeArch("armv7l")).toBeNull();
    expect(normalizeArch(null)).toBeNull();
  });
});

describe("agentImageRef", () => {
  it("defaults to the official ghcr image at the target version", () => {
    expect(agentImageRef(undefined, "0.2.0")).toBe("ghcr.io/simeraycom/tugra-agent:0.2.0");
  });
  it("honors an AGENT_IMAGE registry/repo override, replacing its tag with the target version", () => {
    expect(agentImageRef("registry.internal/tugra-agent:0.1.0", "0.2.0")).toBe("registry.internal/tugra-agent:0.2.0");
    expect(agentImageRef("registry.internal:5000/tugra-agent", "0.2.0")).toBe("registry.internal:5000/tugra-agent:0.2.0");
  });
});

describe("AgentUpdateService.updateOne", () => {
  const server = { id: "s1", teamId: "t1", arch: "x86_64", agentVersion: "0.1.0" };

  it("sends a digest-pinned update for a permitted, online, outdated agent + audits", async () => {
    const { svc, sendAgentUpdate, audit, requirePermission } = make({ server, sent: true });
    const res = await svc.updateOne("u1", "s1");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "servers:manage");
    // target comes ONLY from the verified manifest, never the caller: version + arch-specific sha256.
    expect(sendAgentUpdate).toHaveBeenCalledWith("s1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "aaa");
    expect(res).toMatchObject({ status: "ok", total: 1, sent: 1, results: [{ serverId: "s1", status: "sent" }] });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "agent.update.request" }));
  });

  it("propagates unconfigured/error from the manifest verify (no send)", async () => {
    const { svc, sendAgentUpdate } = make({ server, verified: { status: "unconfigured" } });
    expect(await svc.updateOne("u1", "s1")).toEqual({ status: "unconfigured", total: 0, sent: 0, offline: 0, skipped: 0, results: [] });
    expect(sendAgentUpdate).not.toHaveBeenCalled();
  });

  it("skips already-current (never-downgrade) when the agent is not older than the target", async () => {
    const { svc, sendAgentUpdate } = make({ server: { ...server, agentVersion: "0.2.0" } });
    const res = await svc.updateOne("u1", "s1");
    expect(res.results[0]).toEqual({ serverId: "s1", status: "skipped", reason: "already-current" });
    expect(sendAgentUpdate).not.toHaveBeenCalled();
  });

  it("proceeds when agentVersion is null/garbage (can't confirm current; re-pull is safe)", async () => {
    const { svc, sendAgentUpdate } = make({ server: { ...server, agentVersion: null }, sent: true });
    await svc.updateOne("u1", "s1");
    expect(sendAgentUpdate).toHaveBeenCalled();
  });

  it("skips no-digest-for-arch (never sends an unpinned update)", async () => {
    const { svc, sendAgentUpdate } = make({ server: { ...server, arch: "riscv64" }, sent: true });
    const res = await svc.updateOne("u1", "s1");
    expect(res.results[0]).toEqual({ serverId: "s1", status: "skipped", reason: "no-digest-for-arch" });
    expect(sendAgentUpdate).not.toHaveBeenCalled();
  });

  it("reports offline when the agent isn't connected", async () => {
    const { svc } = make({ server, sent: false, online: false });
    const res = await svc.updateOne("u1", "s1");
    expect(res).toMatchObject({ offline: 1, results: [{ serverId: "s1", status: "offline" }] });
  });

  it("reports capability-not-granted when online but the send is refused", async () => {
    const { svc } = make({ server, sent: false, online: true });
    const res = await svc.updateOne("u1", "s1");
    expect(res.results[0]).toEqual({ serverId: "s1", status: "skipped", reason: "capability-not-granted" });
  });
});

describe("AgentUpdateService.updateFleet", () => {
  it("skips not-permitted servers (no 403), sends to permitted ones", async () => {
    const servers = [
      { id: "s1", teamId: "t1", arch: "x86_64", agentVersion: "0.1.0" },
      { id: "s2", teamId: "t2", arch: "aarch64", agentVersion: "0.1.0" },
    ];
    const perms = new Map([["t1", new Set(["servers:manage"])]]); // t2 not permitted
    const { svc, sendAgentUpdate } = make({ servers, perms, sent: true, online: true });
    const res = await svc.updateFleet("u1", ["s1", "s2"]);
    expect(res.total).toBe(2);
    expect(res.results).toContainEqual({ serverId: "s1", status: "sent" });
    expect(res.results).toContainEqual({ serverId: "s2", status: "skipped", reason: "not-permitted" });
    // s2 (arm64) never dispatched; s1 got the amd64 digest.
    expect(sendAgentUpdate).toHaveBeenCalledTimes(1);
    expect(sendAgentUpdate).toHaveBeenCalledWith("s1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "aaa");
  });
});
