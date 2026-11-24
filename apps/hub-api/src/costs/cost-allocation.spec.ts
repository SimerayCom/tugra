import { allocate, groupUse } from "./cost-allocation";

describe("allocate", () => {
  it("splits half by CPU and half by memory", () => {
    const r = allocate(1000, [
      { key: "a", cpuSum: 90, memSum: 10 },
      { key: "b", cpuSum: 10, memSum: 90 },
    ]);
    expect(r.map((x) => x.cents)).toEqual([500, 500]);
    expect(r.every((x) => x.sharePct === 50)).toBe(true);
  });

  it("the shares always add up to exactly the price (largest remainder)", () => {
    const r = allocate(1000, [
      { key: "a", cpuSum: 1, memSum: 1 },
      { key: "b", cpuSum: 1, memSum: 1 },
      { key: "c", cpuSum: 1, memSum: 1 },
    ]);
    expect(r.reduce((a, x) => a + x.cents, 0)).toBe(1000);
    expect(r.map((x) => x.cents).sort()).toEqual([333, 333, 334]);
  });

  it("falls back to memory alone when nothing reports CPU, and to nothing when nothing is measured", () => {
    expect(allocate(100, [{ key: "a", cpuSum: 0, memSum: 3 }, { key: "b", cpuSum: 0, memSum: 1 }]).map((x) => [x.key, x.cents])).toEqual([["a", 75], ["b", 25]]);
    expect(allocate(100, [{ key: "a", cpuSum: 0, memSum: 0 }])).toEqual([]);
    expect(allocate(100, [])).toEqual([]);
  });

  it("is ordered biggest first", () => {
    const r = allocate(100, [{ key: "small", cpuSum: 1, memSum: 1 }, { key: "big", cpuSum: 9, memSum: 9 }]);
    expect(r[0].key).toBe("big");
  });

  it("a zero price gives zero shares", () => {
    expect(allocate(0, [{ key: "a", cpuSum: 1, memSum: 1 }]).map((x) => x.cents)).toEqual([0]);
  });
});

describe("groupUse", () => {
  it("folds containers into their group", () => {
    const g = groupUse(
      [
        { containerName: "tugra_a-web-1", cpuSum: 1, memSum: 10 },
        { containerName: "tugra_a-db-1", cpuSum: 2, memSum: 20 },
        { containerName: "other", cpuSum: 5, memSum: 5 },
      ],
      (n) => (n.startsWith("tugra_a") ? "app:a" : "other"),
    );
    expect(g).toEqual([
      { key: "app:a", cpuSum: 3, memSum: 30 },
      { key: "other", cpuSum: 5, memSum: 5 },
    ]);
  });
});
