import type { Monitor } from "@prisma/client";
import { httpCheck } from "./checkers";

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
