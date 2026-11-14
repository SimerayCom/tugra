import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { GpuInventoryService } from "./gpu-inventory.service";
import { buildGpuProbeScript } from "./gpu-probe-script";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { REQUIRE_SCOPES } from "../api-tokens/require-scopes.decorator";
import { ServerOpsController } from "./server-ops.controller";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { GpuInventory } from "./gpu-inventory";

const NOW = new Date("2026-11-17T12:00:00Z");
const inv: GpuInventory = {
  v: 1,
  gpus: [{ index: 0, uuid: "GPU-12345678-aaaa-bbbb-cccc-1234567890ab", name: "RTX 4090", vendor: "nvidia", kind: "gpu", memoryMb: 24564, driver: "550.54", pci: null, source: "nvidia-smi" }],
  runtimes: ["nvidia", "runc"],
  defaultRuntime: "runc",
  nvidiaRuntime: true,
  nvidiaDriverLoaded: true,
  nvidiaModuleVersion: "550.54",
  error: null,
};
const OUT = `TUGRA_GPU_PROBE v1
TUGRA_PCI 0000:01:00.0 0x1002 0x73bf 0x030000
TUGRA_GPU_PROBE_END
`;

function setup(over: { server?: Record<string, unknown> | null; send?: jest.Mock; perm?: jest.Mock; role?: string | null } = {}) {
  const server = over.server === undefined ? { id: "s1", teamId: "t1", gpuInventory: null, gpuCheckedAt: null } : over.server;
  const update = jest.fn().mockResolvedValue({});
  const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server), update } } as unknown as PrismaService;
  const access = {
    teamRole: jest.fn().mockResolvedValue(over.role === undefined ? "ADMIN" : over.role),
    requirePermission: over.perm ?? jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const sendCommand = over.send ?? jest.fn().mockResolvedValue({ exitCode: 0, output: OUT });
  const agentWs = { sendCommand } as unknown as AgentWsServer;
  return { svc: new GpuInventoryService(prisma, access, audit, agentWs), update, sendCommand, audit, access };
}

