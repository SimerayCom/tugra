import { describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { IDLE_AFTER_MS, PollingQueryClient, idleInterval, withIdleSlowdown } from "./idle-polling";

describe("idleInterval", () => {
  it("leaves active polls alone", () => {
    expect(idleInterval(5000, false)).toBe(5000);
  });
  it("slows idle polls 4x, capped at 2 minutes", () => {
    expect(idleInterval(5000, true)).toBe(20_000);
    expect(idleInterval(30_000, true)).toBe(120_000);
    expect(idleInterval(60_000, true)).toBe(120_000);
  });
  it("never slows operation-watching polls (< 4 s)", () => {
    expect(idleInterval(1500, true)).toBe(1500);
    expect(idleInterval(3000, true)).toBe(3000);
  });
});

describe("withIdleSlowdown", () => {
  it("passes false / undefined through", () => {
    expect(withIdleSlowdown(false, () => true)).toBe(false);
    expect(withIdleSlowdown(undefined, () => true)).toBeUndefined();
  });
  it("wraps numbers and functions and keeps a function's false", () => {
    let idle = false;
    const n = withIdleSlowdown(5000, () => idle) as () => number;
    expect(n()).toBe(5000);
    idle = true;
    expect(n()).toBe(20_000);
    const f = withIdleSlowdown((() => false) as never, () => idle) as (q: never) => unknown;
    expect(f(undefined as never)).toBe(false);
    const g = withIdleSlowdown((() => 10_000) as never, () => idle) as (q: never) => unknown;
    expect(g(undefined as never)).toBe(40_000);
  });
});

describe("PollingQueryClient", () => {
  it("wraps refetchInterval exactly once and tracks idle state", () => {
    const qc = new PollingQueryClient();
    const o = qc.defaultQueryOptions({ queryKey: ["a"], queryFn: async () => 1, refetchInterval: 5000 });
    expect(typeof o.refetchInterval).toBe("function");
    expect(qc.defaultQueryOptions(o)).toBe(o);
    const now = Date.now();
    qc.checkIdle(now + IDLE_AFTER_MS - 1);
    expect(qc.isIdle()).toBe(false);
    qc.checkIdle(now + IDLE_AFTER_MS + 10);
    expect(qc.isIdle()).toBe(true);
    expect((o.refetchInterval as () => number)()).toBe(20_000);
    qc.markActive();
    expect(qc.isIdle()).toBe(false);
    expect((o.refetchInterval as () => number)()).toBe(5000);
  });

  it("refetches a polling query immediately when activity returns, and not a static one", async () => {
    const qc = new PollingQueryClient();
    const polled = vi.fn(async () => "p");
    const stat = vi.fn(async () => "s");
    const a = new QueryObserver(qc, { queryKey: ["poll"], queryFn: polled, refetchInterval: 60_000 });
    const b = new QueryObserver(qc, { queryKey: ["static"], queryFn: stat });
    const ua = a.subscribe(() => undefined);
    const ub = b.subscribe(() => undefined);
    await vi.waitFor(() => expect(polled).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(qc.getQueryState(["poll"])?.fetchStatus).toBe("idle"));
    expect(stat).toHaveBeenCalledTimes(1);
    qc.checkIdle(Date.now() + IDLE_AFTER_MS + 10);
    expect(qc.isIdle()).toBe(true);
    qc.markActive();
    await vi.waitFor(() => expect(polled).toHaveBeenCalledTimes(2));
    expect(stat).toHaveBeenCalledTimes(1);
    ua();
    ub();
    qc.clear();
  });
});
