import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

// Real-DB check of the default-on backfill (prisma/migrations/20261126000000_cleanup_explicit_choice).
// The e2e database is already migrated, so the column exists: replay only the data statements of the
// migration file against seeded rows, then assert who flipped and who stayed off.
const sql = readFileSync(join(__dirname, "../prisma/migrations/20261126000000_cleanup_explicit_choice/migration.sql"), "utf8");
const dataStatements = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s && !/^ALTER TABLE/i.test(s));

describe("cleanup default-on backfill (migration data statements)", () => {
  const prisma = new PrismaClient();
  const tag = `cxm-${Date.now()}`;
  let teamId = "";
  const ids: Record<string, string> = {};
  // The replayed UPDATEs have no row filter (they are the migration's), so they also hit servers that other
  // suites left behind in the shared e2e DB. Snapshot those and restore them in afterAll.
  const cols = { cleanupEnabled: true, cleanupCron: true, cleanupIntervalHours: true, cleanupThresholdPct: true, cleanupExplicit: true } as const;
  let others: Array<{ id: string } & Record<keyof typeof cols, unknown>> = [];

  const mk = async (key: string, data: Record<string, unknown>) => {
    const s = await prisma.server.create({ data: { name: `${tag}-${key}`, teamId, enrollToken: `${tag}-${key}`, ...data } });
    ids[key] = s.id;
  };
  const get = (key: string) => prisma.server.findUniqueOrThrow({ where: { id: ids[key] } });

  beforeAll(async () => {
    others = (await prisma.server.findMany({ select: { id: true, ...cols } })) as typeof others;
    teamId = (await prisma.team.create({ data: { name: tag } })).id;
    await mk("never", {}); // legacy row: off, nothing set, never ran
    await mk("withCron", { cleanupCron: "0 5 * * *" }); // off but has a schedule -> deliberate
    await mk("withInterval", { cleanupIntervalHours: 6 });
    await mk("withThreshold", { cleanupThresholdPct: 90 });
    await mk("ran", { lastCleanupAt: new Date() });
    await mk("auditedOff", {}); // operator saved config (off) -> audit trail says explicit
    await mk("auditedBulk", {});
    await mk("alreadyExplicit", { cleanupExplicit: true });
    await mk("alreadyOn", { cleanupEnabled: true, cleanupCron: "0 1 * * *", cleanupThresholdPct: 70 });
    await prisma.auditLog.create({ data: { actor: "u1", action: "server.cleanup.config", target: ids.auditedOff } });
    await prisma.auditLog.create({ data: { actor: "u1", action: "server.cleanup.config.bulk", target: `other,${ids.auditedBulk}` } });
    for (const st of dataStatements) await prisma.$executeRawUnsafe(st);
  });

  afterAll(async () => {
    for (const o of others) {
      const { id, ...data } = o;
      await prisma.server.update({ where: { id }, data: data as never }).catch(() => undefined);
    }
    await prisma.auditLog.deleteMany({ where: { target: { contains: tag } } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { OR: [{ target: ids.auditedOff }, { target: { contains: ids.auditedBulk ?? "x" } }] } }).catch(() => undefined);
    await prisma.team.delete({ where: { id: teamId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("switches a never-configured server on with the defaults", async () => {
    expect(await get("never")).toMatchObject({ cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80, cleanupExplicit: false });
  });

  it("leaves servers an operator configured and turned off, OFF (and marks them explicit)", async () => {
    for (const k of ["withCron", "withInterval", "withThreshold", "ran", "auditedOff", "auditedBulk"]) {
      const s = await get(k);
      expect({ k, enabled: s.cleanupEnabled, explicit: s.cleanupExplicit }).toEqual({ k, enabled: false, explicit: true });
    }
    expect((await get("withCron")).cleanupCron).toBe("0 5 * * *");
    expect((await get("withThreshold")).cleanupThresholdPct).toBe(90);
  });

  it("respects the explicit flag itself", async () => {
    expect(await get("alreadyExplicit")).toMatchObject({ cleanupEnabled: false, cleanupExplicit: true });
  });

  it("does not touch a server that is already on", async () => {
    expect(await get("alreadyOn")).toMatchObject({ cleanupEnabled: true, cleanupCron: "0 1 * * *", cleanupThresholdPct: 70 });
  });

  it("is idempotent: a re-run changes nothing", async () => {
    const before = await get("never");
    for (const st of dataStatements) await prisma.$executeRawUnsafe(st);
    expect(await get("never")).toEqual(before);
    expect((await get("auditedOff")).cleanupEnabled).toBe(false);
  });
});
