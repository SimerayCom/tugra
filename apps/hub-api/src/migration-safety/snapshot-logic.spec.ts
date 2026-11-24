import { SNAPSHOT_TTL_DAYS, captureDue, expiryOf, isLive, overallStatus, retryable, runAcceptsSnapshot } from "./snapshot-logic";

describe("snapshot logic", () => {
  it("keeps the copy for seven days", () => {
    expect(SNAPSHOT_TTL_DAYS).toBe(7);
    expect(expiryOf(new Date("2026-12-01T00:00:00Z")).toISOString()).toBe("2026-12-08T00:00:00.000Z");
  });
  it("is SUCCESS only when every item copied, PARTIAL when some did, FAILED when none did", () => {
    expect(overallStatus([{ status: "SUCCESS" }, { status: "SUCCESS" }])).toBe("SUCCESS");
    expect(overallStatus([{ status: "SUCCESS" }, { status: "FAILED" }])).toBe("PARTIAL");
    expect(overallStatus([{ status: "FAILED" }])).toBe("FAILED");
  });
  it("is due once DATA_FINAL passed (not before, not for another step)", () => {
    expect(captureDue([{ key: "DATA_SEED", status: "PASSED" }, { key: "DATA_FINAL", status: "RUNNING" }])).toBe(false);
    expect(captureDue([{ key: "DATA_FINAL", status: "PASSED" }])).toBe(true);
    expect(captureDue([])).toBe(false);
  });
  it("a finished or abandoned run takes no new copy", () => {
    expect(runAcceptsSnapshot("RUNNING")).toBe(true);
    expect(runAcceptsSnapshot("WAITING")).toBe(true);
    expect(runAcceptsSnapshot("ABORTED")).toBe(false);
    expect(runAcceptsSnapshot("DRY_RUN_DONE")).toBe(false);
  });
  it("retries only a copy that has not finished well", () => {
    expect(["PLANNED", "FAILED", "PARTIAL"].every(retryable)).toBe(true);
    expect(["CAPTURING", "SUCCESS", "EXPIRED", "SKIPPED"].some(retryable)).toBe(false);
    expect(isLive("SUCCESS") && isLive("PARTIAL") && !isLive("EXPIRED")).toBe(true);
  });
});
