import type { ConfigService } from "@nestjs/config";
import { ImageUpdateSchedulerService } from "./image-update.scheduler.service";
import type { ImageUpdateService } from "./image-update.service";

describe("ImageUpdateSchedulerService", () => {
  it("is a no-op under NODE_ENV=test (no queue, no worker, no boot tick)", async () => {
    const runTick = jest.fn();
    const svc = new ImageUpdateSchedulerService({ get: jest.fn() } as unknown as ConfigService, { runTick, intervalMin: () => 360 } as unknown as ImageUpdateService);
    await svc.onApplicationBootstrap();
    expect((svc as unknown as { queue?: unknown }).queue).toBeUndefined();
    expect((svc as unknown as { worker?: unknown }).worker).toBeUndefined();
    expect((svc as unknown as { bootTimer?: unknown }).bootTimer).toBeUndefined();
    expect(runTick).not.toHaveBeenCalled();
    await svc.onModuleDestroy();
  });
});
