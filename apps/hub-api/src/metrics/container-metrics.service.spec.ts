import { ContainerMetricsService, rangeToMs, sampleEvenly, resolveContainerLabel } from "./container-metrics.service";
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
  it("falls back to the stripped id when the db is unknown", () => {
    expect(resolveContainerLabel("tugra_db_gone", apps, dbs)).toEqual({ label: "gone", kind: "db", resourceId: "gone" });
  });
});

describe("rangeToMs", () => {
  it("maps known ranges to a lookback window", () => {
    const base = Date.now();
    expect(base - rangeToMs("1h").sinceMs).toBeGreaterThanOrEqual(3600_000 - 50);
    expect(base - rangeToMs("6h").sinceMs).toBeGreaterThanOrEqual(6 * 3600_000 - 50);
    expect(rangeToMs("24h").range).toBe("24h");
  });
  it("falls back to 1h for an unknown/missing range (no injection of arbitrary windows)", () => {
    expect(rangeToMs(undefined).range).toBe("1h");
    expect(rangeToMs("'; DROP" as string).range).toBe("1h");
    expect(rangeToMs("30d").range).toBe("1h"); // beyond rollup retention → clamped
  });
  it("maps useRollup by window: within raw retention (≤24h) reads raw, only 7d reads rollups", () => {
    expect(rangeToMs("1h").useRollup).toBe(false);
    expect(rangeToMs("6h").useRollup).toBe(false); // still within 48h raw retention → full fidelity
    expect(rangeToMs("24h").useRollup).toBe(false); // ditto — spikes preserved from raw
    expect(rangeToMs("7d").range).toBe("7d");
    expect(rangeToMs("7d").useRollup).toBe(true); // exceeds raw retention → rollup
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
  function make(findMany?: jest.Mock, rollupFindMany?: jest.Mock) {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      containerMetric: { createMany, findMany: findMany ?? jest.fn().mockResolvedValue([]) },
      containerMetricRollup: { findMany: rollupFindMany ?? jest.fn().mockResolvedValue([]) },
      // forServer joins apps + databases to build friendly container labels.
      application: { findMany: jest.fn().mockResolvedValue([]) },
      database: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    return {
      svc: new ContainerMetricsService(prisma),
      createMany,
      findMany: prisma.containerMetric.findMany,
      rollupFindMany: prisma.containerMetricRollup.findMany,
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

  it("forApp: within-retention range (≤24h) reads RAW rows — prefix match, groups by container, widens BigInt→Number + ts", async () => {
    const findMany = jest.fn().mockResolvedValue([
      row({ containerName: "tugra_app1", netRx: 10n }),
      row({ containerName: "tugra_app1-web-1", netRx: 999n }),
      row({ containerName: "tugra_app1", netRx: 11n }),
    ]);
    const { svc, rollupFindMany } = make(findMany);
    const out = await svc.forApp("s1", "tugra_app1", "1h");
    // raw path used, rollup NOT touched
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(rollupFindMany).not.toHaveBeenCalled();
    // where clause: exact OR startsWith `${prefix}-`
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.OR).toEqual([{ containerName: "tugra_app1" }, { containerName: { startsWith: "tugra_app1-" } }]);
    // grouped by name, sorted
    expect(out.containers.map((c) => c.name)).toEqual(["tugra_app1", "tugra_app1-web-1"]);
    const main = out.containers[0];
    expect(main.samples).toHaveLength(2);
    expect(main.samples[0].netRx).toBe(10); // BigInt → Number
    expect(main.samples[0].ts).toBe(1_700_000_000_000); // Date → unix ms
    expect(typeof main.samples[0].memUsed).toBe("number");
  });

  it("forApp: beyond-retention range (7d) reads ROLLUPS — maps avg*→field, bucket→ts, prefix match", async () => {
    const rollupFindMany = jest.fn().mockResolvedValue([
      rollupRow({ containerName: "tugra_app1", avgCpu: 2.5, avgNetRx: 10n }),
      rollupRow({ containerName: "tugra_app1-web-1", avgCpu: 7 }),
    ]);
    const { svc, findMany } = make(undefined, rollupFindMany);
    const out = await svc.forApp("s1", "tugra_app1", "7d");
    // rollup path used, raw NOT touched
    expect(rollupFindMany).toHaveBeenCalledTimes(1);
    expect(findMany).not.toHaveBeenCalled();
    const where = rollupFindMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.bucket.gte).toBeInstanceOf(Date);
    expect(where.OR).toEqual([{ containerName: "tugra_app1" }, { containerName: { startsWith: "tugra_app1-" } }]);
    expect(out.containers.map((c) => c.name)).toEqual(["tugra_app1", "tugra_app1-web-1"]);
    const main = out.containers[0];
    expect(main.samples[0].cpu).toBe(2.5); // avgCpu → cpu
    expect(main.samples[0].memPct).toBe(40); // avgMemPct → memPct
    expect(main.samples[0].netRx).toBe(10); // BigInt → Number
    expect(main.samples[0].ts).toBe(1_700_000_000_000); // bucket → unix ms
  });

  it("forApp: down-samples a huge per-container series to the LTTB cap (1000)", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row({ ts: new Date(1_700_000_000_000 + i * 1000) }));
    const { svc } = make(jest.fn().mockResolvedValue(rows));
    const out = await svc.forApp("s1", "tugra_app1", "1h");
    expect(out.containers[0].samples).toHaveLength(1000);
    // LTTB keeps the endpoints
    expect(out.containers[0].samples[0].ts).toBe(1_700_000_000_000);
    expect(out.containers[0].samples[999].ts).toBe(1_700_000_000_000 + 1199 * 1000);
  });

  it("forApp (swarm): queries ALL member serverIds + matches the `.` task suffix, airtight against sibling ids", async () => {
    const findMany = jest.fn().mockResolvedValue([
      row({ containerName: "tugra_app1.1.aaa" }),
      row({ containerName: "tugra_app1.2.bbb" }),
    ]);
    const { svc } = make(findMany);
    const out = await svc.forApp(["m1", "m2"], "tugra_app1", "1h", true);
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toEqual({ in: ["m1", "m2"] }); // all cluster members, not one
    // the `.` suffix (not a bare startsWith) keeps it airtight vs a sibling app tugra_app1x / tugra_app1234
    expect(where.OR).toContainEqual({ containerName: { startsWith: "tugra_app1." } });
    expect(out.containers.map((c) => c.name).sort()).toEqual(["tugra_app1.1.aaa", "tugra_app1.2.bbb"]); // one series per task
  });

  it("forApp (classic, non-swarm) is unchanged: single serverId, no `.` match branch", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { svc } = make(findMany);
    await svc.forApp("s1", "tugra_app1", "1h");
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.OR).toEqual([{ containerName: "tugra_app1" }, { containerName: { startsWith: "tugra_app1-" } }]);
  });

  it("forServer: latest sample per container (all containers, live 90s window), sorted by name", async () => {
    const now = 1_700_000_000_000;
    const findMany = jest.fn().mockResolvedValue([
      row({ containerName: "web", containerId: "old", cpu: 1, ts: new Date(now) }),
      row({ containerName: "db", containerId: "db1", cpu: 9, ts: new Date(now + 500) }),
      row({ containerName: "web", containerId: "new", cpu: 5, ts: new Date(now + 1000) }), // newer web
    ]);
    const { svc } = make(findMany);
    const out = await svc.forServer("s1");
    // window: ts >= now - 90s, scoped to this server
    const where = findMany.mock.calls[0][0].where;
    expect(where.serverId).toBe("s1");
    expect(where.ts.gte).toBeInstanceOf(Date);
    // one row per container, sorted by name; web is the NEWER sample
    expect(out.containers.map((c) => c.name)).toEqual(["db", "web"]);
    const web = out.containers.find((c) => c.name === "web")!;
    expect(web.cpu).toBe(5);
    expect(web.containerId).toBe("new");
    expect(typeof web.netRx).toBe("number"); // BigInt → Number
  });

  it("forServer: empty server → no containers", async () => {
    const { svc } = make(jest.fn().mockResolvedValue([]));
    expect(await svc.forServer("s1")).toEqual({ containers: [] });
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
