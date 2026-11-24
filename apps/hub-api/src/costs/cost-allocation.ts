/** One container's average use over the window. */
export interface ContainerUse {
  containerName: string;
  /** Sum over the window of the per-minute average CPU %, and of the per-minute average memory bytes. */
  cpuSum: number;
  memSum: number;
}

/**
 * Share of one server's price per group by resource use: half by CPU, half by memory (CPU alone or memory alone when
 * the other totals zero). The shares add up to exactly `totalCents` (largest-remainder rounding), so an app list
 * never shows more or less than the server costs. Pure.
 */
export function allocate(totalCents: number, groups: ReadonlyArray<{ key: string; cpuSum: number; memSum: number }>): Array<{ key: string; sharePct: number; cents: number }> {
  if (!groups.length || totalCents < 0) return [];
  const cpuTotal = groups.reduce((a, g) => a + Math.max(0, g.cpuSum), 0);
  const memTotal = groups.reduce((a, g) => a + Math.max(0, g.memSum), 0);
  if (cpuTotal <= 0 && memTotal <= 0) return [];
  const weights = groups.map((g) => {
    const c = cpuTotal > 0 ? Math.max(0, g.cpuSum) / cpuTotal : 0;
    const m = memTotal > 0 ? Math.max(0, g.memSum) / memTotal : 0;
    return cpuTotal > 0 && memTotal > 0 ? (c + m) / 2 : c + m;
  });
  const exact = weights.map((w) => w * totalCents);
  const floors = exact.map((x) => Math.floor(x));
  let left = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return groups
    .map((g, i) => ({ key: g.key, sharePct: Math.round(weights[i] * 1000) / 10, cents: floors[i] }))
    .sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
}

/** Fold per-container use into groups by a key function (compose services of one app pay together). */
export function groupUse(containers: readonly ContainerUse[], keyOf: (containerName: string) => string): Array<{ key: string; cpuSum: number; memSum: number }> {
  const m = new Map<string, { key: string; cpuSum: number; memSum: number }>();
  for (const c of containers) {
    const key = keyOf(c.containerName);
    const g = m.get(key) ?? { key, cpuSum: 0, memSum: 0 };
    g.cpuSum += c.cpuSum;
    g.memSum += c.memSum;
    m.set(key, g);
  }
  return [...m.values()];
}
