import { HubHealthSampler, SAMPLE_KEEP, type SamplerSources } from "./sampler";
import { evaluateWarnings } from "./warnings";
import { HubHealthService, parseInfo, restartsLast24h } from "./hub-health.service";
import { HubHealthController } from "./hub-health.controller";
import { InstanceOwnerGuard } from "../instance/instance-owner.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";

const MB = 1024 * 1024;

function sources(over: Partial<{ rss: number; heap: number; limit: number; p99: number; gc: number }> = {}): SamplerSources & { t: number } {
  const o = { rss: 200 * MB, heap: 100 * MB, limit: 768 * MB, p99: 12, gc: 3, ...over };
  const s = {
    t: 1_000,
    now: () => s.t,
    memory: () => ({ rss: o.rss, heapUsed: o.heap, external: 5 * MB }),
    heapLimit: () => o.limit,
    takeLoop: () => ({ p50: 1, p99: o.p99, max: o.p99 * 2 }),
    takeGcMs: () => o.gc,
  };
  return s;
}

describe("HubHealthSampler", () => {
  it("keeps a bounded ring and reports the newest sample", () => {
    const src = sources();
    const s = new HubHealthSampler(src, 3);
    for (let i = 0; i < 5; i++) {
      src.t = 1000 + i;
      s.sample();
    }
    expect(s.history()).toHaveLength(3);
    expect(s.latest()?.t).toBe(1004);
    expect(s.history()[0].t).toBe(1002);
  });

  it("start() samples at once, ticks on a timer and stops cleanly", () => {
    jest.useFakeTimers();
    try {
      const s = new HubHealthSampler(sources());
      s.start(20_000);
      expect(s.history()).toHaveLength(1);
      jest.advanceTimersByTime(60_000);
      expect(s.history()).toHaveLength(4);
      s.stop();
      jest.advanceTimersByTime(60_000);
      expect(s.history()).toHaveLength(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it("holds 15 minutes at the default size", () => {
    expect(SAMPLE_KEEP * 20).toBe(900);
  });
});

const healthy = {
  process: { rssMb: 200, heapUsedMb: 100, heapLimitMb: 768, heapPct: 13, externalMb: 5, gcMs: 1 },
  eventLoop: { p50Ms: 1, p99Ms: 10, maxMs: 20 },
  restarts: { last24h: 0, lastBootAt: null },
  postgres: { connectionsUsed: 10, connectionsMax: 100, dbSizeBytes: 1, tables: [] },
  redis: { usedMemoryBytes: 10, maxMemoryBytes: 0, connectedClients: 4 },
  queues: [],
};

describe("evaluateWarnings", () => {
  it("is quiet for a healthy hub", () => {
    expect(evaluateWarnings(healthy)).toEqual([]);
  });
  it("warns at 80% of the heap limit, not before", () => {
    expect(evaluateWarnings({ ...healthy, process: { ...healthy.process, heapPct: 79.9 } })).toEqual([]);
    expect(evaluateWarnings({ ...healthy, process: { ...healthy.process, heapPct: 80 } })).toEqual([{ code: "heap_high", value: 80, limit: 80 }]);
  });
  it("flags loop lag, connection pressure, restarts and a queue backlog", () => {
    const w = evaluateWarnings({
      ...healthy,
      eventLoop: { p50Ms: 5, p99Ms: 400, maxMs: 900 },
      postgres: { connectionsUsed: 90, connectionsMax: 100, dbSizeBytes: 1, tables: [] },
      restarts: { last24h: 3, lastBootAt: null },
      queues: [{ name: "monitors", waiting: 1500, active: 1, delayed: 0, failed: 0, lastDurationMs: 3 }],
    });
    expect(w.map((x) => x.code)).toEqual(["loop_lag", "pg_connections", "restarts", "queue_backlog"]);
    expect(w[3].detail).toBe("monitors");
  });
  it("only warns about Redis memory when a maxmemory is configured", () => {
    expect(evaluateWarnings({ ...healthy, redis: { usedMemoryBytes: 900, maxMemoryBytes: 0, connectedClients: 1 } })).toEqual([]);
    expect(evaluateWarnings({ ...healthy, redis: { usedMemoryBytes: 900, maxMemoryBytes: 1000, connectedClients: 1 } })[0].code).toBe("redis_memory");
  });
});

describe("helpers", () => {
  it("parses INFO", () => {
    expect(parseInfo("# Memory\r\nused_memory:123\r\nmaxmemory:0\r\n")).toEqual({ used_memory: "123", maxmemory: "0" });
  });
  it("counts restarts without the install boot", () => {
    const now = 10 * 86_400_000;
    expect(restartsLast24h([], now)).toBe(0);
    expect(restartsLast24h([now - 1000], now)).toBe(0); // first ever boot
    expect(restartsLast24h([now - 1000, now - 3_600_000], now)).toBe(1);
    expect(restartsLast24h([now - 1000, now - 2 * 86_400_000], now)).toBe(1); // an older boot exists: this one IS a restart
  });
});

describe("HubHealthService.snapshot", () => {
  function fakeRedis() {
    const store: Record<string, unknown> = {
      "bull:alpha:meta": 1,
    };
    const pipe = () => {
      const ops: Array<() => unknown> = [];
      const p: any = {
        llen: (k: string) => (ops.push(() => (k.endsWith(":wait") ? 7 : 2)), p),
        zcard: (k: string) => (ops.push(() => (k.endsWith(":failed") ? 1 : 4)), p),
        zrevrange: () => (ops.push(() => ["42"]), p),
        hmget: () => (ops.push(() => ["1000", "1250"]), p),
        exec: async () => ops.map((f) => [null, f()]),
      };
      return p;
    };
    return {
      lpush: jest.fn(), ltrim: jest.fn(),
      lrange: jest.fn().mockResolvedValue([String(Date.now() - 1000), String(Date.now() - 3_600_000)]),
      info: jest.fn().mockImplementation(async (s: string) => (s === "memory" ? "used_memory:5000\r\nmaxmemory:10000\r\n" : "connected_clients:3\r\n")),
      scan: jest.fn().mockResolvedValue(["0", Object.keys(store)]),
      pipeline: pipe,
    };
  }

  function build() {
    const client = fakeRedis();
    const prisma = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ used: 12n, max: 100, size: 5_000_000n }])
        .mockResolvedValueOnce([{ name: "ContainerMetricRollup", bytes: 4_000_000n }]),
    };
    const svc = new HubHealthService(prisma as never, { client } as never);
    return { svc, prisma, client };
  }

  it("assembles process, Postgres, Redis, queues and restarts", async () => {
    const { svc } = build();
    const h = await svc.snapshot();
    expect(h.process.heapLimitMb).toBeGreaterThan(0);
    expect(h.process.rssMb).toBeGreaterThan(0);
    expect(h.postgres).toEqual({ connectionsUsed: 12, connectionsMax: 100, dbSizeBytes: 5_000_000, tables: [{ name: "ContainerMetricRollup", bytes: 4_000_000 }] });
    expect(h.redis).toEqual({ usedMemoryBytes: 5000, maxMemoryBytes: 10000, connectedClients: 3 });
    expect(h.queues).toEqual([{ name: "alpha", waiting: 7, active: 2, delayed: 4, failed: 1, lastDurationMs: 250 }]);
    expect(h.restarts.last24h).toBe(1);
    expect(h.history.length).toBeGreaterThan(0);
    expect(h.healthy).toBe(h.warnings.length === 0);
    svc.onModuleDestroy();
  });

  it("caches the Postgres / Redis / queue part so polling does not hit them every call", async () => {
    const { svc, prisma, client } = build();
    await svc.snapshot();
    await svc.snapshot();
    await svc.snapshot();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2); // 2 statements, once
    expect(client.scan).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it("degrades to nulls instead of failing when Postgres / Redis are unreachable", async () => {
    const svc = new HubHealthService(
      { $queryRaw: jest.fn().mockRejectedValue(new Error("down")) } as never,
      { client: { lrange: jest.fn().mockRejectedValue(new Error("x")), info: jest.fn().mockRejectedValue(new Error("x")), scan: jest.fn().mockRejectedValue(new Error("x")) } } as never,
    );
    const h = await svc.snapshot();
    expect(h.postgres).toBeNull();
    expect(h.redis).toBeNull();
    expect(h.queues).toEqual([]);
    expect(h.restarts.last24h).toBe(0);
    svc.onModuleDestroy();
  });

  it("writes to Redis only at boot, never per sample", async () => {
    const { svc, client } = build();
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await svc.onApplicationBootstrap();
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(client.lpush).toHaveBeenCalledTimes(1);
    svc.sampler.sample();
    svc.sampler.sample();
    expect(client.lpush).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });
});

describe("HubHealthController", () => {
  it("is owner-only: session guard + owner guard on the class", () => {
    const guards = Reflect.getMetadata("__guards__", HubHealthController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, InstanceOwnerGuard]);
  });
});
