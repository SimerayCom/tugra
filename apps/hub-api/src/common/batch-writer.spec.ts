import { Prisma } from "@prisma/client";
import { BatchWriter, isTransientDbError, telemetryFlushMs } from "./batch-writer";

const known = (code: string) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "t" });

function make(write: jest.Mock, over: Partial<ConstructorParameters<typeof BatchWriter<number>>[0]> = {}) {
  return new BatchWriter<number>({ name: "t", write, flushMs: 5000, flushRows: 100, maxBuffered: 50, chunk: 10, ...over });
}

describe("BatchWriter", () => {
  afterEach(() => jest.useRealTimers());

  it("writes buffered rows as chunked multi-row inserts, in order, only on flush", async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    const w = make(write);
    for (let i = 0; i < 25; i++) w.push(i);
    expect(write).not.toHaveBeenCalled();
    await w.flush();
    expect(write.mock.calls.map((c) => c[0].length)).toEqual([10, 10, 5]);
    expect(write.mock.calls.flatMap((c) => c[0])).toEqual([...Array(25).keys()]);
    expect(w.stats()).toMatchObject({ buffered: 0, flushed: 25, dropped: 0 });
  });

  it("flushes on the timer and early once flushRows are waiting", async () => {
    jest.useFakeTimers();
    const write = jest.fn().mockResolvedValue(undefined);
    const w = make(write, { flushRows: 3, maxBuffered: 1000 });
    w.start();
    w.push(1);
    w.push(2);
    expect(write).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect(write).toHaveBeenCalledTimes(1);
    w.pushMany([3, 4, 5]); // reaches flushRows → no waiting for the interval
    await jest.advanceTimersByTimeAsync(0);
    expect(write).toHaveBeenCalledTimes(2);
    await w.stop();
  });

  it("keeps rows when the database is down, retries them next flush, and loses nothing", async () => {
    const write = jest.fn().mockRejectedValueOnce(known("P1001")).mockResolvedValue(undefined);
    const w = make(write);
    w.pushMany([1, 2, 3]);
    await w.flush();
    expect(w.stats()).toMatchObject({ buffered: 3, flushed: 0, failedFlushes: 1 });
    w.push(4);
    await w.flush();
    expect(write.mock.calls[1][0]).toEqual([1, 2, 3, 4]); // old rows first
    expect(w.stats()).toMatchObject({ buffered: 0, flushed: 4 });
  });

  it("is bounded: past maxBuffered the OLDEST rows are dropped and counted", async () => {
    const write = jest.fn().mockRejectedValue(known("P1001"));
    const w = make(write, { maxBuffered: 20, flushRows: 1000 });
    for (let i = 0; i < 100; i++) w.push(i);
    const s = w.stats();
    expect(s.buffered).toBeLessThanOrEqual(20);
    expect(s.dropped).toBe(100 - s.buffered);
    write.mockResolvedValue(undefined);
    await w.flush();
    const kept = write.mock.calls[write.mock.calls.length - 1][0].concat(...write.mock.calls.slice(-3, -1).map((c) => c[0]));
    expect(Math.max(...kept)).toBe(99); // newest survived
    expect(kept).not.toContain(0); // oldest went
  });

  it("isolates a poison row: neighbours are written, the bad one is rejected (not retried forever)", async () => {
    const write = jest.fn(async (rows: number[]) => {
      if (rows.includes(7)) throw known("P2003"); // e.g. the server was deleted while its samples were buffered
    });
    const w = make(write);
    w.pushMany([5, 6, 7, 8]);
    await w.flush();
    expect(w.stats()).toMatchObject({ buffered: 0, flushed: 3, rejected: 1 });
  });

  it("keeps the unwritten remainder when the database goes away during isolation", async () => {
    let calls = 0;
    const write = jest.fn(async (rows: number[]) => {
      calls++;
      if (calls === 1) throw known("P2003"); // whole chunk refused → isolate
      if (calls === 3) throw known("P1001"); // dies while writing row #2
      void rows;
    });
    const w = make(write);
    w.pushMany([1, 2, 3, 4]);
    await w.flush();
    expect(w.stats()).toMatchObject({ buffered: 3, flushed: 1, failedFlushes: 1 });
  });

  it("stop() writes what is left and a second stop is harmless", async () => {
    const write = jest.fn().mockResolvedValue(undefined);
    const w = make(write);
    w.start();
    w.pushMany([1, 2]);
    await w.stop();
    expect(write).toHaveBeenCalledWith([1, 2]);
    await w.stop();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never runs two flushes at once", async () => {
    let active = 0;
    let max = 0;
    const write = jest.fn(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    const w = make(write);
    w.pushMany([1, 2, 3]);
    await Promise.all([w.flush(), w.flush(), w.flush()]);
    expect(max).toBe(1);
  });

  it("classifies errors: outage/pool = transient, bad data = not", () => {
    expect(isTransientDbError(known("P1001"))).toBe(true);
    expect(isTransientDbError(known("P2024"))).toBe(true);
    expect(isTransientDbError(new Error("socket hang up"))).toBe(true);
    expect(isTransientDbError(known("P2003"))).toBe(false);
    expect(isTransientDbError(new Prisma.PrismaClientValidationError("bad", { clientVersion: "t" }))).toBe(false);
  });

  it("telemetryFlushMs defaults to 5 s and clamps to 1-30 s", () => {
    expect(telemetryFlushMs({})).toBe(5000);
    expect(telemetryFlushMs({ TELEMETRY_FLUSH_MS: "200" })).toBe(1000);
    expect(telemetryFlushMs({ TELEMETRY_FLUSH_MS: "999999" })).toBe(30000);
    expect(telemetryFlushMs({ TELEMETRY_FLUSH_MS: "abc" })).toBe(5000);
  });
});
