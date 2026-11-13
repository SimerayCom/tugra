import { BASE_RETENTION, BaseBackupRunnerService, WAL_GC_BATCH, WAL_GC_BUDGET_MS, WAL_GC_LIST_PAGES } from "./base-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { PitrClaimsService } from "./pitr-claims.service";
import { WAL_LIST_PAGE } from "./pitr-restore-script";
import { LOCAL_DEST } from "./destination";

/**
 * WAL-aware retention (5.7): after the count prune, every archived segment BEFORE the oldest KEPT base's start
 * segment (same timeline) is reclaimed; everything else — including history files, other timelines and the kept
 * bases' own chain — stays. Whenever the cutoff is uncertain, nothing is deleted. The prune re-checks for a replay
 * before every destructive step and is bounded by a wall-clock budget.
 */
type Base = { id: string; filename: string; destinationId: string | null; status: string; startLsn: string | null; timeline: number | null; createdAt: Date };

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
/** The n-th 16 MiB segment on timeline tl (256 segments per high word, so n may exceed 255). */
const SEG = (n: number, tl = 1) => `${hex8(tl)}${hex8(Math.floor(n / 256))}${hex8(n % 256)}`;
/** An LSN inside segment n. */
const LSN = (n: number) => `${Math.floor(n / 256).toString(16).toUpperCase()}/${((n % 256) * 16777216 + 0x28).toString(16).toUpperCase()}`;

/** A real cursor-paged listing fake: name-sorted, `after`-exclusive, WAL_LIST_PAGE rows per page, trailer last. */
function pagedListing(names: string[], after: string, pageSize = WAL_LIST_PAGE): string {
  const stored = names.map((n) => `${n}.gz`).sort();
  const rest = stored.filter((n) => n > after);
  const page = rest.slice(0, pageSize);
  const more = rest.length > page.length ? 1 : 0;
  return page.map((n) => `OBJ ${n} 16777216 1700000000`).join("\n") + `\nTUGRA_WAL_OBJ n=${page.length} more=${more} last=${page[page.length - 1] ?? ""}\n`;
}
const afterOf = (script: string) => /awk -v a='([^']*)'/.exec(script)?.[1] ?? "";

