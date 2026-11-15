import { GIB, planRetention, type RetentionRow } from "./retention";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 15, 12);
let seq = 0;
const row = (series: string, ageDays: number, sizeGb: number | null): RetentionRow => ({
  id: `r${++seq}`,
  series,
  createdAt: new Date(NOW - ageDays * DAY),
  sizeBytes: sizeGb == null ? null : BigInt(sizeGb) * GIB,
});
const ids = (p: { remove: { id: string }[] }) => p.remove.map((r) => r.id);

// Deterministic pseudo-random so the property test is reproducible.
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

describe("planRetention", () => {
  it("equals the legacy DB rule i!==0 && (i>=keep || old) when size is off (property)", () => {
    const rand = rng(42);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rand() * 15);
      const keep = 1 + Math.floor(rand() * 8);
      const maxAge = rand() < 0.5 ? null : 1 + Math.floor(rand() * 30);
      let age = 0;
      const rows: RetentionRow[] = [];
      for (let i = 0; i < n; i++) {
        age += rand() * 5;
        rows.push(row("db", age, rand() < 0.3 ? null : 1));
      }
      const cutoff = maxAge != null ? NOW - maxAge * DAY : null;
      const legacy = rows.filter((r, i) => i !== 0 && (i >= keep || (cutoff != null && r.createdAt.getTime() < cutoff))).map((r) => r.id);
      expect(ids(planRetention(rows, { keep, maxAgeDays: maxAge, maxBytes: null }, NOW)).sort()).toEqual(legacy.sort());
    }
  });

  it("with no age/size matches slice(keep) for volume/hub rows (keep >= 1)", () => {
    const rows = [row("v", 1, 1), row("v", 2, 1), row("v", 3, 1), row("v", 4, 1)];
    expect(ids(planRetention(rows, { keep: 2, maxAgeDays: null, maxBytes: null }, NOW))).toEqual([rows[2].id, rows[3].id]);
  });

  it("labels count over age when both apply, and age otherwise", () => {
    const rows = [row("v", 1, 1), row("v", 2, 1), row("v", 20, 1), row("v", 30, 1)];
    const p = planRetention(rows, { keep: 3, maxAgeDays: 10, maxBytes: null }, NOW);
    expect(p.remove).toEqual([
      { id: rows[2].id, reason: "age" },
      { id: rows[3].id, reason: "count" },
    ]);
  });

  it("age only: never removes the newest even when it is older than the cutoff", () => {
    const rows = [row("v", 40, 1), row("v", 50, 1)];
    const p = planRetention(rows, { keep: 99, maxAgeDays: 7, maxBytes: null }, NOW);
    expect(ids(p)).toEqual([rows[1].id]);
  });

  it("size only: removes oldest first until within budget; newest per series is protected", () => {
    const rows = [row("v", 1, 4), row("v", 2, 4), row("v", 3, 4), row("v", 4, 4)];
    const p = planRetention(rows, { keep: 99, maxAgeDays: null, maxBytes: 9n * GIB }, NOW);
    expect(p.remove).toEqual([
      { id: rows[3].id, reason: "size" },
      { id: rows[2].id, reason: "size" },
    ]);
    expect(p.usedBytes).toBe(8n * GIB);
    expect(p.overBudget).toBe(false);
  });

  it("pools the budget across series and protects each series' newest", () => {
    const a = [row("a", 1, 5), row("a", 10, 5)];
    const b = [row("b", 2, 5), row("b", 8, 5)];
    const all = [...a, ...b].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
    const p = planRetention(all, { keep: 99, maxAgeDays: null, maxBytes: 12n * GIB }, NOW);
    // 20 GiB used, 12 allowed: drop the oldest (a@10) then b@8 would leave 10 -> only the first needed? 20-5=15>12 -> also b@8
    expect(ids(p)).toEqual([a[1].id, b[1].id]);
    expect(p.usedBytes).toBe(10n * GIB);
  });

  it("counts unknown sizes as 0 for the budget, reports them, and never removes them for size", () => {
    const rows = [row("v", 1, 1), row("v", 2, null), row("v", 3, 5)];
    const p = planRetention(rows, { keep: 99, maxAgeDays: null, maxBytes: 3n * GIB }, NOW);
    expect(ids(p)).toEqual([rows[2].id]);
    expect(p.unknownSizeCount).toBe(1);
    expect(ids(p)).not.toContain(rows[1].id);
  });

  it("reports overBudget when the protected newest rows alone exceed the cap", () => {
    const rows = [row("a", 1, 6), row("b", 2, 6)];
    const p = planRetention(rows, { keep: 5, maxAgeDays: null, maxBytes: 8n * GIB }, NOW);
    expect(p.remove).toEqual([]);
    expect(p.overBudget).toBe(true);
    expect(p.usedBytes).toBe(12n * GIB);
  });

  it("composes count + age + size, and sizes only count the survivors of the first pass", () => {
    const rows = [row("v", 1, 2), row("v", 2, 2), row("v", 3, 2), row("v", 40, 2), row("v", 50, 2)];
    const p = planRetention(rows, { keep: 4, maxAgeDays: 30, maxBytes: 5n * GIB }, NOW);
    expect(p.remove.map((r) => [r.id, r.reason])).toEqual([
      [rows[3].id, "age"],
      [rows[4].id, "count"],
      [rows[2].id, "size"], // 3 survivors = 6 GiB > 5 -> oldest unprotected goes
    ]);
  });

  it("policyOf overrides keep/age per series", () => {
    const rows = [row("a", 1, 1), row("a", 2, 1), row("a", 3, 1), row("b", 1, 1), row("b", 2, 1), row("b", 3, 1)];
    const p = planRetention(rows, { keep: 3, maxAgeDays: null, maxBytes: null }, NOW, (s) => (s === "b" ? { keep: 1, maxAgeDays: null } : { keep: 3, maxAgeDays: null }));
    expect(ids(p).sort()).toEqual([rows[4].id, rows[5].id].sort());
  });
});
