import { ContainerMetricsService, rangeToMs, sampleEvenly, resolveContainerLabel, clampHottestLimit } from "./container-metrics.service";
import type { ContainerMetricsMsg } from "@tugra/shared";

describe("resolveContainerLabel", () => {
  const apps = new Map([["app1", "WordPress"], ["app2", "API"]]);
  const dbs = new Map([["db1", "main-pg"]]);
  it("labels a database by its name", () => {
    expect(resolveContainerLabel("tugra_db_db1", apps, dbs)).toEqual({ label: "main-pg", kind: "db", resourceId: "db1" });
  });
  it("labels a compose service as '<app> · <service>'", () => {
    expect(resolveContainerLabel("tugra_app1-wordpress-1", apps, dbs)).toMatchObject({ label: "WordPress · wordpress", kind: "app", resourceId: "app1", service: "wordpress" });
  });
  it("labels a single-container app by its name", () => {
    expect(resolveContainerLabel("tugra_app2", apps, dbs)).toMatchObject({ label: "API", kind: "app", resourceId: "app2" });
  });
  it("strips the noise from Tugra's own stack containers", () => {
    expect(resolveContainerLabel("tugra-hub-api-1", apps, dbs)).toEqual({ label: "hub-api", kind: "system" });
  });
  it("leaves a foreign container name as-is", () => {
    expect(resolveContainerLabel("some-other-container", apps, dbs)).toEqual({ label: "some-other-container", kind: "other" });
  });
  it("names a foreign (Coolify) container from its labels and carries project/environment", () => {
    const labels = { name: "kgr3jx23x9ck5w2h8n7p4q1z-123", resource: "Blog", project: "Acme Site", environment: "production", service: "" };
    expect(resolveContainerLabel("kgr3jx23x9ck5w2h8n7p4q1z-123", apps, dbs, labels)).toEqual({
      label: "Blog", kind: "other", project: "Acme Site", environment: "production",
    });
  });
  it("keeps the raw name when the labels are all opaque, and never overrides a Tugra-managed container", () => {
    const opaque = { name: "kgr3jx23x9ck5w2h8n7p4q1z", resource: "", project: "Acme", environment: "", service: "" };
    expect(resolveContainerLabel("kgr3jx23x9ck5w2h8n7p4q1z-9", apps, dbs, opaque)).toEqual({ label: "kgr3jx23x9ck5w2h8n7p4q1z-9", kind: "other" });
    expect(resolveContainerLabel("tugra_app2", apps, dbs, { ...opaque, resource: "Impostor" })).toMatchObject({ label: "API", kind: "app" });
  });
  it("falls back to the stripped id with no resourceId when the db is unknown", () => {
    expect(resolveContainerLabel("tugra_db_gone", apps, dbs)).toEqual({ label: "gone", kind: "db" });
  });
});

describe("rangeToMs", () => {
  it("maps known ranges to a lookback window", () => {
    // Freeze the clock: a slow CI runner must not turn the elapsed milliseconds into a failure.
    const base = 1_800_000_000_000;
    const now = jest.spyOn(Date, "now").mockReturnValue(base);
    try {
      expect(base - rangeToMs("1h").sinceMs).toBe(3600_000);
      expect(base - rangeToMs("6h").sinceMs).toBe(6 * 3600_000);
      expect(rangeToMs("24h").range).toBe("24h");
    } finally {
      now.mockRestore();
    }
  });
  it("falls back to 1h for an unknown/missing range (no injection of arbitrary windows)", () => {
    expect(rangeToMs(undefined).range).toBe("1h");
    expect(rangeToMs("'; DROP" as string).range).toBe("1h");
    expect(rangeToMs("90d").range).toBe("1h"); // beyond rollup retention → clamped
  });
  it("maps the serving tier by window: container raw is 6 h, 24h reads the 1-minute rollups, 7d/30d the 5-minute rollups", () => {
    expect(rangeToMs("1h", "container").tier).toBe("raw");
    expect(rangeToMs("6h", "container").tier).toBe("raw"); // exactly the container raw retention
    expect(rangeToMs("24h", "container").tier).toBe("1m");
    expect(rangeToMs("7d", "container").tier).toBe("5m");
    expect(rangeToMs("7d", "container").useRollup).toBe(true);
    expect(rangeToMs("6h", "container").useRollup).toBe(false);
  });
  it("host raw is kept longer (26 h): 24h is still raw, 7d reads the 5-minute rollups", () => {
    expect(rangeToMs("24h", "host").tier).toBe("raw");
    expect(rangeToMs("7d").tier).toBe("5m"); // `host` is the default kind
  });
  it("unlocks 30d: it maps to a 30-day window that reads the 5-minute ROLLUPS (like 7d)", () => {
    const base = Date.now();
    const r = rangeToMs("30d");
    expect(r.range).toBe("30d");
    expect(r.useRollup).toBe(true);
    expect(base - r.sinceMs).toBeGreaterThanOrEqual(30 * 86_400_000 - 50);
  });
  it("rejects Object.prototype keys (own-property check, not `in`) → never a NaN window", () => {
    for (const k of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
      const r = rangeToMs(k);
      expect(r.range).toBe("1h");
      expect(Number.isFinite(r.sinceMs)).toBe(true); // not NaN → no `new Date(NaN)` → no Prisma 500
      expect(r.useRollup).toBe(false);
    }
  });
});

