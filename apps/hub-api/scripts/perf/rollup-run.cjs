#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY perf harness: run the metric rollup (1-minute + 5-minute tiers) and the retention prune against the seeded
 * database, from a compiled dist, and print how long it took and how much memory the hub process needed.
 *
 *   DATABASE_URL=... node scripts/perf/rollup-run.cjs [both|roll|prune|1m] [dist/after] [maxRuns]
 *
 *   both  roll until caught up (like the 2-minute scheduler would, repeated), then prune   (the upgrade of a seeded hub)
 *   1m    only the raw -> 1-minute step, twice (compare with the pre-SQL runner on the same window)
 * To re-create a catch-up window first: DELETE FROM "MetricRollup" / "ContainerMetricRollup" WHERE bucket > now() - interval '4 hours'.
 */
require("reflect-metadata");
const path = require("node:path");
const mode = process.argv[2] || "both";
const dist = path.resolve(process.cwd(), process.argv[3] || "dist/after");
const maxRuns = Number(process.argv[4] || 200);
const { PrismaClient } = require("@prisma/client");
const { MetricsRollupRunnerService } = require(path.join(dist, "retention/metrics-rollup-runner.service"));
const { RetentionRunnerService } = require(path.join(dist, "retention/retention-runner.service"));

(async () => {
  const prisma = new PrismaClient();
  const roll = new MetricsRollupRunnerService(prisma);
  const prune = new RetentionRunnerService(prisma, { get: () => undefined });
  let peakRss = 0, peakHeap = 0;
  const sampler = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); }, 50);
  const base = process.memoryUsage();
  const t0 = Date.now();
  const out = { mode };
  if (mode === "1m") {
    let metric = 0, containerMetric = 0;
    for (let i = 0; i < 2; i++) { metric += await roll.rollHost(); containerMetric += await roll.rollContainer(); }
    out.buckets = { metric, containerMetric };
  } else {
    if (mode !== "prune") {
      const tot = { metric: 0, containerMetric: 0, metric5m: 0, containerMetric5m: 0 };
      let runs = 0;
      for (; runs < maxRuns; runs++) {
        const r = await roll.roll();
        for (const k in tot) tot[k] += r[k];
        if (!Object.values(r).some(Boolean)) break;
      }
      out.runs = runs;
      out.buckets = tot;
    }
    out.rollMs = Date.now() - t0;
    if (mode !== "roll") { const t1 = Date.now(); out.pruned = await prune.prune(); out.pruneMs = Date.now() - t1; }
  }
  clearInterval(sampler);
  out.baseRssMB = Math.round(base.rss / 1048576);
  out.peakRssMB = Math.round(peakRss / 1048576);
  out.peakHeapMB = Math.round(peakHeap / 1048576);
  console.log(JSON.stringify(out));
  await prisma.$disconnect();
})();
