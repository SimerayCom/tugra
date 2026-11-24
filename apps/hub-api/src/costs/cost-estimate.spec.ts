import { estimateCost, toCents } from "./cost-estimate";
import { PRICE_SNAPSHOT, PRICE_SNAPSHOT_DATE, snapshotFor } from "./price-snapshot.data";

const GIB = 1024 ** 3;

describe("price snapshot data", () => {
  it("is dated and every row is a usable positive price", () => {
    expect(PRICE_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const s of PRICE_SNAPSHOT) {
      expect(s.currency).toMatch(/^[A-Z]{3}$/);
      expect(new Set(s.plans.map((p) => p.slug)).size).toBe(s.plans.length);
      for (const p of s.plans) {
        expect(Number.isInteger(p.monthlyCents) && p.monthlyCents > 0).toBe(true);
        expect(p.cores).toBeGreaterThan(0);
        expect(p.memoryGb).toBeGreaterThan(0);
        expect(p.diskGb).toBeGreaterThan(0);
      }
    }
  });
});

describe("estimateCost", () => {
  it("matches a Hetzner 2 vCPU / 4 GB / 40 GB host to its own list", () => {
    const e = estimateCost("hetzner", { cores: 2, memBytes: 3.7 * GIB, diskBytes: 38 * GIB, arch: "amd64" });
    expect(e).toMatchObject({ provider: "hetzner", basis: "list", planSlug: "cx23", monthlyCents: 599, currency: "EUR", verified: true });
    expect(e?.snapshotDate).toBe(PRICE_SNAPSHOT_DATE);
  });

  it("keeps an ARM host on ARM plans", () => {
    const e = estimateCost("hetzner", { cores: 4, memBytes: 7.6 * GIB, diskBytes: 76 * GIB, arch: "arm64" });
    expect(e?.planSlug).toBe("cax21");
  });

  it("uses the provider's own currency", () => {
    const e = estimateCost("digitalocean", { cores: 2, memBytes: 3.8 * GIB, diskBytes: 77 * GIB, arch: "x86_64" });
    expect(e).toMatchObject({ provider: "digitalocean", planSlug: "s-2vcpu-4gb", monthlyCents: 2400, currency: "USD", basis: "list" });
  });

  it("flags a provider without a snapshot as a reference-list estimate", () => {
    const e = estimateCost("aws", { cores: 4, memBytes: 7.5 * GIB, diskBytes: 150 * GIB, arch: "x86_64" });
    expect(e?.basis).toBe("reference");
    expect(e?.provider).toBe("hetzner");
    const none = estimateCost(null, { cores: 4, memBytes: 7.5 * GIB, diskBytes: 150 * GIB });
    expect(none?.basis).toBe("reference");
  });

  it("marks an unverified provider list", () => {
    const e = estimateCost("vultr", { cores: 2, memBytes: 3.8 * GIB, diskBytes: 75 * GIB });
    expect(e).toMatchObject({ provider: "vultr", verified: false });
  });

  it("returns null when the host size is unknown", () => {
    expect(estimateCost("hetzner", { cores: null, memBytes: null, diskBytes: null })).toBeNull();
  });

  it("works with a partial size (cores only)", () => {
    expect(estimateCost("hetzner", { cores: 8, memBytes: null, diskBytes: null })).not.toBeNull();
  });

  it("every snapshot plan estimates to itself at its nominal size", () => {
    for (const s of PRICE_SNAPSHOT) {
      for (const p of s.plans) {
        const e = estimateCost(s.provider, { cores: p.cores, memBytes: p.memoryGb * GIB * 0.94, diskBytes: p.diskGb * GIB * 0.92, arch: p.arch === "arm" ? "arm64" : "x86_64" });
        const same = s.plans.filter((o) => o.arch === p.arch && o.cores === p.cores && o.memoryGb === p.memoryGb && o.diskGb === p.diskGb);
        expect(same.map((o) => o.slug)).toContain(e?.planSlug);
      }
    }
    expect(snapshotFor("hetzner")?.plans.length).toBeGreaterThan(10);
  });
});

describe("toCents", () => {
  it("converts decimal money to integer cents", () => {
    expect(toCents(12.5)).toBe(1250);
    expect(toCents(5.99)).toBe(599);
    expect(toCents(0)).toBe(0);
  });
  it("refuses negatives, NaN and absurd numbers", () => {
    expect(toCents(-1)).toBeNull();
    expect(toCents(NaN)).toBeNull();
    expect(toCents(1e12)).toBeNull();
  });
});
