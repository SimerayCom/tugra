import { ConfigService } from "@nestjs/config";
import { TelemetrySchedulerService } from "./telemetry.scheduler.service";
import type { TelemetryService } from "./telemetry.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";

const config = { get: () => undefined } as unknown as ConfigService;
const settings = { get: jest.fn() } as unknown as InstanceSettingsService;

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  jest.restoreAllMocks();
});

describe("TelemetrySchedulerService", () => {
  it("does NOTHING in NODE_ENV=test (schedulers are disabled)", async () => {
    process.env.NODE_ENV = "test";
    const telemetry = { isForcedOff: jest.fn().mockReturnValue(false), intervalMin: jest.fn(), sendNow: jest.fn() } as unknown as TelemetryService;
    const s = new TelemetrySchedulerService(config, telemetry, settings);
    await s.onApplicationBootstrap();
    expect(telemetry.isForcedOff).not.toHaveBeenCalled(); // returned before anything
    expect(telemetry.sendNow).not.toHaveBeenCalled();
    expect((s as unknown as { queue?: unknown }).queue).toBeUndefined();
  });

  it("when TUGRA_TELEMETRY=0 (forced off), it touches NO Redis/Queue/Worker and never sends", async () => {
    process.env.NODE_ENV = "production"; // past the test guard
    const telemetry = {
      isForcedOff: jest.fn().mockReturnValue(true),
      intervalMin: jest.fn(),
      sendNow: jest.fn(),
    } as unknown as TelemetryService;
    const connSpy = jest.spyOn(config, "get");
    const s = new TelemetrySchedulerService(config, telemetry, settings);
    await s.onApplicationBootstrap();
    expect(telemetry.isForcedOff).toHaveBeenCalled();
    expect(telemetry.intervalMin).not.toHaveBeenCalled(); // returned before scheduling
    expect(telemetry.sendNow).not.toHaveBeenCalled();
    expect(connSpy).not.toHaveBeenCalledWith("REDIS_URL"); // never built a Redis connection
    expect((s as unknown as { queue?: unknown }).queue).toBeUndefined();
    expect((s as unknown as { worker?: unknown }).worker).toBeUndefined();
    await s.onModuleDestroy(); // safe no-op with nothing created
  });
});
