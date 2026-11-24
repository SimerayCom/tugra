import { advise, fits, limitReasons, type Candidate, type CurrentSize, type UsageStats } from "./rightsizing";

const GIB = 1024 ** 3;
const cand = (slug: string, cores: number, memoryGb: number, diskGb: number, monthlyCents: number, arch = "x86"): Candidate => ({
  slug,
  label: slug,
  cores,
  memoryGb,
  diskGb,
  arch,
  monthlyCents,
  currency: "EUR",
});

const CANDIDATES = [cand("small", 2, 4, 40, 600), cand("mid", 4, 8, 80, 900), cand("big", 8, 16, 160, 1650), cand("huge", 16, 32, 320, 3000), cand("armmid", 4, 8, 80, 800, "arm")];
const CURRENT: CurrentSize = { cores: 8, memBytes: 16 * GIB * 0.94, diskGb: 80, arch: "x86", comparableMonthlyCents: 1650, currency: "EUR", planSlug: "big" };

const usage = (o: Partial<UsageStats> = {}): UsageStats => ({
  daysCollected: 14.2,
  cpuAvgPct: 5,
  cpuP95Pct: 12,
  cpuPeakPct: 30,
  memP95Pct: 20,
  memPeakPct: 25,
  memP95Bytes: 3 * GIB,
  memPeakBytes: 3.5 * GIB,
  diskUsedPct: 30,
  diskUsedBytes: 20 * GIB,
  ...o,
});

describe("advise", () => {
  it("is 'learning' with no data or under 14 days: no number is guessed from a short window", () => {
    expect(advise(null, CURRENT, CANDIDATES).kind).toBe("learning");
    expect(advise(usage({ daysCollected: 9 }), CURRENT, CANDIDATES).kind).toBe("learning");
  });

  it("suggests the cheapest plan that holds the load, and the monthly saving", () => {
    const a = advise(usage(), CURRENT, CANDIDATES);
    expect(a.kind).toBe("downsize");
    expect(a.target?.slug).toBe("mid"); // small has too little RAM headroom for 3.5 GiB peak? 4GB*0.94*0.9=3.38 < 3.5
    expect(a.savingsCents).toBe(750);
  });

  it("prefers a plan that keeps the disk over a cheaper one with a smaller disk (disks do not shrink)", () => {
    const a = advise(usage({ memP95Bytes: 1 * GIB, memPeakBytes: 1.5 * GIB }), CURRENT, CANDIDATES);
    expect(a.target?.slug).toBe("mid"); // small (40 GB) is cheaper and big enough, but the disk is 80 GB
    expect(a.diskBlocked).toBe(false);
  });

  it("when only smaller-disk plans would save money it says so: it takes a new, smaller server", () => {
    const a = advise(usage(), { ...CURRENT, diskGb: 160, comparableMonthlyCents: 1650 }, CANDIDATES);
    expect(a.kind).toBe("downsize");
    expect(a.diskBlocked).toBe(true);
    expect(a.target?.diskGb).toBeLessThan(160);
    expect(a.savingsCents).toBeGreaterThan(0);
  });

  it("never crosses processor architecture, and never suggests the current plan", () => {
    const a = advise(usage(), { ...CURRENT, arch: "arm", planSlug: "armmid", comparableMonthlyCents: 800 }, CANDIDATES);
    expect(a.kind).toBe("ok");
    expect(a.target).toBeNull();
  });

  it("keeps CPU headroom: p95 above 70% of the target's cores rules it out", () => {
    // 8 cores at 50% p95 = 4 busy cores; mid (4 cores) would run at 100%.
    const a = advise(usage({ cpuP95Pct: 50, cpuPeakPct: 60, memP95Bytes: 1 * GIB, memPeakBytes: 1 * GIB }), CURRENT, CANDIDATES);
    expect(a.target?.slug).not.toBe("mid");
    expect(a.target === null || a.target.cores >= 8).toBe(true);
  });

  it("ignores a saving that is too small to be worth a move", () => {
    const cheap = [cand("a", 2, 4, 80, 1600), cand("b", 4, 8, 80, 1640)];
    const a = advise(usage(), { ...CURRENT, comparableMonthlyCents: 1650 }, cheap);
    expect(a.kind).toBe("ok");
  });

  it("is 'ok' when the server is right-sized", () => {
    const a = advise(usage({ cpuP95Pct: 60, cpuPeakPct: 90, memP95Bytes: 10 * GIB, memPeakBytes: 12 * GIB }), CURRENT, CANDIDATES);
    expect(a.kind).toBe("ok");
  });

  it("flags 'near its limit' on CPU, memory or disk, with the cheapest bigger plan", () => {
    const cpu = advise(usage({ cpuP95Pct: 90, cpuPeakPct: 100 }), CURRENT, CANDIDATES);
    expect(cpu.kind).toBe("near_limit");
    expect(cpu.reasons).toEqual(["cpu"]);
    expect(cpu.target?.slug).toBe("huge");
    expect(cpu.savingsCents).toBe(-1350);
    const mem = advise(usage({ memP95Pct: 95, memP95Bytes: 14.5 * GIB, memPeakBytes: 15 * GIB }), CURRENT, CANDIDATES);
    expect(mem.reasons).toEqual(["memory"]);
    expect(mem.target?.slug).toBe("huge");
  });

  it("a full disk is only fixed by a plan with a bigger disk, and asks to grow it", () => {
    const a = advise(usage({ diskUsedPct: 95, diskUsedBytes: 74 * GIB }), CURRENT, CANDIDATES);
    expect(a.kind).toBe("near_limit");
    expect(a.reasons).toEqual(["disk"]);
    expect(a.target?.diskGb).toBeGreaterThan(80);
    expect(a.upgradeDisk).toBe(true);
  });

  it("near the limit with no bigger plan known still says so, without a target", () => {
    const a = advise(usage({ cpuP95Pct: 95, cpuPeakPct: 100 }), CURRENT, [cand("only", 2, 4, 40, 600)]);
    expect(a.kind).toBe("near_limit");
    expect(a.target).toBeNull();
  });

  it("gives no saving figure when the current price cannot be compared", () => {
    const a = advise(usage(), { ...CURRENT, comparableMonthlyCents: null }, CANDIDATES);
    expect(a.kind).toBe("ok");
  });

  it("does not mix currencies", () => {
    const usd = CANDIDATES.map((c) => ({ ...c, currency: "USD" }));
    expect(advise(usage(), CURRENT, usd).target).toBeNull();
  });
});

describe("fits / limitReasons", () => {
  it("holds a busiest minute under the plan's capacity", () => {
    expect(fits(usage({ cpuPeakPct: 100 }), cand("c", 4, 8, 80, 1), 8)).toBe(false); // 8 busy cores on 4
    expect(fits(usage(), cand("c", 4, 8, 80, 1), 8)).toBe(true);
  });
  it("reports every reason at once", () => {
    expect(limitReasons(usage({ cpuP95Pct: 86, memP95Pct: 91, diskUsedPct: 90 }))).toEqual(["cpu", "memory", "disk"]);
    expect(limitReasons(usage())).toEqual([]);
  });
});
