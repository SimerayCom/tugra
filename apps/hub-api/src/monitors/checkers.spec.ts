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
