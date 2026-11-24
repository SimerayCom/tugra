import { CLOUDFLARE_ORIGIN_CODES, cloudflareCause, cloudflareReason, cloudflareSummary } from "./cloudflare";

describe("cloudflare origin failures", () => {
  it("tags every documented 520-526 status", () => {
    for (const c of CLOUDFLARE_ORIGIN_CODES) expect(cloudflareCause(c)).toBe(`cf:${c}`);
  });

  it("does not tag ordinary errors or the non-origin Cloudflare codes", () => {
    for (const c of [200, 404, 500, 502, 503, 519, 527, 530]) expect(cloudflareCause(c)).toBeNull();
  });

  it("maps a cause to the likely reason class", () => {
    expect(cloudflareReason("cf:521")).toBe("origin_down");
    expect(cloudflareReason("cf:522")).toBe("connect_timeout");
    expect(cloudflareReason("cf:524")).toBe("timeout");
    expect(cloudflareReason("cf:525")).toBe("ssl_handshake");
    expect(cloudflareReason("cf:526")).toBe("ssl_invalid");
    expect(cloudflareReason("cf:999")).toBeNull();
    expect(cloudflareReason(null)).toBeNull();
  });

  it("writes a plain summary", () => {
    expect(cloudflareSummary(522)).toBe("HTTP 522 (Cloudflare <-> origin)");
  });
});
