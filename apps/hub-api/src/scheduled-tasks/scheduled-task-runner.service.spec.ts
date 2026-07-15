import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

function make(sendCommand: jest.Mock, over: Record<string, unknown> = {}, update = jest.fn().mockResolvedValue({})) {
  const prisma = {
    scheduledTask: {
      findUnique: jest.fn().mockResolvedValue({
        id: "tk1",
        appId: "app1",
        name: "migrate",
        enabled: true,
        command: "php artisan schedule:run",
        application: { id: "app1", name: "blog", teamId: "t1", serverId: "s1" },
        ...over,
      }),
      update,
    },
  } as unknown as PrismaService;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const svc = new ScheduledTaskRunnerService(
    prisma,
    { sendCommand } as unknown as AgentWsServer,
    audit,
    { fireForEvent } as unknown as NotificationsService,
  );
  return { svc, update, fireForEvent, sendCommand };
}

describe("ScheduledTaskRunnerService", () => {
  it("runs an enabled task in the container and fires success on exit 0", async () => {
    const { svc, update, fireForEvent, sendCommand } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "done" }));
    await svc.runTask("tk1");
    const [serverId, cmd, capability] = sendCommand.mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cmd).toBe("docker exec tugra_app1 sh -c 'php artisan schedule:run'");
    expect(capability).toBe("schedule");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastRunAt: expect.any(Date) } }));
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "scheduled_task_success",
      expect.objectContaining({ taskName: "migrate", appName: "blog", exitCode: 0 }),
    );
  });

  it("fires scheduled_task_failed on a non-zero exit but STILL records lastRunAt (no side-effect regression)", async () => {
    const { svc, update, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 2, output: "boom" }));
    await svc.runTask("tk1");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastRunAt: expect.any(Date) } }));
    expect(fireForEvent).toHaveBeenCalledWith("t1", "scheduled_task_failed", expect.objectContaining({ exitCode: 2 }));
  });

  it("NEVER ships the task's raw output to external channels (arbitrary command → secret-leak guard)", async () => {
    const secret = "DATABASE_URL=postgres://u:S3cretPass@db/app\nTOKEN=sk_live_abc";
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 1, output: secret }));
    await svc.runTask("tk1");
    const ctx = fireForEvent.mock.calls[0][2] as Record<string, unknown>;
    expect(JSON.stringify(ctx)).not.toContain("S3cretPass");
    expect(JSON.stringify(ctx)).not.toContain("sk_live_abc");
    expect(ctx).not.toHaveProperty("outputTail");
  });

  it("fires scheduled_task_failed when the agent command throws (transport error), no output leaked", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockRejectedValue(new Error("agent offline s3cr3t")));
    await svc.runTask("tk1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "scheduled_task_failed", expect.objectContaining({ exitCode: "" }));
    expect(JSON.stringify(fireForEvent.mock.calls[0][2])).not.toContain("s3cr3t");
  });

  it("still fires SUCCESS when the command succeeded but a post-run write throws (no false failure)", async () => {
    // exit 0 (task really succeeded) but the lastRunAt update rejects → must NOT be reported as failed.
    const { svc, fireForEvent } = make(
      jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" }),
      {},
      jest.fn().mockRejectedValue(new Error("db down")),
    );
    await svc.runTask("tk1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "scheduled_task_success", expect.objectContaining({ exitCode: 0 }));
    expect(fireForEvent).not.toHaveBeenCalledWith("t1", "scheduled_task_failed", expect.anything());
  });

  it("skips a disabled or missing task (no send, no fire)", async () => {
    const { svc, fireForEvent, sendCommand } = make(jest.fn(), { enabled: false, application: {} });
    await svc.runTask("tk1");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(fireForEvent).not.toHaveBeenCalled();
  });
});
