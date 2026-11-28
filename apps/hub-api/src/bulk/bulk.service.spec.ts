import { BulkService, planTargets } from "./bulk.service";
import { unwrapHostScript } from "../common/host-exec";

describe("planTargets (bulk permission gating)", () => {
  const servers = [
    { id: "a", teamId: "t1" },
    { id: "b", teamId: "t2" },
  ];
  // t1 has the "bulk" permission (e.g. OWNER/ADMIN or a custom role granting it); t2 does not.
  const perms = new Map<string, Set<string>>([
    ["t1", new Set(["bulk", "monitors"])],
    ["t2", new Set(["monitors"])],
  ]);

  it("runs targets whose team has the required permission, skips the rest / unknown", () => {
    const out = planTargets(["a", "b", "ghost"], servers, perms, "bulk");
    expect(out.find((t) => t.serverId === "a")!.run).toBe(true); // has "bulk"
    expect(out.find((t) => t.serverId === "b")!.run).toBe(false); // lacks "bulk"
    expect(out.find((t) => t.serverId === "ghost")!.run).toBe(false); // unknown server
  });

  it("gates on the specific permission it is given", () => {
    const out = planTargets(["a", "b"], servers, perms, "monitors");
    expect(out.find((t) => t.serverId === "a")!.run).toBe(true); // has "monitors"
    expect(out.find((t) => t.serverId === "b")!.run).toBe(true); // has "monitors"
  });
});

describe("BulkService.runTask: the command is about the SERVER, not the agent's container", () => {
  it("runs in the host's namespaces (df, free, uptime, systemctl, hostname answer for the box), under the bulk capability, bounded just under the command timeout", async () => {
    const tasks = new Map<string, Record<string, unknown>>([["t1", { id: "t1", serverId: "srv1" }]]);
    const prisma = {
      bulkTask: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => tasks.get(where.id)),
        update: jest.fn(async () => undefined),
      },
    };
    const sendCommand = jest.fn(async () => ({ exitCode: 0, output: "ok" }));
    const config = { get: jest.fn((k: string) => (k === "BULK_COMMAND_TIMEOUT_MS" ? 120_000 : undefined)) };
    const svc = new BulkService(prisma as never, {} as never, {} as never, { sendCommand } as never, config as never);
    await (svc as unknown as { runTask(id: string, c: string): Promise<void> }).runTask("t1", "df -h / && free -h");
    const [srv, sent, cap, timeout] = sendCommand.mock.calls[0] as unknown as [string, string, string, number];
    expect(srv).toBe("srv1");
    expect(cap).toBe("bulk");
    expect(timeout).toBe(120_000);
    expect(sent).toContain("nsenter -t 1 -m");
    expect(sent).toContain("timeout -k 5 115 nsenter"); // the helper's own deadline: 5 s under the command's
    expect(unwrapHostScript(sent)).toBe("df -h / && free -h");
    expect(sent).not.toContain("df -h"); // the command travels encoded, never as text on the agent's shell line
  });
});
