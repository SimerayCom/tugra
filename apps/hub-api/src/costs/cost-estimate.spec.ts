import { estimateCost, noEstimateReason, planLabel, similarCost, toCents } from "./cost-estimate";
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
        if (p.diskGb !== null) expect(p.diskGb).toBeGreaterThan(0);
      }
    }
  });

  it("every provider carries its own read date and an https source URL", () => {
    for (const s of PRICE_SNAPSHOT) {
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.date <= PRICE_SNAPSHOT_DATE).toBe(true);
      expect(s.sourceUrl).toMatch(/^https:\/\//);
    }
    expect(PRICE_SNAPSHOT.some((s) => s.date === PRICE_SNAPSHOT_DATE)).toBe(true);
  });

  it("lists the providers whose public prices were read on the snapshot date", () => {
    for (const slug of ["contabo", "ovh", "netcup", "linode", "scaleway", "ionos"]) {
      const s = snapshotFor(slug);
      expect(s).toBeDefined();
      expect(s?.date).toBe("2026-11-25");
    }
    expect(snapshotFor("contabo")?.currency).toBe("EUR");
    expect(snapshotFor("linode")?.currency).toBe("USD");
    expect(snapshotFor("ionos")?.currency).toBe("GBP");
    // UpCloud's page could not be read: it is left out rather than guessed.
    expect(snapshotFor("upcloud")).toBeUndefined();
  });
});

describe("estimateCost", () => {
  it("matches a Hetzner 2 vCPU / 4 GB / 40 GB host to its own list", () => {
    const e = estimateCost("hetzner", { cores: 2, memBytes: 3.7 * GIB, diskBytes: 38 * GIB, arch: "amd64" });
    expect(e).toMatchObject({ provider: "hetzner", basis: "list", planSlug: "cx23", monthlyCents: 599, currency: "EUR", verified: true });
    expect(e?.snapshotDate).toBe(snapshotFor("hetzner")?.date);
  });

  it("keeps an ARM host on ARM plans", () => {
    const e = estimateCost("hetzner", { cores: 4, memBytes: 7.6 * GIB, diskBytes: 76 * GIB, arch: "arm64" });
    expect(e?.planSlug).toBe("cax21");
  });

  it("uses the provider's own currency", () => {
    const e = estimateCost("digitalocean", { cores: 2, memBytes: 3.8 * GIB, diskBytes: 77 * GIB, arch: "x86_64" });
    expect(e).toMatchObject({ provider: "digitalocean", planSlug: "s-2vcpu-4gb", monthlyCents: 2400, currency: "USD", basis: "list" });
  });

  it("never prices a host from another provider's list", () => {
    // Contabo's 12 vCPU / 48 GB VPS used to come out as a Hetzner plan at about 4x its real price.
    const host = { cores: 12, memBytes: 47 * GIB, diskBytes: 774 * GIB, arch: "x86_64" };
    expect(estimateCost(null, host)).toBeNull();
    expect(estimateCost("aws", host)).toBeNull();
    expect(noEstimateReason(null, host)).toBe("no_provider");
    expect(noEstimateReason("aws", host)).toBe("no_list");
  });

  it("prices a Contabo 12 vCPU / 48 GB host from the Contabo list", () => {
    const e = estimateCost("contabo", { cores: 12, memBytes: 47 * GIB, diskBytes: 774 * GIB, arch: "x86_64" });
    expect(e).toMatchObject({ provider: "contabo", basis: "list", planSlug: "cloud-vps-12", monthlyCents: 2500, currency: "EUR", snapshotDate: "2026-11-25", planLabel: "Cloud VPS 12 · 12 vCPU · 48 GB · 400 GB" });
  });

  it("prices hosts of the other new providers from their own lists and currencies", () => {
    expect(estimateCost("ovh", { cores: 4, memBytes: 7.6 * GIB, diskBytes: 70 * GIB })).toMatchObject({ planSlug: "vps-2", currency: "EUR" });
    expect(estimateCost("netcup", { cores: 8, memBytes: 15 * GIB, diskBytes: 250 * GIB })).toMatchObject({ planSlug: "vps-2000-g12-5", currency: "EUR" });
    expect(estimateCost("linode", { cores: 2, memBytes: 3.8 * GIB, diskBytes: 78 * GIB })).toMatchObject({ planSlug: "g6-standard-2", monthlyCents: 2400, currency: "USD" });
    expect(estimateCost("ionos", { cores: 4, memBytes: 7.6 * GIB, diskBytes: 230 * GIB })).toMatchObject({ planSlug: "vps-l-plus", monthlyCents: 2200, currency: "GBP" });
  });

  it("scaleway: instance-only plans, ARM hosts stay on ARM plans", () => {
    expect(estimateCost("scaleway", { cores: 4, memBytes: 15 * GIB, arch: "x86_64" })?.planSlug).toBe("basic3-x4c-16g");
    expect(estimateCost("scaleway", { cores: 4, memBytes: 15 * GIB, arch: "aarch64" })?.planSlug).toBe("basic2-a4c-16g");
    expect(estimateCost("scaleway", { cores: 4, memBytes: 15 * GIB })?.planLabel).toBe("BASIC3-X4C-16G · 4 vCPU · 16 GB");
  });

  it("gives no estimate when no plan of the provider is near the host's size", () => {
    const big = { cores: 64, memBytes: 250 * GIB, diskBytes: 2000 * GIB, arch: "x86_64" };
    expect(estimateCost("contabo", big)).toBeNull();
    expect(noEstimateReason("contabo", big)).toBe("no_plan");
    // An ARM host on a list with no ARM plans cannot be priced from it either.
    expect(estimateCost("contabo", { cores: 4, memBytes: 7.6 * GIB, arch: "arm64" })).toBeNull();
  });

  it("reports why a host has no estimate", () => {
    expect(noEstimateReason("hetzner", { cores: null, memBytes: null, diskBytes: 40 * GIB })).toBe("no_size");
    expect(noEstimateReason("hetzner", { cores: 2, memBytes: 3.7 * GIB, diskBytes: 38 * GIB })).toBeNull();
  });
});

