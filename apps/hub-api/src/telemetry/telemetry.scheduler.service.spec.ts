import { TelemetrySchedulerService } from "./telemetry.scheduler.service";
import type { TelemetryService } from "./telemetry.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import { FakeTicks } from "../scheduler/testing/fake-ticks";

const settings = { get: jest.fn().mockResolvedValue({ telemetryLastSentAt: new Date() }) } as unknown as InstanceSettingsService;

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  jest.restoreAllMocks();
});

describe("TelemetrySchedulerService", () => {
  it("does NOTHING in NODE_ENV=test (schedulers are disabled)", async () => {
    process.env.NODE_ENV = "test";
    const telemetry = { isForcedOff: jest.fn().mockReturnValue(false), intervalMin: jest.fn(), sendNow: jest.fn() } as unknown as TelemetryService;
    const t = new FakeTicks();
    const s = new TelemetrySchedulerService(t.asService(), telemetry, settings);
    await s.onApplicationBootstrap();
    expect(telemetry.isForcedOff).not.toHaveBeenCalled(); // returned before anything
    expect(telemetry.sendNow).not.toHaveBeenCalled();
    expect(t.registered).toEqual([]);
  });

  it("when TUGRA_STATS=0 (forced off), it schedules nothing, never sends, and drops a schedule an earlier boot left", async () => {
    process.env.NODE_ENV = "production"; // past the test guard
    const telemetry = {
      isForcedOff: jest.fn().mockReturnValue(true),
      intervalMin: jest.fn(),
      sendNow: jest.fn(),
    } as unknown as TelemetryService;
    const t = new FakeTicks();
    const s = new TelemetrySchedulerService(t.asService(), telemetry, settings);
    await s.onApplicationBootstrap();
    expect(telemetry.isForcedOff).toHaveBeenCalled();
    expect(telemetry.intervalMin).not.toHaveBeenCalled(); // returned before scheduling
    expect(telemetry.sendNow).not.toHaveBeenCalled();
    expect(t.registered).toEqual([]);
    expect(t.disabled).toEqual(["telemetry"]);
  });

  it("when on, it registers the recurring send at the configured interval (and the tick never sends before it is due)", async () => {
    process.env.NODE_ENV = "production";
    const telemetry = {
      isForcedOff: jest.fn().mockReturnValue(false),
      intervalMin: jest.fn().mockReturnValue(1440),
      sendNow: jest.fn().mockResolvedValue({ status: "sent" }),
    } as unknown as TelemetryService;
    const t = new FakeTicks();
    await new TelemetrySchedulerService(t.asService(), telemetry, settings).onApplicationBootstrap();
    expect(t.spec("telemetry").every).toBe(1440 * 60_000);
    expect(telemetry.sendNow).not.toHaveBeenCalled(); // last send was just now -> no boot send
    await t.run("telemetry");
    expect(telemetry.sendNow).toHaveBeenCalledTimes(1);
  });
});
