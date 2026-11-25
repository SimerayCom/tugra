const redisCtor = jest.fn();
const redisQuit = jest.fn().mockResolvedValue("OK");
const redisOn = jest.fn();
jest.mock("ioredis", () => {
  const Redis = function Redis(this: unknown, ...args: unknown[]) {
    redisCtor(...args);
    return { on: redisOn, quit: redisQuit, disconnect: jest.fn(), options: {} };
  };
  return { __esModule: true, default: Redis };
});

// The URL parsing itself is covered by common/redis-connection.spec.ts; here only that the hub feeds it the FULL URL.
const parse = jest.fn((url: string) => ({ host: "parsed-host", port: 6380, db: 3, password: "s3cret", tls: {}, maxRetriesPerRequest: null, url }));
jest.mock("../common/redis-connection", () => ({ redisConnectionOptions: (url: string) => parse(url) }));

const order: string[] = [];
const queueCtor = jest.fn();
const workerCtor = jest.fn();
jest.mock("bullmq", () => ({
  Queue: function Queue(name: string, opts: unknown) {
    queueCtor(name, opts);
    return { on: jest.fn(), close: jest.fn(async () => void order.push(`queue:${name}`)) };
  },
  Worker: function Worker(name: string, _p: unknown, opts: unknown) {
    workerCtor(name, opts);
    return { on: jest.fn(), close: jest.fn(async () => void order.push(`worker:${name}`)) };
  },
}));

import { QueueHubService } from "./queue-hub.service";
import type { ConfigService } from "@nestjs/config";

const config = (url = "rediss://:s3cret@redis.example:6380/3") => ({ get: (k: string) => (k === "REDIS_URL" ? url : undefined) }) as unknown as ConfigService;
const OLD = process.env.NODE_ENV;

beforeEach(() => {
  order.length = 0;
  redisCtor.mockClear();
  redisQuit.mockClear();
  redisOn.mockClear();
  queueCtor.mockClear();
  workerCtor.mockClear();
});
afterEach(() => {
  process.env.NODE_ENV = OLD;
});

describe("QueueHubService", () => {
  it("opens ONE Redis connection for any number of queues and workers, built from the full REDIS_URL options", () => {
    const hub = new QueueHubService(config());
    hub.queue("a");
    hub.queue("b");
    hub.worker("a", async () => undefined);
    hub.worker("b", async () => undefined);
    expect(redisCtor).toHaveBeenCalledTimes(1);
    const opts = redisCtor.mock.calls[0][0];
    expect(parse).toHaveBeenCalledWith("rediss://:s3cret@redis.example:6380/3");
    expect(opts).toMatchObject({ host: "parsed-host", port: 6380, password: "s3cret", db: 3, maxRetriesPerRequest: null, connectionName: "tugra:bullmq" });
    expect(opts.tls).toBeDefined(); // a BullMQ Worker needs maxRetriesPerRequest null on the client it duplicates
    // every queue / worker is handed that same client (a Worker duplicates it for its own blocking read)
    const conns = [...queueCtor.mock.calls.map((c) => c[1].connection), ...workerCtor.mock.calls.map((c) => c[1].connection)];
    expect(conns).toHaveLength(4);
    expect(new Set(conns).size).toBe(1);
  });

  it("queues keep the bounded job-history defaults", () => {
    new QueueHubService(config()).queue("a");
    expect(queueCtor.mock.calls[0][1].defaultJobOptions).toEqual({ removeOnComplete: 20, removeOnFail: 50 });
  });

  it("passes worker options through (concurrency) but never lets a caller swap the connection", () => {
    new QueueHubService(config()).worker("a", async () => undefined, { concurrency: 24 });
    expect(workerCtor.mock.calls[0][1]).toMatchObject({ concurrency: 24 });
  });

  it("is disabled under NODE_ENV=test and enabled otherwise", () => {
    const hub = new QueueHubService(config());
    process.env.NODE_ENV = "test";
    expect(hub.enabled).toBe(false);
    process.env.NODE_ENV = "production";
    expect(hub.enabled).toBe(true);
  });

  it("does not open Redis until something asks for it", () => {
    new QueueHubService(config());
    expect(redisCtor).not.toHaveBeenCalled();
  });

  it("shuts down workers first, then queues, then the shared connection", async () => {
    const hub = new QueueHubService(config());
    hub.queue("a");
    hub.worker("a", async () => undefined);
    hub.queue("b");
    await hub.onModuleDestroy();
    expect(order.slice(0, 1)).toEqual(["worker:a"]);
    expect(order.slice(1).sort()).toEqual(["queue:a", "queue:b"]);
    expect(redisQuit).toHaveBeenCalledTimes(1);
  });

  it("release() closes and forgets a short-lived queue", async () => {
    const hub = new QueueHubService(config());
    const q = hub.queue("legacy");
    await hub.release(q);
    expect(order).toEqual(["queue:legacy"]);
    order.length = 0;
    await hub.onModuleDestroy();
    expect(order).toEqual([]); // not closed twice
  });

  it("logs a Redis outage once per window, not once per socket per second", () => {
    const hub = new QueueHubService(config());
    const warn = jest.spyOn((hub as unknown as { logger: { warn: () => void } }).logger, "warn").mockImplementation(() => undefined);
    hub.connection();
    expect(redisOn).toHaveBeenCalledWith("error", expect.any(Function));
    const onError = redisOn.mock.calls.find((c) => c[0] === "error")![1] as (e: Error) => void;
    for (let i = 0; i < 20; i++) onError(new Error("ECONNREFUSED"));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
