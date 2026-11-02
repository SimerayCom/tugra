import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

function make(sendCommand: jest.Mock, over: Record<string, unknown> = {}, update = jest.fn().mockResolvedValue({})) {
  const runUpdate = jest.fn().mockResolvedValue({});
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
    scheduledTaskRun: {
      create: jest.fn().mockResolvedValue({ id: "run1" }),
      update: runUpdate,
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const svc = new ScheduledTaskRunnerService(
    prisma,
    { sendCommand } as unknown as AgentWsServer,
    audit,
    { fireForEvent } as unknown as NotificationsService,
  );
  return { svc, update, fireForEvent, sendCommand, runUpdate, prisma };
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

  it("force runs a DISABLED task (manual run-now) — sends the command", async () => {
    const { svc, sendCommand, fireForEvent } = make(
      jest.fn().mockResolvedValue({ exitCode: 0, output: "ok" }),
      { enabled: false },
    );
    await svc.runTask("tk1", { force: true });
    expect(sendCommand).toHaveBeenCalled();
    expect(fireForEvent).toHaveBeenCalledWith("t1", "scheduled_task_success", expect.objectContaining({ exitCode: 0 }));
  });

  it("records a SUCCESS run with exit code, output and the trigger", async () => {
    const { svc, runUpdate } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "all good" }));
    await svc.runTask("tk1", { trigger: "manual" });
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "run1" }, data: expect.objectContaining({ status: "SUCCESS", exitCode: 0, output: "all good" }) }),
    );
  });

  it("records a FAILED run on a non-zero exit (output kept)", async () => {
    const { svc, runUpdate } = make(jest.fn().mockResolvedValue({ exitCode: 7, output: "boom" }));
    await svc.runTask("tk1");
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", exitCode: 7 }) }),
    );
  });

  it("records a FAILED run with a null exit code + error message on a transport failure", async () => {
    const { svc, runUpdate } = make(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runTask("tk1");
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", exitCode: null, output: null, error: "agent offline" }) }),
    );
  });

  it("caps stored output to the last 16 KB", async () => {
    const big = "x".repeat(20_000);
    const { svc, runUpdate } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: big }));
    await svc.runTask("tk1");
    const stored = runUpdate.mock.calls[0][0].data.output as string;
    expect(stored.length).toBe(16_384);
  });

  it("strips a NUL byte from stored output (Postgres text can't hold 0x00) — run still SUCCESS", async () => {
    const { svc, runUpdate } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "a\u0000b\u0000c" }));
    await svc.runTask("tk1");
    const data = runUpdate.mock.calls[0][0].data;
    expect(data.status).toBe("SUCCESS");
    expect(data.output).toBe("abc");
    expect(data.output).not.toContain("\u0000");
  });

  it("boot reaper fails runs left RUNNING by a previous hub", async () => {
    const { svc, prisma } = make(jest.fn());
    await svc.onApplicationBootstrap();
    const updateMany = (prisma as unknown as { scheduledTaskRun: { updateMany: jest.Mock } }).scheduledTaskRun.updateMany;
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "RUNNING" }, data: expect.objectContaining({ status: "FAILED" }) }),
    );
  });
});