describe("sampleEvenly", () => {
  it("returns the series unchanged when at or below the cap", () => {
    const a = [1, 2, 3];
    expect(sampleEvenly(a, 5)).toBe(a);
  });
  it("down-samples above the cap, keeping first and last", () => {
    const a = Array.from({ length: 1000 }, (_, i) => i);
    const out = sampleEvenly(a, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(999);
    // monotonic (evenly spaced, non-decreasing)
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });
});

describe("ContainerMetricsService", () => {
  function make(historyRows: unknown[] = [], rollupRows: unknown[] = [], stateFindMany?: jest.Mock, liveRows: unknown[] = []) {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      // forServer reads its live inventory through one DISTINCT ON query (newest sample per container, done in SQL).
      // History reads (forApp) are ONE strided raw query per table; the live inventory (forServer) a DISTINCT ON one.
      $queryRaw: jest.fn(async (q: { sql: string; values: unknown[] }) => (/FROM "ContainerMetricRollup/.test(q.sql) ? rollupRows : /FROM "ContainerMetric" WHERE/.test(q.sql) ? historyRows : liveRows)),
      containerMetric: { createMany, findMany: jest.fn().mockResolvedValue([]) },
      containerMetricRollup: { findMany: jest.fn().mockResolvedValue([]) },
      // forServer joins apps + databases to build friendly container labels, and ContainerState for crash badges.
      application: { findMany: jest.fn().mockResolvedValue([]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
      containerState: { findMany: stateFindMany ?? jest.fn().mockResolvedValue([]) },
      containerLabel: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    } as any;
    const svc = new ContainerMetricsService(prisma);
    // Ingest is buffered (flushed every 5 s in production): flush after each call so the row-shape tests below
    // read the multi-row INSERT the way the timer would write it. The buffering itself has its own tests.
    const ingest = svc.ingest.bind(svc);
    svc.ingest = async (...args: Parameters<ContainerMetricsService["ingest"]>) => {
      await ingest(...args);
      await svc.flush();
    };
    return {
      svc,
      prisma,
      createMany,
      findMany: prisma.containerMetric.findMany,
      queryRaw: prisma.$queryRaw as jest.Mock,
      rollupFindMany: prisma.containerMetricRollup.findMany,
      stateFindMany: prisma.containerState.findMany,
    };
  }

  function row(over: Partial<Record<string, unknown>> = {}) {
    return {
      containerName: "tugra_app1",
      ts: new Date(1_700_000_000_000),
      cpu: 1.5,
      memUsed: 100n,
      memTotal: 200n,
      memPct: 50,
      netRx: 10n,
      netTx: 20n,
      blkRead: 0n,
      blkWrite: 5n,
      ...over,
    };
  }

  function rollupRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      containerName: "tugra_app1",
      bucket: new Date(1_700_000_000_000),
      avgCpu: 2.5,
      maxCpu: 9,
      avgMemUsed: 100n,
      avgMemTotal: 200n,
      avgMemPct: 40,
      avgNetRx: 10n,
      avgNetTx: 20n,
      avgBlkRead: 1n,
      avgBlkWrite: 5n,
      ...over,
    };
  }

  const sqlOf = (queryRaw: jest.Mock, i = 0) => queryRaw.mock.calls[i][0] as { sql: string; values: unknown[] };

  it("forApp: within-retention range (≤24h) reads RAW rows — prefix match, groups by container, widens BigInt→Number + ts", async () => {
    const { svc, queryRaw, findMany, rollupFindMany } = make([
      row({ containerName: "tugra_app1", netRx: 10n }),
      row({ containerName: "tugra_app1-web-1", netRx: 999n }),
      row({ containerName: "tugra_app1", netRx: 11n }),
    ]);
    const out = await svc.forApp("s1", "tugra_app1", "1h");
    // ONE strided raw query on the raw table; the rollup table and the unbounded findMany are not touched
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
    expect(rollupFindMany).not.toHaveBeenCalled();
    const q = sqlOf(queryRaw);
    expect(q.sql).toMatch(/FROM "ContainerMetric" WHERE "serverId" = ANY\(\?::text\[\]\) AND "ts" >= \?/);
    expect(q.sql).toMatch(/PARTITION BY "containerName" ORDER BY "ts"/); // each container is its own strided series
    expect(q.values[0]).toEqual(["s1"]);
    // exact OR starts_with `${prefix}-` (starts_with: `_` in an id is not a LIKE wildcard)
    expect(q.sql).toMatch(/"containerName" = \? OR starts_with\("containerName", \?\)\)/);
    expect(q.values.slice(2, -1)).toEqual(["tugra_app1", "tugra_app1-"]);
    // grouped by name, sorted
    expect(out.containers.map((c) => c.name)).toEqual(["tugra_app1", "tugra_app1-web-1"]);
    const main = out.containers[0];
    expect(main.samples).toHaveLength(2);
    expect(main.samples[0].netRx).toBe(10); // BigInt → Number
    expect(main.samples[0].ts).toBe(1_700_000_000_000); // Date → unix ms
    expect(typeof main.samples[0].memUsed).toBe("number");
  });

  it("forApp: 24h is past the 6 h container raw retention → the 1-minute rollup table", async () => {
    const { svc, queryRaw } = make([], [rollupRow({ containerName: "tugra_app1", avgCpu: 4 })]);
    const out = await svc.forApp("s1", "tugra_app1", "24h");
    expect(sqlOf(queryRaw).sql).toMatch(/FROM "ContainerMetricRollup" WHERE/);
    expect(out.containers[0].samples[0].cpu).toBe(4);
  });

  it("forApp: 6h is still within the container raw retention → the raw table", async () => {
    const { svc, queryRaw } = make([row({})]);
    await svc.forApp("s1", "tugra_app1", "6h");
    expect(sqlOf(queryRaw).sql).toMatch(/FROM "ContainerMetric" WHERE/);
  });

  it("forApp: beyond-retention range (7d) reads the 5-MINUTE ROLLUPS — maps avg*→field, bucket→ts, prefix match", async () => {
    const { svc, queryRaw } = make(
      [],
      [
        rollupRow({ containerName: "tugra_app1", avgCpu: 2.5, avgNetRx: 10n }),
        rollupRow({ containerName: "tugra_app1-web-1", avgCpu: 7 }),
      ],
    );
    const out = await svc.forApp("s1", "tugra_app1", "7d");
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const q = sqlOf(queryRaw);
    expect(q.sql).toMatch(/FROM "ContainerMetricRollup5m" WHERE "serverId" = ANY\(\?::text\[\]\) AND "bucket" >= \?/);
    expect(q.sql).toMatch(/PARTITION BY "containerName" ORDER BY "bucket"/);
    expect(q.values[0]).toEqual(["s1"]);
    expect(out.containers.map((c) => c.name)).toEqual(["tugra_app1", "tugra_app1-web-1"]);
    const main = out.containers[0];
    expect(main.samples[0].cpu).toBe(2.5); // avgCpu → cpu
    expect(main.samples[0].memPct).toBe(40); // avgMemPct → memPct
    expect(main.samples[0].netRx).toBe(10); // BigInt → Number
    expect(main.samples[0].ts).toBe(1_700_000_000_000); // bucket → unix ms
  });

  it("forApp: rollup read RETURNS the stored per-bucket peak (maxCpu → cpuMax) next to the average; raw reads omit it", async () => {
    const { svc, queryRaw } = make([], [rollupRow({ containerName: "tugra_app1", avgCpu: 2.5, maxCpu: 88 })]);
    const long = await svc.forApp("s1", "tugra_app1", "30d");
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(long.containers[0].samples[0]).toMatchObject({ cpu: 2.5, cpuMax: 88 });
    const { svc: rawSvc } = make([row({})]);
    const raw = await rawSvc.forApp("s1", "tugra_app1", "1h");
    expect(raw.containers[0].samples[0]).not.toHaveProperty("cpuMax");
  });

  it("forApp: down-samples a huge per-container series to the LTTB cap (1000)", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row({ ts: new Date(1_700_000_000_000 + i * 1000) }));
    const { svc } = make(rows);
    const out = await svc.forApp("s1", "tugra_app1", "1h");
    expect(out.containers[0].samples).toHaveLength(1000);
    // LTTB keeps the endpoints
    expect(out.containers[0].samples[0].ts).toBe(1_700_000_000_000);
    expect(out.containers[0].samples[999].ts).toBe(1_700_000_000_000 + 1199 * 1000);
  });

  it("forApp (swarm): queries ALL member serverIds + matches the `.` task suffix, airtight against sibling ids", async () => {
    const { svc, queryRaw } = make([
      row({ containerName: "tugra_app1.1.aaa" }),
      row({ containerName: "tugra_app1.2.bbb" }),
    ]);
    const out = await svc.forApp(["m1", "m2"], "tugra_app1", "1h", true);
    const q = sqlOf(queryRaw);
    expect(q.values[0]).toEqual(["m1", "m2"]); // all cluster members, not one
    // the `.` suffix (not a bare prefix) keeps it airtight vs a sibling app tugra_app1x / tugra_app1234
    expect(q.sql).toMatch(/OR starts_with\("containerName", \?\)/);
    expect(q.values.slice(2, -1)).toEqual(["tugra_app1", "tugra_app1-", "tugra_app1."]);
    expect(out.containers.map((c) => c.name).sort()).toEqual(["tugra_app1.1.aaa", "tugra_app1.2.bbb"]); // one series per task
  });

  it("forApp (classic, non-swarm) is unchanged: single serverId, no `.` match branch", async () => {
    const { svc, queryRaw } = make();
    await svc.forApp("s1", "tugra_app1", "1h");
    const q = sqlOf(queryRaw);
    expect(q.values[0]).toEqual(["s1"]);
    expect(q.values.slice(2, -1)).toEqual(["tugra_app1", "tugra_app1-"]);
  });

  it("forServer: latest sample per container (all containers, live 90s window), sorted by name", async () => {
    const now = 1_700_000_000_000;
    // The database returns the newest sample per container (DISTINCT ON); the service labels + sorts them.
    const { svc, queryRaw, findMany } = make(undefined, undefined, undefined, [
      row({ containerName: "web", containerId: "new", cpu: 5, ts: new Date(now + 1000) }),
      row({ containerName: "db", containerId: "db1", cpu: 9, ts: new Date(now + 500) }),
    ]);
    const out = await svc.forServer("s1");
    // ONE query, scoped to this server + the 90 s live window, never the raw-sample findMany
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0][0];
    expect(sql.sql).toMatch(/DISTINCT ON \("serverId", "containerName"\)/);
    expect(sql.values[0]).toEqual(["s1"]);
    expect(sql.values[1]).toBeInstanceOf(Date);
    expect(findMany).not.toHaveBeenCalled();
    // one row per container, sorted by name
    expect(out.containers.map((c) => c.name)).toEqual(["db", "web"]);
    const web = out.containers.find((c) => c.name === "web")!;
    expect(web.cpu).toBe(5);
    expect(web.containerId).toBe("new");
    expect(typeof web.netRx).toBe("number"); // BigInt → Number
  });

  it("forServer: empty server → no containers", async () => {
    const { svc } = make();
    expect(await svc.forServer("s1")).toEqual({ containers: [] });
  });

  it("forServer: enriches rows with ContainerState crash/health (restart count, health, ISO finishedAt); unseen container stays bare", async () => {
    const now = 1_700_000_000_000;
    const live = [
      row({ containerName: "web", containerId: "w1", ts: new Date(now) }),
      row({ containerName: "lonely", containerId: "l1", ts: new Date(now) }), // no ContainerState row
    ];
    const stateFindMany = jest.fn().mockResolvedValue([
      { containerName: "web", exitCode: 137, oomKilled: true, restartCount: 12, health: "unhealthy", finishedAt: new Date(now) },
    ]);
    const { svc } = make(undefined, undefined, stateFindMany, live);
    const out = await svc.forServer("s1");
    expect(stateFindMany.mock.calls[0][0].where).toEqual({ serverId: "s1" });
    const web = out.containers.find((c) => c.name === "web")!;
    expect(web).toMatchObject({ restartCount: 12, exitCode: 137, oomKilled: true, health: "unhealthy" });
    expect(web.finishedAt).toBe(new Date(now).toISOString());
    const lonely = out.containers.find((c) => c.name === "lonely")!;
    expect(lonely.restartCount).toBeUndefined();
    expect(lonely.exitCode).toBeUndefined();
  });

  it("maps samples to rows (name→containerName, id→containerId, BigInt-rounded byte fields)", async () => {
    const { svc, createMany } = make();
    const msg: ContainerMetricsMsg = {
      type: "container_metrics",
      ts: 1_700_000_000_000,
      samples: [
        { id: "abc123", name: "web", cpu: 0.15, memUsed: 11_010_048.6, memTotal: 2_040_109_465, memPct: 0.55, netRx: 2000.4, netTx: 0, blkRead: 0, blkWrite: 4000.9 },
      ],
    };
    await svc.ingest("s1", msg);
    expect(createMany).toHaveBeenCalledTimes(1);
    const { data } = createMany.mock.calls[0][0];
    expect(data).toHaveLength(1);
    const row = data[0];
    expect(row.serverId).toBe("s1");
    expect(row.containerName).toBe("web"); // stable key
    expect(row.containerId).toBe("abc123");
    expect(row.ts).toEqual(new Date(1_700_000_000_000)); // agent-supplied timestamp
    expect(row.cpu).toBe(0.15);
    expect(row.memPct).toBe(0.55);
    expect(row.memUsed).toBe(BigInt(11_010_049)); // rounded
    expect(row.netRx).toBe(BigInt(2000)); // rounded
    expect(row.blkWrite).toBe(BigInt(4001)); // rounded
  });

  it("stores allow-listed labels once, rewrites only on change, and survives a label failure", async () => {
    const { svc, prisma, createMany } = make();
    const msg = (project: string) => ({
      type: "container_metrics" as const,
      ts: 1_700_000_000_000,
      samples: [{ id: "c1", name: "web", cpu: 1, memUsed: 1, memTotal: 2, memPct: 50, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, meta: { resource: "Blog", project } }],
    });
    await svc.ingest("s1", msg("Acme"));
    await svc.ingest("s1", msg("Acme")); // unchanged → no second write
    expect(prisma.containerLabel.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.containerLabel.upsert.mock.calls[0][0]).toMatchObject({
      where: { serverId_containerName: { serverId: "s1", containerName: "web" } },
      create: { serverId: "s1", containerName: "web", resource: "Blog", project: "Acme" },
    });
    await svc.ingest("s1", msg("Other")); // changed → rewritten
    expect(prisma.containerLabel.upsert).toHaveBeenCalledTimes(2);
    // a failing label write must not fail the already-stored metrics batch
    prisma.containerLabel.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.ingest("s1", msg("Third"))).resolves.toBeUndefined();
    expect(createMany).toHaveBeenCalledTimes(4);
  });

  it("ignores samples without usable meta and prunes stale label rows at most hourly", async () => {
    const { svc, prisma } = make();
    const plain = { type: "container_metrics" as const, ts: 1, samples: [{ id: "c", name: "web", cpu: 0, memUsed: 0, memTotal: 0, memPct: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 }] };
    await svc.ingest("s1", plain);
    await svc.ingest("s1", plain);
    expect(prisma.containerLabel.upsert).not.toHaveBeenCalled();
    expect(prisma.containerLabel.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.containerLabel.deleteMany.mock.calls[0][0].where.updatedAt.lt).toBeInstanceOf(Date);
  });

  it("buffers container samples: many messages cost one multi-row INSERT at flush", async () => {
    const { prisma, createMany } = make();
    const raw = new ContainerMetricsService(prisma); // un-wrapped: the real buffered path
    const msg = (ts: number) => ({
      type: "container_metrics" as const,
      ts,
      samples: Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, name: `ctr${i}`, cpu: 1, memUsed: 1, memTotal: 2, memPct: 50, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 })),
    });
    for (let s = 0; s < 5; s++) await raw.ingest(`s${s}`, msg(1_700_000_000_000 + s));
    expect(createMany).not.toHaveBeenCalled();
    await raw.flush();
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany.mock.calls[0][0].data).toHaveLength(85);
    expect(raw.ingestStats()).toMatchObject({ buffered: 0, flushed: 85 });
  });

  it("flushes on shutdown through the pre-disconnect hook; a later straggler is written directly", async () => {
    const { prisma, createMany } = make();
    const hooks: (() => Promise<void>)[] = [];
    prisma.registerBeforeDisconnect = (fn: () => Promise<void>) => hooks.push(fn);
    const raw = new ContainerMetricsService(prisma);
    raw.onModuleInit();
    const msg = { type: "container_metrics" as const, ts: 1, samples: [{ id: "c", name: "web", cpu: 0, memUsed: 0, memTotal: 0, memPct: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 }] };
    await raw.ingest("s1", msg);
    await hooks[0]();
    expect(createMany).toHaveBeenCalledTimes(1);
    await raw.ingest("s1", msg);
    expect(createMany).toHaveBeenCalledTimes(2);
  });

  it("no-ops on an empty batch (no createMany call)", async () => {
    const { svc, createMany } = make();
    await svc.ingest("s1", { type: "container_metrics", ts: 1, samples: [] });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("no-ops when samples is missing", async () => {
    const { svc, createMany } = make();
    await svc.ingest("s1", { type: "container_metrics", ts: 1 } as any);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("clamps non-finite numbers to 0 instead of throwing (RangeError from BigInt(Infinity))", async () => {
    const { svc, createMany } = make();
    const msg: ContainerMetricsMsg = {
      type: "container_metrics",
      ts: 1,
      // A compromised agent: JSON.parse turns 1e400 into Infinity; BigInt(Math.round(Infinity)) throws.
      samples: [
        { id: "x", name: "bad", cpu: Infinity, memUsed: Infinity, memTotal: NaN, memPct: -Infinity, netRx: Infinity, netTx: NaN, blkRead: Infinity, blkWrite: NaN },
      ],
    };
    await expect(svc.ingest("s1", msg)).resolves.toBeUndefined(); // does NOT throw
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.cpu).toBe(0);
    expect(row.memPct).toBe(0);
    expect(row.memUsed).toBe(0n);
    expect(row.memTotal).toBe(0n);
    expect(row.netRx).toBe(0n);
    expect(row.blkWrite).toBe(0n);
  });
});

describe("clampHottestLimit", () => {
  it("defaults to 10 for missing / non-finite and clamps to 1..50", () => {
    expect(clampHottestLimit(undefined)).toBe(10);
    expect(clampHottestLimit(NaN)).toBe(10);
    expect(clampHottestLimit(0)).toBe(1);
    expect(clampHottestLimit(-5)).toBe(1);
    expect(clampHottestLimit(7.9)).toBe(7);
    expect(clampHottestLimit(9999)).toBe(50);
  });
});

describe("ContainerMetricsService.hottest", () => {
  const NOW = 1_700_000_000_000;
  beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  const servers = [{ id: "s1", name: "alpha" }, { id: "s2", name: "beta" }];
  const r = (over: Record<string, unknown>) => ({
    serverId: "s1",
    containerName: "web",
    containerId: "c",
    ts: new Date(NOW - 5_000),
    cpu: 1,
    memUsed: 100n,
    memTotal: 200n,
    memPct: 50,
    netRx: 1n,
    netTx: 2n,
    blkRead: 3n,
    blkWrite: 4n,
    ...over,
  });
  // The ranking itself (newest per container, cpu desc, LIMIT) is SQL — covered against a real database in
  // test/fleet-metrics.e2e-spec.ts. Here: the query shape and the labelling of what it returns.
  function make(rows: unknown[]) {
    const queryRaw = jest.fn().mockResolvedValue(rows);
    const prisma = {
      $queryRaw: queryRaw,
      containerMetric: { findMany: jest.fn() },
      application: { findMany: jest.fn().mockResolvedValue([{ id: "app1", name: "WordPress" }]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
      containerLabel: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    return { svc: new ContainerMetricsService(prisma), queryRaw, prisma };
  }

  it("queries ONCE in SQL, scoped to the given server ids, the 90s live window and the clamped LIMIT", async () => {
    const { svc, queryRaw, prisma } = make([r({})]);
    await svc.hottest(servers, 7);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const q = queryRaw.mock.calls[0][0];
    expect(q.sql).toMatch(/DISTINCT ON \("serverId", "containerName"\)/);
    expect(q.sql).toMatch(/ORDER BY "cpu" DESC, "containerName" ASC\s+LIMIT/);
    expect(q.values[0]).toEqual(["s1", "s2"]);
    expect((q.values[1] as Date).getTime()).toBe(NOW - 90_000);
    expect(q.values[2]).toBe(7);
    expect(prisma.containerMetric.findMany).not.toHaveBeenCalled(); // never materialises the raw live set in JS
    expect(prisma.application.findMany.mock.calls[0][0].where.serverId).toEqual({ in: ["s1"] }); // only servers that made the top list
  });

  it("clamps the limit (0 → 1, missing → default 10, huge → 50)", async () => {
    const { svc, queryRaw } = make([]);
    await svc.hottest(servers, 0);
    await svc.hottest(servers);
    await svc.hottest(servers, 9999);
    expect(queryRaw.mock.calls.map((c) => c[0].values[2])).toEqual([1, 10, 50]);
  });

  it("returns [] without touching the DB when there are no visible servers", async () => {
    const { svc, queryRaw } = make([]);
    expect(await svc.hottest([])).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("keeps the database's ranking, labels each row and widens BigInt", async () => {
    const { svc } = make([
      r({ serverId: "s2", containerName: "web", cpu: 60 }),
      r({ containerName: "tugra_app1", cpu: 40, memUsed: 123456789012n }),
      r({ containerName: "web", cpu: 10 }),
    ]);
    const out = await svc.hottest(servers);
    expect(out.map((x) => [x.serverName, x.containerName, x.cpu])).toEqual([
      ["beta", "web", 60],
      ["alpha", "tugra_app1", 40],
      ["alpha", "web", 10],
    ]);
    expect(out[1]).toMatchObject({ label: "WordPress", kind: "app", resourceId: "app1", memUsed: 123456789012, netRx: 1, blkWrite: 4 });
    expect(JSON.stringify(out)).toContain("123456789012"); // no BigInt left → serializes
  });

  it("names a foreign container from its stored labels, scoped to the returned rows", async () => {
    const { svc, prisma } = make([r({ containerName: "kgr3jx23x9ck5w2h8n7p4q1z-123", cpu: 80 })]);
    prisma.containerLabel.findMany.mockResolvedValue([
      { serverId: "s1", containerName: "kgr3jx23x9ck5w2h8n7p4q1z-123", name: "kgr3jx23x9ck5w2h8n7p4q1z-123", resource: "Blog", project: "Acme Site", environment: "production", service: "" },
    ]);
    const out = await svc.hottest(servers);
    expect(prisma.containerLabel.findMany.mock.calls[0][0].where).toEqual({ serverId: { in: ["s1"] }, containerName: { in: ["kgr3jx23x9ck5w2h8n7p4q1z-123"] } });
    expect(out[0]).toMatchObject({ label: "Blog", kind: "other", project: "Acme Site", environment: "production" });
  });
});
