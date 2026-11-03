import { reapIfGone } from "./orphan-reap";

describe("reapIfGone", () => {
  it("runs (returns true) and does NOT unschedule when the row still exists", async () => {
    const unschedule = jest.fn().mockResolvedValue(undefined);
    expect(await reapIfGone("x", () => Promise.resolve(true), unschedule)).toBe(true);
    expect(unschedule).not.toHaveBeenCalled();
  });

  it("unschedules (returns false) when the row is gone", async () => {
    const unschedule = jest.fn().mockResolvedValue(undefined);
    expect(await reapIfGone("x", () => Promise.resolve(false), unschedule)).toBe(false);
    expect(unschedule).toHaveBeenCalledWith("x");
  });

  it("fail-safe: a lookup error propagates and never unschedules (the schedule is kept)", async () => {
    const unschedule = jest.fn().mockResolvedValue(undefined);
    await expect(reapIfGone("x", () => Promise.reject(new Error("db down")), unschedule)).rejects.toThrow("db down");
    expect(unschedule).not.toHaveBeenCalled();
  });
});
