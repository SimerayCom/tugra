import { describe, it, expect } from "vitest";
import type { TakeoverItemView, TakeoverStatus, TakeoverView } from "@tugra/shared";
import { actionsFor, canSwap, confirmMatches, pollMs, rollup, verifyHasWork } from "./inplace";

type D = TakeoverItemView["domains"][number];
const dom = (o: Partial<D> = {}): D => ({ host: "a.example.com", tempCheck: "ok", finalCheck: "pending", cert: "pending", ...o });
const item = (o: Partial<TakeoverItemView> = {}): TakeoverItemView => ({ itemRef: "app:s:a", name: "a", buildMode: "reuse-image", domains: [dom()], ...o });
const view = (status: TakeoverStatus, items: TakeoverItemView[] = [item()], o: Partial<TakeoverView> = {}): TakeoverView => ({ id: "t1", serverId: "s1", status, tempPort: null, items, giveBackAvailable: true, createdAt: "x", finishedAt: null, ...o });

describe("canSwap", () => {
  it("needs a TESTING takeover with every side-by-side domain tested", () => {
    expect(canSwap(view("TESTING"))).toBe(true);
    expect(canSwap(view("PLANNED"))).toBe(false);
    expect(canSwap(view("TESTING", [item({ domains: [dom({ tempCheck: "failed" })] })]))).toBe(false);
    expect(canSwap(view("TESTING", [item({ domains: [dom({ tempCheck: "pending" })] })]))).toBe(false);
  });
  it("an app that shares data with Coolify's copy is not held up for a test it cannot have, and a skipped app is ignored", () => {
    expect(canSwap(view("TESTING", [item({ exclusive: true, domains: [dom({ tempCheck: "pending" })] })]))).toBe(true);
    expect(canSwap(view("TESTING", [item(), item({ skipped: true, domains: [dom({ tempCheck: "failed" })] })]))).toBe(true);
    expect(canSwap(view("TESTING", [item({ skipped: true })]))).toBe(false);
  });
});

describe("actionsFor", () => {
  it("nothing yet or given back: only plan", () => {
    expect(actionsFor(null)).toEqual(["plan"]);
    expect(actionsFor(view("GIVEN_BACK", [item()], { giveBackAvailable: false }))).toEqual(["plan"]);
  });
  it("planned: test and give back; tested and good: swap is offered", () => {
    expect(actionsFor(view("PLANNED"))).toEqual(["test", "giveBack"]);
    expect(actionsFor(view("TESTING"))).toEqual(["test", "swap", "giveBack"]);
    expect(actionsFor(view("TESTING", [item({ domains: [dom({ tempCheck: "failed" })] })]))).toEqual(["test", "giveBack"]);
  });
  it("swapped or verified: verify and give back, never test or swap", () => {
    expect(actionsFor(view("SWAPPED"))).toEqual(["verify", "giveBack"]);
    expect(actionsFor(view("VERIFIED"))).toEqual(["verify", "giveBack"]);
  });
  it("failed before the ports changed can be tested again; failed after is only given back", () => {
    expect(actionsFor(view("FAILED"))).toEqual(["test", "giveBack"]);
    expect(actionsFor(view("FAILED", [item({ domains: [dom({ finalCheck: "ok", cert: "fallback" })] })]))).toEqual(["giveBack"]);
  });
  it("a takeover that is being undone offers nothing", () => {
    expect(actionsFor(view("GIVING_BACK"))).toEqual([]);
  });
  it("no give back once it is not available", () => {
    expect(actionsFor(view("SWAPPED", [item()], { giveBackAvailable: false }))).toEqual(["verify"]);
  });
});

describe("rollup and polling", () => {
  it("counts apps, skipped apps, domains, checks and certificates", () => {
    const r = rollup(
      view("SWAPPED", [
        item({ domains: [dom({ finalCheck: "ok", cert: "issued" }), dom({ host: "b", tempCheck: "failed", finalCheck: "failed", cert: "failed" })] }),
        item({ skipped: true, domains: [dom()] }),
        item({ domains: [dom({ host: "c", cert: "fallback" })] }),
      ]),
    );
    expect(r).toEqual({ apps: 2, skipped: 1, domains: 3, tested: 2, testFailed: 1, checked: 1, checkFailed: 1, certs: { pending: 0, fallback: 1, issued: 1, failed: 1 } });
  });
  it("verify has work while a domain of a swapped takeover has no new certificate", () => {
    expect(verifyHasWork(view("SWAPPED", [item({ domains: [dom({ cert: "fallback" })] })]))).toBe(true);
    expect(verifyHasWork(view("SWAPPED", [item({ domains: [dom({ cert: "issued" })] })]))).toBe(false);
    expect(verifyHasWork(view("VERIFIED"))).toBe(false);
  });
  it("polls only while something moves on its own", () => {
    expect(pollMs(view("TESTING"))).toBe(4000);
    expect(pollMs(view("SWAPPING"))).toBe(4000);
    expect(pollMs(view("GIVING_BACK"))).toBe(4000);
    expect(pollMs(view("SWAPPED"))).toBe(false);
    expect(pollMs(view("GIVEN_BACK"))).toBe(false);
    expect(pollMs(null)).toBe(false);
  });
  it("the typed name must match exactly (a trailing space does not matter, an empty name never matches)", () => {
    expect(confirmMatches("box-1 ", "box-1")).toBe(true);
    expect(confirmMatches("Box-1", "box-1")).toBe(false);
    expect(confirmMatches("", "")).toBe(false);
  });
});
