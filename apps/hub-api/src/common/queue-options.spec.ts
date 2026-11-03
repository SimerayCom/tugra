import { DEFAULT_JOB_OPTIONS } from "./queue-options";

describe("DEFAULT_JOB_OPTIONS", () => {
  it("bounds finished-job retention so a queue's Redis footprint can't grow without limit", () => {
    // A guard: if either is dropped or set to false/0, repeatable-job queues would accumulate jobs forever.
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toEqual(expect.any(Number));
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete as number).toBeGreaterThan(0);
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toEqual(expect.any(Number));
    expect(DEFAULT_JOB_OPTIONS.removeOnFail as number).toBeGreaterThan(0);
  });
});