function make(opts: {
  bases: Base[];
  objects: string[];
  pitr?: boolean;
  replaying?: boolean;
  claimed?: boolean;
  listExit?: number;
  listOutput?: (after: string) => string;
  deleteOutput?: (names: string[]) => string;
  unsorted?: boolean;
}) {
  const db = {
    id: "db1",
    name: "shop",
    teamId: "t1",
    serverId: "s1",
    engine: "POSTGRES",
    version: "16",
    backupDestinationId: null,
    pitrEnabled: opts.pitr ?? true,
    pitrEnabledAt: (opts.pitr ?? true) ? new Date("2026-11-01T00:00:00Z") : null,
  };
  const rows = [...opts.bases];
  const baseBackup = {
    // Honours where.databaseId/status, orderBy.createdAt (either direction) and take — so a query-shape regression
    // in the service changes the outcome instead of being masked by the fake.
    findMany: jest.fn((args: { where: { databaseId: string; status: string }; orderBy?: { createdAt: "asc" | "desc" }; take?: number }) => {
      let r = rows.filter((b) => b.status === args.where.status && args.where.databaseId === "db1");
      if (args.orderBy?.createdAt === "desc") r = r.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      else if (args.orderBy?.createdAt === "asc") r = r.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return Promise.resolve(args.take ? r.slice(0, args.take) : r);
    }),
    delete: jest.fn((args: { where: { id: string } }) => {
      const i = rows.findIndex((b) => b.id === args.where.id);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve({});
    }),
    deleteMany: jest.fn().mockResolvedValue({}),
  };
  const prisma = {
    baseBackup,
    restore: { findFirst: jest.fn().mockResolvedValue(opts.replaying ? { id: "r1" } : null) },
  } as unknown as PrismaService;
  const deleted: string[] = [];
  const listCalls: string[] = [];
  const sendCommand = jest.fn((_s: string, script: string) => {
    if (script.includes("TUGRA_WAL_OBJ")) {
      const after = afterOf(script);
      listCalls.push(after);
      return Promise.resolve({ exitCode: opts.listExit ?? 0, output: opts.listOutput ? opts.listOutput(after) : pagedListing(opts.objects, after) });
    }
    if (script.includes("TUGRA_WAL_GC")) {
      const names = [...script.matchAll(/TUGRA_WAL_GONE (\S+)"/g)].map((m) => m[1]);
      deleted.push(...names);
      const out = opts.deleteOutput ? opts.deleteOutput(names) : names.map((n) => `TUGRA_WAL_GONE ${n}`).join("\n") + `\nTUGRA_WAL_GC n=${names.length}\n`;
      return Promise.resolve({ exitCode: 0, output: out });
    }
    return Promise.resolve({ exitCode: 0, output: "" }); // base object delete (count prune)
  });
  const audit = jest.fn().mockResolvedValue(undefined);
  const claims = new PitrClaimsService();
  if (opts.claimed) claims.claim("db1");
  const svc = new BaseBackupRunnerService(
    prisma,
    { log: audit } as unknown as AuditService,
    { sendCommand } as unknown as AgentWsServer,
    { fireForEvent: jest.fn() } as unknown as NotificationsService,
    { destinationSpecById: jest.fn().mockResolvedValue(LOCAL_DEST) } as unknown as BackupRunnerService,
    {} as BackupAlertsService,
    claims,
  );
  const gcCalls = () => sendCommand.mock.calls.filter((c) => (c[1] as string).includes("TUGRA_WAL_GC"));
  return { svc, db, baseBackup, sendCommand, deleted, rows, listCalls, gcCalls, audit, claims };
}

const base = (i: number, seg: number, extra: Partial<Base> = {}): Base => ({
  id: `bb${i}`,
  filename: `t${i}.tar.gz`,
  destinationId: null,
  status: "SUCCESS",
  startLsn: LSN(seg),
  timeline: 1,
  createdAt: new Date(Date.UTC(2026, 10, i)),
  ...extra,
});

describe("BaseBackupRunnerService.pruneBase — WAL-aware retention", () => {
  it("reclaims the segments before the OLDEST kept base's start segment and nothing after it", async () => {
    // 5 bases at segments 2,4,6,8,10 → keep the newest 3 (6,8,10) → cutoff = segment 6
    const m = make({ bases: [1, 2, 3, 4, 5].map((i) => base(i, i * 2)), objects: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => SEG(n)) });
    await m.svc.pruneBase(m.db as never);
    expect(m.baseBackup.delete).toHaveBeenCalledTimes(5 - BASE_RETENTION);
    expect(m.deleted).toEqual([1, 2, 3, 4, 5].map((n) => SEG(n)));
    const gc = m.gcCalls();
    expect(gc).toHaveLength(1);
    expect(gc[0][1]).not.toContain(SEG(6));
    expect(gc[0][1]).not.toContain(SEG(7));
    // the kept set is read newest-first, bounded to the retention count
    expect(m.baseBackup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { databaseId: "db1", status: "SUCCESS" }, orderBy: { createdAt: "desc" }, take: BASE_RETENTION }),
    );
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.pitr.wal_gc", target: "db1", meta: expect.objectContaining({ cutoff: SEG(6), reclaimable: 5, deleted: 5, deferred: 0 }) }),
    );
  });

  it("the cutoff is the MINIMUM start segment over the kept set, whatever order the rows come back in", async () => {
    // createdAt order and LSN order disagree (a base taken later on a smaller LSN cannot happen on one timeline,
    // but a query-order flip must still never move the cutoff forward): kept = bb2(seg 9), bb3(seg 4), bb4(seg 7)
    const m = make({ bases: [base(1, 2), base(2, 9), base(3, 4), base(4, 7)], objects: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => SEG(n)) });
    await m.svc.pruneBase(m.db as never);
    expect(m.deleted).toEqual([SEG(1), SEG(2), SEG(3)]);
  });

  it("keeps history files and other timelines even when they sort before the cutoff (the timeline filter decides, not the name order)", async () => {
    // cutoff on timeline 2: timeline-1 segments sort lexically BEFORE it but are never ours to reclaim
    const objects = ["00000001.history", "00000002.history", SEG(1), SEG(9), SEG(3, 2), SEG(5, 2), SEG(7, 2)];
    const m = make({ bases: [base(1, 5, { timeline: 2 })], objects });
    await m.svc.pruneBase(m.db as never);
    expect(m.deleted).toEqual([SEG(3, 2)]);
  });

  it("deletes NOTHING when PITR is not active, when there is no kept base, or when ANY kept base lacks its start LSN / the timelines differ", async () => {
    const off = make({ bases: [base(1, 5)], objects: [SEG(1)], pitr: false });
    await off.svc.pruneBase(off.db as never);
    expect(off.deleted).toEqual([]);
    expect(off.listCalls).toHaveLength(0);

    const none = make({ bases: [base(1, 5, { status: "FAILED" })], objects: [SEG(1)] });
    await none.svc.pruneBase(none.db as never);
    expect(none.deleted).toEqual([]);

    // the OLDEST kept one is a pre-5.3 row without LSN → cutoff unknown → keep all
    const legacyOldest = make({ bases: [base(1, 2, { startLsn: null, timeline: null }), base(2, 5)], objects: [SEG(1), SEG(2)] });
    await legacyOldest.svc.pruneBase(legacyOldest.db as never);
    expect(legacyOldest.deleted).toEqual([]);
    expect(legacyOldest.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.wal_gc", meta: expect.objectContaining({ skipped: "no_start_lsn" }) }));

    // a MIDDLE / NEWER kept base without LSN (e.g. taken on a non-16MB cluster) → still refuse
    const legacyMiddle = make({ bases: [base(1, 2), base(2, 3, { startLsn: null, timeline: null }), base(3, 5)], objects: [SEG(1), SEG(2)] });
    await legacyMiddle.svc.pruneBase(legacyMiddle.db as never);
    expect(legacyMiddle.deleted).toEqual([]);
    expect(legacyMiddle.listCalls).toHaveLength(0);
    const legacyTl = make({ bases: [base(1, 2), base(2, 3, { timeline: null }), base(3, 5)], objects: [SEG(1)] });
    await legacyTl.svc.pruneBase(legacyTl.db as never);
    expect(legacyTl.deleted).toEqual([]);

    // kept bases on two timelines → ambiguous → refuse
    const tl = make({ bases: [base(1, 2), base(2, 3, { timeline: 2 })], objects: [SEG(1)] });
    await tl.svc.pruneBase(tl.db as never);
    expect(tl.deleted).toEqual([]);
    expect(tl.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ skipped: "timelines" }) }));
  });

  it("deletes NOTHING on an untrusted listing (non-zero exit / missing trailer) and audits the refusal", async () => {
    const bad = make({ bases: [base(1, 5)], objects: [SEG(1)], listExit: 1 });
    await bad.svc.pruneBase(bad.db as never);
    expect(bad.deleted).toEqual([]);
    expect(bad.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ skipped: "list_failed" }) }));

    const trunc = make({ bases: [base(1, 5)], objects: [SEG(1)], listOutput: () => `OBJ ${SEG(1)}.gz 1 1700000000\n` });
    await trunc.svc.pruneBase(trunc.db as never);
    expect(trunc.deleted).toEqual([]);
  });

  it("re-checks for a replay before EVERY destructive step: the up-front guard, each stale-base delete, each GC batch — and the in-process claim counts", async () => {
    const rep = make({ bases: [base(1, 5)], objects: [SEG(1)], replaying: true });
    await rep.svc.pruneBase(rep.db as never);
    expect(rep.sendCommand).not.toHaveBeenCalled();

    const claimed = make({ bases: [base(1, 5)], objects: [SEG(1)], claimed: true });
    await claimed.svc.pruneBase(claimed.db as never);
    expect(claimed.sendCommand).not.toHaveBeenCalled();

    // a replay claimed AFTER the first stale base went: the second stale base and the WAL GC must not run
    const mid = make({ bases: [1, 2, 3, 4, 5].map((i) => base(i, i * 2)), objects: [1, 2, 3, 4, 5, 6, 7].map((n) => SEG(n)) });
    mid.baseBackup.delete.mockImplementationOnce((args: { where: { id: string } }) => {
      mid.claims.claim("db1");
      const i = mid.rows.findIndex((b) => b.id === args.where.id);
      if (i >= 0) mid.rows.splice(i, 1);
      return Promise.resolve({});
    });
    await mid.svc.pruneBase(mid.db as never);
    expect(mid.baseBackup.delete).toHaveBeenCalledTimes(1);
    expect(mid.gcCalls()).toHaveLength(0);

    // a replay claimed between two GC batches stops the GC (audited as deferred/replay)
    const batches = make({ bases: [base(1, 500)], objects: Array.from({ length: 500 }, (_, i) => SEG(i + 1)) });
    batches.sendCommand.mockImplementation((_s: string, script: string) => {
      if (script.includes("TUGRA_WAL_OBJ")) return Promise.resolve({ exitCode: 0, output: pagedListing(Array.from({ length: 500 }, (_, i) => SEG(i + 1)), afterOf(script)) });
      if (script.includes("TUGRA_WAL_GC")) {
        batches.claims.claim("db1");
        const names = [...script.matchAll(/TUGRA_WAL_GONE (\S+)"/g)].map((m) => m[1]);
        return Promise.resolve({ exitCode: 0, output: names.map((n) => `TUGRA_WAL_GONE ${n}`).join("\n") + `\nTUGRA_WAL_GC n=${names.length}\n` });
      }
      return Promise.resolve({ exitCode: 0, output: "" });
    });
    await batches.svc.pruneBase(batches.db as never);
    expect(batches.gcCalls()).toHaveLength(1);
    expect(batches.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ stopped: "replay", deleted: WAL_GC_BATCH }) }));
  });

  it("deletes the stale base ROW before its object (a replay that picked it fails fast on the row, never mid-stream)", async () => {
    const m = make({ bases: [1, 2, 3, 4].map((i) => base(i, i * 2)), objects: [] });
    const order: string[] = [];
    m.baseBackup.delete.mockImplementation((args: { where: { id: string } }) => {
      order.push(`row:${args.where.id}`);
      return Promise.resolve({});
    });
    m.sendCommand.mockImplementation((_s: string, script: string) => {
      if (script.includes("TUGRA_WAL_OBJ")) return Promise.resolve({ exitCode: 0, output: pagedListing([], afterOf(script)) });
      if (!script.includes("TUGRA_WAL_GC")) order.push("object");
      return Promise.resolve({ exitCode: 0, output: "" });
    });
    await m.svc.pruneBase(m.db as never);
    expect(order).toEqual(["row:bb1", "object"]);
  });

  it("pages the listing with the cursor and stops at the cutoff (later pages are never requested); a cutoff deeper than the page cap skips the run", async () => {
    // 1000 objects, cutoff at 650: page 1 (1..400), page 2 (401..800) reaches past the cutoff → no page 3
    const objects = Array.from({ length: 1000 }, (_, i) => SEG(i + 1));
    const m = make({ bases: [base(1, 650)], objects });
    await m.svc.pruneBase(m.db as never);
    expect(m.listCalls).toEqual(["", `${SEG(400)}.gz`]);
    expect(m.deleted).toHaveLength(649);
    expect(m.deleted[0]).toBe(SEG(1));
    expect(m.deleted[648]).toBe(SEG(649));

    // candidates only on page 2 — reachable only if `after` is carried forward
    const late = make({ bases: [base(1, 450)], objects, listOutput: (after) => pagedListing(objects.slice(0, 460), after) });
    await late.svc.pruneBase(late.db as never);
    expect(late.deleted).toHaveLength(449);

    // an endless listing that never reaches the cutoff gives up after the page cap, deletes nothing, audits
    const endless = make({ bases: [base(1, 100000)], objects: [], listOutput: () => `OBJ ${SEG(1)}.gz 1 1700000000\nTUGRA_WAL_OBJ n=1 more=1 last=${SEG(1)}.gz\n` });
    await endless.svc.pruneBase(endless.db as never);
    expect(endless.listCalls).toHaveLength(WAL_GC_LIST_PAGES);
    expect(endless.gcCalls()).toHaveLength(0);
    expect(endless.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ skipped: "list_exceeded" }) }));
  });

  it("batches deletes, drains the whole backlog within the budget, stops at a died batch (no trailer) or when the budget is spent", async () => {
    const n = 2150;
    const objects = Array.from({ length: n + 1 }, (_, i) => SEG(i + 1));
    const m = make({ bases: [base(1, n + 1)], objects });
    await m.svc.pruneBase(m.db as never);
    expect(m.gcCalls()).toHaveLength(Math.ceil(n / WAL_GC_BATCH));
    expect(m.deleted).toHaveLength(n);

    const died = make({ bases: [base(1, 500)], objects: Array.from({ length: 500 }, (_, i) => SEG(i + 1)), deleteOutput: () => "TUGRA_WAL_GONE x\n" });
    await died.svc.pruneBase(died.db as never);
    expect(died.gcCalls()).toHaveLength(1);
    expect(died.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ stopped: "died" }) }));

    // budget: the clock jumps past the budget after the first batch → one batch, the rest deferred
    const slow = make({ bases: [base(1, 500)], objects: Array.from({ length: 500 }, (_, i) => SEG(i + 1)) });
    let t = 1_000_000;
    (slow.svc as unknown as { now: () => number }).now = () => {
      t += WAL_GC_BUDGET_MS;
      return t;
    };
    await slow.svc.pruneBase(slow.db as never);
    expect(slow.gcCalls()).toHaveLength(1);
    expect(slow.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ stopped: "budget", deferred: 499 - WAL_GC_BATCH }) }));
  });

  it("a failing delete command never fails the prune (best-effort, retried next run) and stops the batch loop", async () => {
    const objects = Array.from({ length: WAL_GC_BATCH + 50 }, (_, i) => SEG(i + 1));
    const m = make({ bases: [base(1, WAL_GC_BATCH + 51)], objects });
    m.sendCommand.mockImplementation((_s: string, script: string) => {
      if (script.includes("TUGRA_WAL_OBJ")) return Promise.resolve({ exitCode: 0, output: pagedListing(objects, afterOf(script)) });
      if (script.includes("TUGRA_WAL_GC")) return Promise.reject(new Error("agent offline"));
      return Promise.resolve({ exitCode: 0, output: "" });
    });
    await expect(m.svc.pruneBase(m.db as never)).resolves.toBeUndefined();
    expect(m.gcCalls()).toHaveLength(1);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ stopped: "error", deleted: 0 }) }));
  });
});

