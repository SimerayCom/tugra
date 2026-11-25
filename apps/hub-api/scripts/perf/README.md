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
