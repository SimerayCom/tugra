import { HubWatchSchedulerService } from "./hub-watch-scheduler.service";

function make(cfg: unknown, successes: number) {
  const prisma = { hubBackupConfig: { findUnique: jest.fn().mockResolvedValue(cfg) }, hubBackup: { count: jest.fn().mockResolvedValue(successes) } };
  const drills = { run: jest.fn().mockResolvedValue({}) };
  const svc = new HubWatchSchedulerService({} as never, prisma as never, drills as never, {} as never);
  return { drill: () => (svc as unknown as { runDrillIfEnabled: () => Promise<void> }).runDrillIfEnabled(), drills };
}

describe("monthly restore drill gate", () => {
  it("runs when a hub backup exists, even if the schedule is off (a manual backup counts)", async () => {
    const t = make({ enabled: false, drillEnabled: true }, 1);
    await t.drill();
    expect(t.drills.run).toHaveBeenCalledWith("schedule");
  });
  it("does not run when the drill is switched off or there is nothing stored to drill", async () => {
    const off = make({ enabled: true, drillEnabled: false }, 3);
    await off.drill();
    expect(off.drills.run).not.toHaveBeenCalled();
    const none = make({ enabled: true, drillEnabled: true }, 0);
    await none.drill();
    expect(none.drills.run).not.toHaveBeenCalled();
  });
});
