# Hub memory load harness (dev only)

Not shipped: `apps/hub-api/scripts` is outside the TypeScript `include` and the hub image copies `dist/` only.

1. A scratch Postgres (any free port, timezone UTC) and Redis, then `DATABASE_URL=... npx prisma migrate deploy`.
2. `DATABASE_URL=... node scripts/perf/seed.cjs` seeds 27 servers x 17 containers: 48 h of raw samples (host every 5 s,
   containers every 15 s) and 14 days of 1-minute rollups (~16 M rows, ~5 GB, a few minutes). Before every later run:
   `node scripts/perf/seed.cjs --touch` fills the gap up to now so the live windows have data.
3. `npx tsc -p tsconfig.build.json --outDir dist/<label>` for each build to compare (e.g. `before`, `after`).
4. Boot the real hub with an in-process fake agent: `DIST=dist/<label> PORT=3100 node --expose-gc scripts/perf/hub-boot.cjs`
   (needs the usual env: `DATABASE_URL REDIS_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET SECRETS_ENCRYPTION_KEY`, `NODE_ENV=test`,
   `THROTTLE_LIMIT=1000000`). Heap numbers / forced GC / heap snapshots are on `127.0.0.1:PORT+1` (`/`, `/gc`, `/snapshot`).
5. `node scripts/perf/load.cjs --port 3100 --pid <hub pid> --label <label> --phases home,server,scan,logs,slowlog,soak --browsers 6 --seconds 25 --out result.json`
   drives the endpoints the way the web app polls them and prints RSS before / peak / after GC per phase plus per-endpoint latency.
   `--phases url:/servers/perf-srv-3/metrics?range=24h` hammers a single endpoint to find which call allocates.
6. `node scripts/perf/seed.cjs --apps` (after the main seed) adds 81 applications and 27 databases whose containers
   (`tugra_<appId>`, `tugra_db_<dbId>`) carry the same 48 h raw + 14 day rollup history, so `--phases apps` can drive the
   app and database Metrics tabs at every range. Re-run `--touch` afterwards.
7. `node --max-old-space-size=96 scripts/perf/stream-cap.cjs dist/after 1` streams 1 GiB through the migration-artifact
   ingest path (`stageToPart`) under a 96 MB heap: it only passes if the path never buffers the body.
8. Run the boot step with `--max-old-space-size=768` (the shipped default) to confirm a phase fits under the production cap.
9. Metric rollups + retention: `node scripts/perf/rollup-run.cjs both dist/after` rolls the 1-minute and 5-minute tiers until caught up and then
   prunes (the upgrade of a seeded hub; `1m` times only the raw -> 1-minute step), printing time and peak RSS / heap. Table rows and sizes:
   `SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) FROM pg_class WHERE relname ~ '^(Container)?Metric(Rollup(5m)?)?$'` (add
   `VACUUM FULL` on those tables first to see the steady-state size rather than the not-yet-returned dead space).
9. Polling load (group 13): `--phases idle,poll,home --browsers 6|12 --seconds 45` measures requests that reach Postgres.
   `poll` drives only what the panel polls on /fleet + /dashboard (servers, fleet latest / trend / hottest, insights) at the
   real 5 s cadence; `home` adds the one-shot /costs calls. Browsers start at a random point of their cycle (`--jitter ms`,
   0 = lock-step, which flatters any request coalescing). With `DATABASE_URL` set and `create extension pg_stat_statements`
   (`shared_preload_libraries = 'pg_stat_statements'`), every phase prints `db statements/s` (`--pgstat 0` turns it off).
9. Agent-telemetry ingest cost (DB statements/s, hub CPU / RSS): run `hub-boot.cjs` with `FAKE_TELEMETRY_SERVERS=27 FAKE_TELEMETRY_CONTAINERS=17`
   (or `50` / `20`). `fake-telemetry.cjs` then drives the hub's real message handler with `metrics` + `heartbeat` every 5 s and
   `container_metrics` every 15 s per server (the agent's real cadence), registers fake authed sockets, and runs the container-health
   poll every 60 s over the same containers (NODE_ENV=test turns the BullMQ schedulers off). A scratch Postgres with
   `shared_preload_libraries = 'pg_stat_statements'` is needed; then
   `DATABASE_URL=... node scripts/perf/ingest-measure.cjs --port 3100 --pid <hub pid> --label after --warmup 45 --seconds 150 --out r.json`
   prints client statements/s by shape (Postgres' own per-row foreign-key probes are reported separately), tuples inserted/updated per
   table, and the hub's RSS and CPU % of one core. `seed.cjs --raw-hours 1 --rollup-days 1` is enough history for this.
