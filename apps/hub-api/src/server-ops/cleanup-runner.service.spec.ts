import { CleanupRunnerService } from "./cleanup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const server = { id: "s1", name: "node-1", teamId: "t1", cleanupVolumes: false };

function make(sendCommand: jest.Mock) {
  const update = jest.fn().mockResolvedValue({});
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue(server), update },
  } as unknown as PrismaService;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const svc = new CleanupRunnerService(
    prisma,
    { log: jest.fn() } as unknown as AuditService,
    { sendCommand } as unknown as AgentWsServer,
    { fireForEvent } as unknown as NotificationsService,
  );
  return { svc, update, fireForEvent };
}

describe("CleanupRunnerService.runCleanup", () => {
  it("fires docker_cleanup_success with the reclaimed figure on exit 0 and records lastCleanupAt", async () => {
    const { svc, update, fireForEvent } = make(
      jest.fn().mockResolvedValue({ exitCode: 0, output: "Deleted Images:\nx\nTotal reclaimed space: 1.2GB" }),
    );
    await svc.runCleanup("s1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastCleanupAt: expect.any(Date) } }));
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "docker_cleanup_success",
      expect.objectContaining({ serverId: "s1", serverName: "node-1", reclaimed: "1.2GB", errorTail: "" }),
    );
  });

  it("sums reclaimed space across the multi-step prune (image `Total reclaimed space` + builder `Total:`)", async () => {
    const multi = "Deleted Images:\nsha256:x\nTotal reclaimed space: 0B\nDeleted build cache objects\nID\tRECLAIMABLE\nabc\ttrue\nTotal:\t3.2GB";
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: multi }));
    await svc.runCleanup("s1");
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "docker_cleanup_success",
      expect.objectContaining({ reclaimed: "3.2GB" }),
    );
  });

  it("fires docker_cleanup_failed with a scrubbed error tail on a non-zero exit and does NOT advance lastCleanupAt", async () => {
    const { svc, update, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 1, output: "prune failed: no space left" }));
    await svc.runCleanup("s1");
    // A failed prune leaves the previous "Last cleanup" timestamp intact.
    expect(update).not.toHaveBeenCalled();
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "docker_cleanup_failed",
      expect.objectContaining({ serverName: "node-1", reclaimed: "", errorTail: expect.stringContaining("no space left") }),
    );
  });

  it("fires docker_cleanup_failed when the agent command throws (transport error) and does NOT advance lastCleanupAt", async () => {
    const { svc, update, fireForEvent } = make(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runCleanup("s1");
    expect(update).not.toHaveBeenCalled();
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "docker_cleanup_failed",
      expect.objectContaining({ errorTail: expect.stringContaining("agent offline") }),
    );
  });

  it("returns {ok,reclaimed,output} so Clean now can show success vs failure (not a bare string)", async () => {
    const good = await make(jest.fn().mockResolvedValue({ exitCode: 0, output: "Total reclaimed space: 1.2GB" })).svc.runCleanup("s1");
    expect(good).toEqual({ ok: true, reclaimed: "1.2GB", output: "Total reclaimed space: 1.2GB" });
    const bad = await make(jest.fn().mockResolvedValue({ exitCode: 1, output: "prune failed: no space left" })).svc.runCleanup("s1");
    expect(bad.ok).toBe(false);
    expect(bad.reclaimed).toBe("");
    expect(bad.output).toContain("no space left");
  });

  it("scheduled (skipIfDeploying): SKIPS while a deploy is running on this server (as run OR build target)", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "Total reclaimed space: 1GB" });
    const update = jest.fn().mockResolvedValue({});
    const count = jest.fn().mockResolvedValue(1);
    const log = jest.fn();
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server), update },
      deployment: { count },
    } as unknown as PrismaService;
    const svc = new CleanupRunnerService(prisma, { log } as unknown as AuditService, { sendCommand: send } as unknown as AgentWsServer, { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService);
    const out = await svc.runCleanup("s1", "scheduler", { respectThreshold: true, skipIfDeploying: true });
    expect(send).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true, reclaimed: "", output: expect.stringMatching(/skipped.*deploy/i) });
    expect(count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: "RUNNING" }) }));
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ skipped: true, reason: "deploy_running" }) }));
  });

  it("scheduled (skipIfDeploying): RUNS when no deploy is active, and records the run in the audit meta", async () => {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "Total reclaimed space: 2GB" });
    const log = jest.fn();
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server), update: jest.fn().mockResolvedValue({}) },
      deployment: { count: jest.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const svc = new CleanupRunnerService(prisma, { log } as unknown as AuditService, { sendCommand: send } as unknown as AgentWsServer, { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService);
    await svc.runCleanup("s1", "scheduler", { skipIfDeploying: true });
    expect(send).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ ok: true, skipped: false, reclaimed: "2.0GB" }) }));
  });

  // --- disk-usage threshold gate (scheduled runs only) ---
  function makeThreshold(thresholdPct: number | null, metric: { diskUsed: bigint; diskTotal: bigint } | null) {
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "Total reclaimed space: 1GB" });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue({ ...server, cleanupThresholdPct: thresholdPct }), update: jest.fn().mockResolvedValue({}) },
      metric: { findFirst: jest.fn().mockResolvedValue(metric) },
    } as unknown as PrismaService;
    const svc = new CleanupRunnerService(prisma, { log: jest.fn() } as unknown as AuditService, { sendCommand: send } as unknown as AgentWsServer, { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService);
    return { svc, send };
  }

  it("scheduled: SKIPS the prune when disk usage is below the threshold", async () => {
    const { svc, send } = makeThreshold(80, { diskUsed: 50n, diskTotal: 100n }); // 50%
    const out = await svc.runCleanup("s1", "scheduler", { respectThreshold: true });
    expect(send).not.toHaveBeenCalled();
    expect(out.output).toMatch(/skipped.*below threshold 80%/i);
  });

  it("scheduled: RUNS the prune when disk usage is at/above the threshold", async () => {
    const { svc, send } = makeThreshold(80, { diskUsed: 90n, diskTotal: 100n }); // 90%
    await svc.runCleanup("s1", "scheduler", { respectThreshold: true });
    expect(send).toHaveBeenCalled();
  });

  it("scheduled: RUNS when disk usage is unknown (no metric yet) — never skips on uncertainty", async () => {
    const { svc, send } = makeThreshold(80, null);
    await svc.runCleanup("s1", "scheduler", { respectThreshold: true });
    expect(send).toHaveBeenCalled();
  });

  it("manual (respectThreshold off): ignores the threshold and always prunes", async () => {
    const { svc, send } = makeThreshold(80, { diskUsed: 10n, diskTotal: 100n }); // 10%
    await svc.runCleanup("s1", "u1");
    expect(send).toHaveBeenCalled();
  });
});
