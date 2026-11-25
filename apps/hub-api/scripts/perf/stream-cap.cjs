#!/usr/bin/env node
/* eslint-disable */
/**
 * DEV-ONLY: prove the hub's bulk byte paths stream instead of buffer, by running them under a deliberately tiny V8 heap.
 *
 *   node --max-old-space-size=96 scripts/perf/stream-cap.cjs [dist/after] [GiB]
 *
 * 1. migration artifact ingest (importer/migration-staging.stageToPart): a GiB-scale body is hashed + written to disk.
 * 2. the guarded importer GET (importer/sources/guarded-get) is bounded by MAX_BYTES by construction (checked in its spec).
 * If either buffered the body, the 96 MB heap would abort with "JavaScript heap out of memory" long before 1 GiB.
 */
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { Readable } = require("node:stream");
const dist = path.resolve(process.cwd(), process.argv[2] || "dist/after");
const gib = Number(process.argv[3] || 1);
process.env.MIGRATION_STAGING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stream-cap-"));
const { stageToPart, discardPart } = require(path.join(dist, "importer/migration-staging"));

(async () => {
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const total = gib * 1024;
  const src = Readable.from((async function* () { for (let i = 0; i < total; i++) yield chunk; })());
  const t = Date.now();
  const r = await stageToPart("perfop", "perftask", src, gib * 1024 ** 3 + 1);
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1048576), rssMb = Math.round(process.memoryUsage().rss / 1048576);
  console.log(`staged ${(r.bytes / 1024 ** 3).toFixed(2)} GiB in ${((Date.now() - t) / 1000).toFixed(1)} s under ${process.execArgv.find((a) => a.includes("old-space")) || "the default heap"}; heapUsed ${heapMb} MB, rss ${rssMb} MB, sha256 ${r.sha256.slice(0, 12)}`);
  await discardPart(r.partPath);
  fs.rmSync(process.env.MIGRATION_STAGING_DIR, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