describe("BaseBackupRunnerService.runBaseBackupScheduled", () => {
  function tick(row: { baseBackupEnabled: boolean; engine: string; pitrEnabled?: boolean; pitrEnabledAt?: Date | null; status?: string } | null) {
    const full = row ? { pitrEnabled: true, pitrEnabledAt: new Date(), status: "RUNNING", ...row } : null;
    const prisma = { database: { findUnique: jest.fn().mockResolvedValue(full) } } as unknown as PrismaService;
    const svc = new BaseBackupRunnerService(
      prisma,
      {} as AuditService,
      {} as AgentWsServer,
      {} as NotificationsService,
      {} as BackupRunnerService,
      {} as BackupAlertsService,
      new PitrClaimsService(),
    );
    const run = jest.spyOn(svc, "runBaseBackup");
    return { svc, run };
  }

  it("re-checks the stored switches: a stale repeatable after disable, a non-Postgres row, PITR OFF/ARMING or a stopped database runs nothing", async () => {
    for (const row of [
      null,
      { baseBackupEnabled: false, engine: "POSTGRES" },
      { baseBackupEnabled: true, engine: "MYSQL" },
      { baseBackupEnabled: true, engine: "POSTGRES", pitrEnabled: false },
      { baseBackupEnabled: true, engine: "POSTGRES", pitrEnabledAt: null },
      { baseBackupEnabled: true, engine: "POSTGRES", status: "STOPPED" },
    ]) {
      const { svc, run } = tick(row);
      run.mockResolvedValue({} as never);
      await svc.runBaseBackupScheduled("db1");
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("runs as 'scheduler' and never throws (an offline server is already recorded + alerted by the run)", async () => {
    const { svc, run } = tick({ baseBackupEnabled: true, engine: "POSTGRES" });
    run.mockRejectedValue(new Error("agent offline"));
    await expect(svc.runBaseBackupScheduled("db1")).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith("db1", "scheduler");
  });
});
