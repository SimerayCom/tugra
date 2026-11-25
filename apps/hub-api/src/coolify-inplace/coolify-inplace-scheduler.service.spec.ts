import { CoolifyInPlaceSchedulerService } from "./coolify-inplace-scheduler.service";

describe("CoolifyInPlaceSchedulerService", () => {
  it("runs the certificate sweep, never stacks a second one while one runs, and survives a failure", async () => {
    let release: () => void = () => undefined;
    const sweep = jest.fn(() => new Promise<number>((r) => (release = () => r(1))));
    const svc = new CoolifyInPlaceSchedulerService({ sweepFallbacks: sweep } as never);
    const first = svc.tick();
    await svc.tick(); // busy: ignored
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await first;
    sweep.mockImplementationOnce(() => Promise.reject(new Error("agent gone")));
    await expect(svc.tick()).resolves.toBeUndefined();
    sweep.mockImplementationOnce(() => Promise.resolve(0));
    await svc.tick();
    expect(sweep).toHaveBeenCalledTimes(3);
  });
  it("starts no timer in tests", () => {
    const svc = new CoolifyInPlaceSchedulerService({ sweepFallbacks: jest.fn() } as never);
    svc.onApplicationBootstrap();
    expect((svc as unknown as { timer?: unknown }).timer).toBeUndefined();
  });
});