describe("similarCost", () => {
  it("offers a similar size on the comparison list, only when a plan is close", () => {
    const s = similarCost({ cores: 12, memBytes: 47 * GIB, diskBytes: 774 * GIB, arch: "x86_64" });
    expect(s).toMatchObject({ provider: "hetzner", currency: "EUR" });
    expect(s?.monthlyCents).toBeGreaterThan(0);
    expect(similarCost({ cores: 200, memBytes: 900 * GIB })).toBeNull();
    expect(similarCost({ cores: null, memBytes: null, diskBytes: 100 * GIB })).toBeNull();
  });
});

describe("planLabel", () => {
  it("uses the plan name, else the slug, and leaves out an unknown disk", () => {
    expect(planLabel({ slug: "cx23", cores: 2, memoryGb: 4, diskGb: 40 })).toBe("CX23 · 2 vCPU · 4 GB · 40 GB");
    expect(planLabel({ slug: "x", name: "Cloud VPS 4", cores: 4, memoryGb: 8, diskGb: null })).toBe("Cloud VPS 4 · 4 vCPU · 8 GB");
  });
});

describe("estimateCost sizes", () => {
  it("returns null when the host size is unknown", () => {
    expect(estimateCost("hetzner", { cores: null, memBytes: null, diskBytes: null })).toBeNull();
  });

  it("works with a partial size (cores only)", () => {
    expect(estimateCost("hetzner", { cores: 8, memBytes: null, diskBytes: null })).not.toBeNull();
  });

  it("every snapshot plan estimates to itself at its nominal size", () => {
    for (const s of PRICE_SNAPSHOT) {
      for (const p of s.plans) {
        const e = estimateCost(s.provider, { cores: p.cores, memBytes: p.memoryGb * GIB * 0.94, diskBytes: p.diskGb === null ? null : p.diskGb * GIB * 0.92, arch: p.arch === "arm" ? "arm64" : "x86_64" });
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