describe("GpuInventoryService.getReport", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it("never calls the agent; unknown + not stale when never probed", async () => {
    const { svc, sendCommand } = setup();
    const r = await svc.getReport("u1", "s1");
    expect(r).toMatchObject({ inventory: null, readiness: "unknown", checkedAt: null, ageSeconds: null, stale: false, ttlSeconds: 600 });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("403 for a non-member, 404 for a missing server", async () => {
    await expect(setup({ role: null }).svc.getReport("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup({ server: null }).svc.getReport("u1", "s1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("malformed stored JSON degrades to unknown (no 500)", async () => {
    const { svc } = setup({ server: { id: "s1", teamId: "t1", gpuInventory: { v: 9, gpus: "x" }, gpuCheckedAt: new Date(NOW.getTime() - 5000) } });
    const r = await svc.getReport("u1", "s1");
    expect(r.inventory).toBeNull();
    expect(r.readiness).toBe("unknown");
    expect(r.ageSeconds).toBe(5);
  });

  it("computes ageSeconds and stale across the 600s boundary", async () => {
    const at = (s: number) => ({ id: "s1", teamId: "t1", gpuInventory: inv, gpuCheckedAt: new Date(NOW.getTime() - s * 1000) });
    const fresh = await setup({ server: at(600) }).svc.getReport("u1", "s1");
    expect(fresh).toMatchObject({ readiness: "ready", ageSeconds: 600, stale: false, checkedAt: new Date(NOW.getTime() - 600_000).toISOString() });
    const old = await setup({ server: at(601) }).svc.getReport("u1", "s1");
    expect(old).toMatchObject({ ageSeconds: 601, stale: true });
  });
});

describe("GpuInventoryService.refresh", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it("without servers:ops is 403 and never talks to the agent", async () => {
    const perm = jest.fn().mockRejectedValue(new ForbiddenException("insufficient role"));
    const { svc, sendCommand, update } = setup({ perm });
    await expect(svc.refresh("u1", "s1")).rejects.toThrow(/insufficient role/);
    expect(perm).toHaveBeenCalledWith("u1", "t1", "servers:ops");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("runs the fixed script with capability bulk, persists, audits", async () => {
    const { svc, sendCommand, update, audit } = setup();
    const r = await svc.refresh("u1", "s1");
    expect(sendCommand).toHaveBeenCalledWith("s1", buildGpuProbeScript(), "bulk", 45_000);
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data;
    expect(update.mock.calls[0][0].where).toEqual({ id: "s1" });
    expect(data.gpuCheckedAt).toEqual(NOW);
    expect(data.gpuInventory.gpus[0].vendor).toBe("amd");
    expect(audit.log).toHaveBeenCalledWith({ actor: "u1", action: "server.gpus.refresh", target: "s1" });
    expect(r).toMatchObject({ readiness: "non_nvidia", stale: false, ageSeconds: 0 });
    expect(r.throttled).toBeUndefined();
  });

  it("is throttled within 15s: cached report, no agent call", async () => {
    const { svc, sendCommand, update } = setup({ server: { id: "s1", teamId: "t1", gpuInventory: inv, gpuCheckedAt: new Date(NOW.getTime() - 10_000) } });
    const r = await svc.refresh("u1", "s1");
    expect(r).toMatchObject({ throttled: true, readiness: "ready" });
    expect(sendCommand).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("probes again once the throttle window has passed", async () => {
    const { svc, sendCommand } = setup({ server: { id: "s1", teamId: "t1", gpuInventory: inv, gpuCheckedAt: new Date(NOW.getTime() - 16_000) } });
    await svc.refresh("u1", "s1");
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it("two concurrent refreshes share one sendCommand", async () => {
    let release!: (v: { exitCode: number; output: string }) => void;
    const send = jest.fn().mockReturnValue(new Promise((res) => (release = res)));
    const { svc } = setup({ send });
    const a = svc.refresh("u1", "s1");
    const b = svc.refresh("u1", "s1");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    release({ exitCode: 0, output: OUT });
    await Promise.all([a, b]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("offline rethrows the typed 503 and persists nothing", async () => {
    const { svc, update } = setup({ send: jest.fn().mockRejectedValue(new AgentOfflineException()) });
    await expect(svc.refresh("u1", "s1")).rejects.toBeInstanceOf(AgentOfflineException);
    expect(update).not.toHaveBeenCalled();
  });

  it("a revoked capability is 403 and persists nothing", async () => {
    const { svc, update } = setup({ send: jest.fn().mockRejectedValue(new ForbiddenException('capability "bulk" is not granted for this server')) });
    await expect(svc.refresh("u1", "s1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("a hub timeout, non-zero exit or marker-less output is 503 and keeps the old snapshot", async () => {
    for (const send of [
      jest.fn().mockRejectedValue(new Error("command timed out")),
      jest.fn().mockResolvedValue({ exitCode: 1, output: OUT }),
      jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_PCI 0000:01:00.0 0x1002 0x73bf 0x030000\n" }),
      jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_GPU_PROBE v1\ntruncated" }),
    ]) {
      const { svc, update, audit } = setup({ send });
      await expect(svc.refresh("u1", "s1")).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    }
  });

  it("busy keeps the old snapshot and flags busy", async () => {
    const busyOut = 'TUGRA_GPU_PROBE v1\nTUGRA_NVSMI_ERR rc=125 Conflict. The container name "/tugra-gpuprobe" is already in use\nTUGRA_GPU_PROBE_END\n';
    const { svc, update } = setup({
      server: { id: "s1", teamId: "t1", gpuInventory: inv, gpuCheckedAt: new Date(NOW.getTime() - 100_000) },
      send: jest.fn().mockResolvedValue({ exitCode: 0, output: busyOut }),
    });
    const r = await svc.refresh("u1", "s1");
    expect(r).toMatchObject({ busy: true, readiness: "ready", ageSeconds: 100 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("ServerOpsController GPU routes", () => {
  const meta = (fn: unknown, key: string) => Reflect.getMetadata(key, fn as object);
  it("wires GET gpus (no scope) and POST gpus/refresh (scope deploy)", () => {
    const proto = ServerOpsController.prototype;
    expect(meta(proto.getGpus, "path")).toBe("gpus");
    expect(meta(proto.getGpus, "method")).toBe(0); // RequestMethod.GET
    expect(meta(proto.refreshGpus, "path")).toBe("gpus/refresh");
    expect(meta(proto.refreshGpus, "method")).toBe(1); // RequestMethod.POST
    expect(meta(proto.refreshGpus, "__httpCode__")).toBe(200);
    expect(meta(proto.refreshGpus, REQUIRE_SCOPES)).toEqual(["deploy"]);
    expect(meta(proto.getGpus, REQUIRE_SCOPES)).toBeUndefined();
  });
});
