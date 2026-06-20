import { ScheduledTaskRunnerService } from "./scheduled-task-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

const audit = { log: jest.fn() } as unknown as AuditService;

describe("ScheduledTaskRunnerService", () => {
  it("runs an enabled task in the container with the schedule capability", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      scheduledTask: {
        findUnique: jest.fn().mockResolvedValue({
          id: "tk1",
          appId: "app1",
          enabled: true,
          command: "php artisan schedule:run",
          application: { id: "app1", serverId: "s1" },
        }),
        update,
      },
    } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const agentWs = { sendCommand } as unknown as AgentWsServer;
    await new ScheduledTaskRunnerService(prisma, agentWs, audit).runTask("tk1");
    const [serverId, cmd, capability] = sendCommand.mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cmd).toBe("docker exec tugra_app1 sh -c 'php artisan schedule:run'");
    expect(capability).toBe("schedule");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastRunAt: expect.any(Date) } }));
  });

  it("skips a disabled or missing task", async () => {
    const sendCommand = jest.fn();
    const prisma = {
      scheduledTask: { findUnique: jest.fn().mockResolvedValue({ enabled: false, application: {} }) },
    } as unknown as PrismaService;
    await new ScheduledTaskRunnerService(prisma, { sendCommand } as unknown as AgentWsServer, audit).runTask("tk1");
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
