import { firstValueFrom, take, toArray } from "rxjs";
import type { MetricsSample } from "@tugra/shared";
import { MetricsLiveService } from "./metrics-live.service";
import type { RedisService } from "../redis/redis.service";

function sample(over: Partial<MetricsSample> = {}): MetricsSample {
  return {
    ts: 1,
    cpu: 10,
    memUsed: 1,
    memTotal: 2,
    diskUsed: 1,
    diskTotal: 2,
    netRx: 0,
    netTx: 0,
    diskRead: 0,
    diskWrite: 0,
    ...over,
  };
}

function make() {
  const fakeSub = {
    psubscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  const redis = { client: { duplicate: () => fakeSub } } as unknown as RedisService;
  const svc = new MetricsLiveService(redis);
  return { svc, fakeSub };
}

describe("MetricsLiveService", () => {
  it("routes a published sample to the matching server subscriber", async () => {
    const { svc } = make();
    const got = firstValueFrom(svc.subscribe("srv1").pipe(take(1)));
    svc.handle("metrics:srv1", JSON.stringify(sample({ cpu: 42 })));
    expect((await got).cpu).toBe(42);
  });

  it("does not deliver another server's samples", async () => {
    const { svc } = make();
    const collected = firstValueFrom(svc.subscribe("srv1").pipe(take(1), toArray()));
    svc.handle("metrics:srv2", JSON.stringify(sample({ cpu: 99 })));
    svc.handle("metrics:srv1", JSON.stringify(sample({ cpu: 7 })));
    expect(await collected).toEqual([sample({ cpu: 7 })]);
  });

  it("ignores malformed JSON payloads", async () => {
    const { svc } = make();
    const collected = firstValueFrom(svc.subscribe("srv1").pipe(take(1), toArray()));
    svc.handle("metrics:srv1", "not json{");
    svc.handle("metrics:srv1", JSON.stringify(sample({ cpu: 5 })));
    expect(await collected).toEqual([sample({ cpu: 5 })]);
  });

  it("ignores messages on channels outside the metrics namespace", async () => {
    const { svc } = make();
    const collected = firstValueFrom(svc.subscribe("srv1").pipe(take(1), toArray()));
    svc.handle("other:srv1", JSON.stringify(sample({ cpu: 1 })));
    svc.handle("metrics:srv1", JSON.stringify(sample({ cpu: 2 })));
    expect(await collected).toEqual([sample({ cpu: 2 })]);
  });

  it("psubscribes to the metrics channel pattern lazily on first subscribe", () => {
    const { svc, fakeSub } = make();
    expect(fakeSub.psubscribe).not.toHaveBeenCalled(); // no Redis connection until watched
    svc.subscribe("srv1");
    expect(fakeSub.psubscribe).toHaveBeenCalledWith("metrics:*");
    expect(fakeSub.on).toHaveBeenCalledWith("pmessage", expect.any(Function));
  });

  it("reuses a single subscriber connection across many subscribers", () => {
    const { svc, fakeSub } = make();
    svc.subscribe("srv1");
    svc.subscribe("srv2");
    svc.subscribe("srv3");
    expect(fakeSub.psubscribe).toHaveBeenCalledTimes(1);
  });

  it("delivers a real pmessage from the duplicated connection to subscribers", async () => {
    const { svc, fakeSub } = make();
    const got = firstValueFrom(svc.subscribe("srvX").pipe(take(1)));
    const handler = fakeSub.on.mock.calls.find((c) => c[0] === "pmessage")![1] as (
      pattern: string,
      channel: string,
      message: string,
    ) => void;
    handler("metrics:*", "metrics:srvX", JSON.stringify(sample({ cpu: 33 })));
    expect((await got).cpu).toBe(33);
  });

  it("quits the subscriber connection on destroy", async () => {
    const { svc, fakeSub } = make();
    svc.subscribe("srv1"); // opens the connection
    await svc.onModuleDestroy();
    expect(fakeSub.quit).toHaveBeenCalled();
  });

  it("does not throw on destroy when never subscribed", async () => {
    const { svc, fakeSub } = make();
    await expect(svc.onModuleDestroy()).resolves.toBeUndefined();
    expect(fakeSub.quit).not.toHaveBeenCalled();
  });
});
