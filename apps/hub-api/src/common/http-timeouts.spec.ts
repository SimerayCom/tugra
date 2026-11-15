import { applyTransferTimeouts, DEFAULT_REQUEST_TIMEOUT_MS } from "./http-timeouts";

describe("applyTransferTimeouts", () => {
  it("raises Node's 300 s request timeout above the 10-minute transfer ceiling", () => {
    const s = { requestTimeout: 300_000 };
    expect(applyTransferTimeouts(s, {})).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(s.requestTimeout).toBe(15 * 60 * 1000);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1000);
  });

  it("honours HUB_REQUEST_TIMEOUT_MS (0 disables) and never lowers a higher value", () => {
    expect(applyTransferTimeouts({ requestTimeout: 300_000 }, { HUB_REQUEST_TIMEOUT_MS: "1200000" })).toBe(1_200_000);
    expect(applyTransferTimeouts({ requestTimeout: 300_000 }, { HUB_REQUEST_TIMEOUT_MS: "0" })).toBe(0);
    expect(applyTransferTimeouts({ requestTimeout: 0 }, {})).toBe(0);
    expect(applyTransferTimeouts({ requestTimeout: 3_600_000 }, {})).toBe(3_600_000);
    expect(applyTransferTimeouts({ requestTimeout: 300_000 }, { HUB_REQUEST_TIMEOUT_MS: "junk" })).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(applyTransferTimeouts({}, {})).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});
