import type { Monitor } from "@prisma/client";
import { httpCheck, metricCheckResult } from "./checkers";

const monitor = (target: string): Monitor =>
  ({
    id: "m",
    teamId: "t",
    name: "n",
    type: "HTTP",
    target,
    intervalSec: 30,
    retries: 1,
    timeoutMs: 5000,
    resendEvery: 0,
    status: "PENDING",
    failCount: 0,
    downCount: 0,
    enabled: true,
    createdAt: new Date(),
  }) as Monitor;

describe("httpCheck", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is up on a 2xx response", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ status: 200 } as Response);
    const r = await httpCheck(monitor("http://x"));
    expect(r.up).toBe(true);
    expect(r.msg).toContain("200");
  });

  it("is down on a 5xx response", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ status: 503 } as Response);
    expect((await httpCheck(monitor("http://x"))).up).toBe(false);
  });

  it("is down when the request throws", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await httpCheck(monitor("http://x"));
    expect(r.up).toBe(false);
    expect(r.msg).toContain("ECONNREFUSED");
  });
});

describe("metricCheckResult", () => {
  const sample = { cpu: 30, memUsed: 6, memTotal: 10, diskUsed: 85, diskTotal: 100 };

  it("alarms (down) when disk usage >= threshold", () => {
    const r = metricCheckResult("DISK", sample, 80);
    expect(r.up).toBe(false);
    expect(r.msg).toBe("DISK 85% (limit 80%)");
  });

  it("is up when below threshold", () => {
    expect(metricCheckResult("DISK", sample, 90).up).toBe(true);
  });

  it("computes CPU and MEM percentages", () => {
    expect(metricCheckResult("CPU", sample, 25).up).toBe(false); // 30 >= 25
    expect(metricCheckResult("MEM", sample, 50).up).toBe(false); // 60% >= 50
    expect(metricCheckResult("MEM", sample, 70).up).toBe(true); // 60% < 70
  });

  it("no sample → up (no false alarm before metrics arrive)", () => {
    const r = metricCheckResult("DISK", null, 80);
    expect(r.up).toBe(true);
    expect(r.msg).toContain("no metrics");
  });
});

describe("metricCheckResult — freshness gate (F03)", () => {
  const sample = { cpu: 1, memUsed: 1, memTotal: 100, diskUsed: 1, diskTotal: 100 }; // well below any threshold
  const NOW = 1_000_000_000_000;
  const aged = (ageMs: number) => metricCheckResult("DISK", sample, 80, { ts: NOW - ageMs, now: NOW, maxAgeMs: 90_000 });

  it("a sample within maxAge is evaluated normally (fresh low → up)", () => {
    expect(aged(89_000).up).toBe(true);
  });
  it("a sample older than maxAge is a failure, not a recovery", () => {
    expect(aged(91_000).up).toBe(false);
    expect(aged(91_000).msg).toContain("stale");
  });
  it("a future-dated sample beyond the 60s skew tolerance is a failure", () => {
    expect(metricCheckResult("DISK", sample, 80, { ts: NOW + 61_000, now: NOW, maxAgeMs: 90_000 }).up).toBe(false);
  });
  it("accepts both Date and numeric timestamps", () => {
    expect(metricCheckResult("DISK", sample, 80, { ts: new Date(NOW - 5_000), now: NOW, maxAgeMs: 90_000 }).up).toBe(true);
  });
  it("fails CLOSED on an unknown sample age (null/NaN ts) once freshness is requested", () => {
    expect(metricCheckResult("DISK", sample, 80, { ts: null, now: NOW, maxAgeMs: 90_000 }).up).toBe(false);
    expect(metricCheckResult("DISK", sample, 80, { ts: NaN, now: NOW, maxAgeMs: 90_000 }).up).toBe(false);
  });
  it("a null sample fails when noDataIsDown, but is 'no metrics yet' (UP) otherwise", () => {
    expect(metricCheckResult("DISK", null, 80, { now: NOW, maxAgeMs: 90_000, noDataIsDown: true }).up).toBe(false);
    expect(metricCheckResult("DISK", null, 80, { now: NOW, maxAgeMs: 90_000, noDataIsDown: false }).up).toBe(true);
  });
  it("keeps the legacy pure-threshold behaviour when freshness is omitted entirely", () => {
    expect(metricCheckResult("DISK", sample, 80).up).toBe(true); // no freshness arg → threshold only
  });
});
