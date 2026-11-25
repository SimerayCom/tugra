import { HubWatchSchedulerService, DRILL_CRON } from "./hub-watch-scheduler.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

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

describe("HubWatchSchedulerService registration", () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = OLD;
  });

  it("registers the monthly drill (cron) and the 60 s dead-man tick on the shared scheduler; nothing under test", async () => {
    const deadman = { tick: jest.fn().mockResolvedValue(undefined) };
    const prisma = { hubBackupConfig: { findUnique: jest.fn().mockResolvedValue({ drillEnabled: true }) }, hubBackup: { count: jest.fn().mockResolvedValue(1) } };
    const drills = { run: jest.fn().mockResolvedValue({}) };
    const t = new FakeTicks();
    process.env.NODE_ENV = "test";
    await new HubWatchSchedulerService(t.asService(), prisma as never, drills as never, deadman as never).onApplicationBootstrap();
    expect(t.registered).toEqual([]);

    process.env.NODE_ENV = "production";
    await new HubWatchSchedulerService(t.asService(), prisma as never, drills as never, deadman as never).onApplicationBootstrap();
    expect(t.spec("hub-backup-drill").pattern).toBe(DRILL_CRON);
    expect(t.spec("hub-deadman").every).toBe(60_000);
    await t.run("hub-deadman");
    expect(deadman.tick).toHaveBeenCalledTimes(1);
    await t.run("hub-backup-drill");
    expect(drills.run).toHaveBeenCalledWith("schedule");
  });
});
