import { BadGatewayException, BadRequestException, ConflictException, InternalServerErrorException, UnprocessableEntityException } from "@nestjs/common";
import { PitrService } from "./pitr.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { DatabasesService } from "../databases/databases.service";
import { BackupRunnerService } from "./backup-runner.service";
import { WalShipperRunnerService } from "./wal-shipper-runner.service";

const PW = "s3cr3tPassw0rd";
const SEG = "000000010000000000000003";
const spec = { id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: PW, database: "appdb" } };

type Row = Record<string, unknown> & { id: string; pitrEnabled: boolean; pitrEnabledAt: Date | null; status: string };
const baseRow = (): Row => ({
  id: "db1",
  name: "shop",
  teamId: "t1",
  serverId: "s1",
  engine: "POSTGRES",
  version: "16",
  image: "postgres:16",
  backupDestinationId: null,
  credentials: "enc",
  status: "RUNNING",
  pitrEnabled: false,
  pitrEnabledAt: null,
});
const ACTIVE = { pitrEnabled: true, pitrEnabledAt: new Date("2026-11-13T00:00:00Z"), status: "RUNNING" };
const ARMING = { pitrEnabled: true, pitrEnabledAt: null };

const OK = { output: "ok", exitCode: 0 };
const VERIFY_OK = { output: `TUGRA_PITR_VERIFY ok wal=${SEG}`, exitCode: 0 };
type Ship = { shipped: number; failed: number; backlog: number; skipped?: boolean };
type Reprov = { status: string; exitCode?: number; output?: string; error?: string } | Error;

/**
 * Stateful fake: `row` is mutated by update/updateMany so reload/stamp/clear are observable; updateMany returns
 * count 1 unless `casFails`. sendCommand / reprovision / shipOnce pop queued results (an Error rejects).
 * The DatabasesService maintenance lock is a real Set so lock semantics are exercised, not mocked away.
 */
function make(opts: {
  row?: Partial<Row>;
  results?: Array<{ output: string; exitCode: number } | Error>;
  reprovision?: Reprov[];
  ship?: Array<Ship | Error>;
  casFails?: boolean;
  capability?: boolean;
  online?: boolean;
  locked?: boolean;
  inflight?: { base?: boolean; backup?: boolean; restore?: boolean };
} = {}) {
  const row: Row = { ...baseRow(), ...opts.row };
  const results = [...(opts.results ?? [])];
  const sendCommand = jest.fn((..._a: unknown[]) => {
    const r = results.shift();
    if (r === undefined) return Promise.resolve(OK);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  type Args = { where?: Record<string, unknown>; data: Record<string, unknown> };
  const updateMany = jest.fn((args: Args) => {
    if (opts.casFails) return Promise.resolve({ count: 0 });
    Object.assign(row, args.data);
    return Promise.resolve({ count: 1 });
  });
  const update = jest.fn((args: Args) => {
    Object.assign(row, args.data);
    return Promise.resolve({ ...row });
  });
  const findMany = jest.fn().mockResolvedValue([]);
  const backupFindFirst = jest.fn().mockResolvedValue(opts.inflight?.backup ? { id: "b" } : null);
  const prisma = {
    database: { findUnique: jest.fn(() => Promise.resolve({ ...row })), findMany, updateMany, update },
    baseBackup: { findFirst: jest.fn().mockResolvedValue(opts.inflight?.base ? { id: "bb" } : null) },
    backup: { findFirst: backupFindFirst },
    restore: { findFirst: jest.fn().mockResolvedValue(opts.inflight?.restore ? { id: "r" } : null) },
  } as unknown as PrismaService;
  const requirePermission = jest.fn().mockResolvedValue(undefined);
  const access = { requirePermission } as unknown as TeamAccessService;
  const log = jest.fn().mockResolvedValue(undefined);
  const audit = { log } as unknown as AuditService;
  const agentWs = {
    sendCommand,
    isCapabilityGranted: jest.fn().mockResolvedValue(opts.capability ?? true),
    isOnline: jest.fn().mockReturnValue(opts.online ?? true),
  } as unknown as AgentWsServer;
  const runner = {
    toSpec: jest.fn().mockReturnValue(spec),
    destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
  } as unknown as BackupRunnerService;
  const reprovQueue = [...(opts.reprovision ?? [])];
  const reprovision = jest.fn((db: Row, _actor: string, _o: { pitr: boolean }) => {
    const next = reprovQueue.shift() ?? { status: "RUNNING" };
    if (next instanceof Error) return Promise.reject(next);
    row.status = next.status;
    return Promise.resolve({ row: { ...db, ...row, status: next.status }, exitCode: next.exitCode ?? 0, output: next.output ?? "", error: next.error });
  });
  const maintenance = new Set<string>(opts.locked ? ["db1"] : []);
  const databases = {
    reprovision,
    acquireMaintenance: jest.fn((id: string) => {
      if (maintenance.has(id)) throw new ConflictException("busy");
      maintenance.add(id);
      return () => maintenance.delete(id);
    }),
    isUnderMaintenance: (id: string) => maintenance.has(id),
  } as unknown as DatabasesService;
  const shipQueue = [...(opts.ship ?? [])];
  const shipOnce = jest.fn(() => {
    const next = shipQueue.shift() ?? { shipped: 0, failed: 0, backlog: 0 };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const shipper = { shipOnce } as unknown as WalShipperRunnerService;
  const svc = new PitrService(prisma, access, audit, agentWs, runner, databases, shipper);
  (svc as unknown as { delay: () => Promise<void> }).delay = () => Promise.resolve(); // no real sleeps in the drain loop
  return { svc, row, sendCommand, updateMany, update, findMany, backupFindFirst, reprovision, shipOnce, log, requirePermission, maintenance };
}

const scripts = (sendCommand: jest.Mock) => sendCommand.mock.calls.map((c) => String(c[1]));
const order = (m: jest.Mock, i = 0) => m.mock.invocationCallOrder[i];

describe("PitrService.enable", () => {
  it("happy path: preflight → CAS claim (flag-first) → stop → recreate(pitr:true) → verify → guarded stamp ACTIVE", async () => {
    const { svc, row, sendCommand, updateMany, reprovision, log, maintenance } = make({ results: [OK, OK, VERIFY_OK] });
    const r = await svc.enable("u1", "db1");
    expect(r.state).toBe("ACTIVE");
    expect(row).toMatchObject({ pitrEnabled: true, status: "RUNNING" });
    expect(row.pitrEnabledAt).toBeInstanceOf(Date);
    const claim = updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "db1", status: "RUNNING", pitrEnabled: false });
    expect(claim.data).toMatchObject({ status: "PROVISIONING", pitrEnabled: true });
    expect(order(updateMany)).toBeLessThan(order(reprovision)); // flag flipped BEFORE any container is armed
    expect(reprovision).toHaveBeenCalledWith(expect.objectContaining({ id: "db1" }), "u1", { pitr: true });
    const s = scripts(sendCommand);
    expect(s[0]).toContain("TUGRA_PITR_PREFLIGHT");
    expect(s[1]).toContain("docker stop -t 60 tugra_db_db1");
    expect(s[2]).toContain("TUGRA_PITR_VERIFY");
    expect(sendCommand.mock.calls.every((c) => c[2] === "database")).toBe(true);
    const stamp = updateMany.mock.calls.at(-1)![0];
    expect(stamp.where).toMatchObject({ pitrEnabled: true, pitrEnabledAt: null }); // never re-stamps a disabled row
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.enable", meta: { wal: SEG } }));
    expect(maintenance.size).toBe(0); // lock released
  });

  it("holds the DatabasesService maintenance lock for the whole transition (preflight included) and releases it on failure too", async () => {
    const { svc, maintenance } = make({ results: [{ output: "minimal", exitCode: 4 }] });
    await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    expect(maintenance.size).toBe(0);
  });

  it("requires BOTH 'databases' and 'backups' permissions", async () => {
    const { svc, requirePermission } = make({ results: [OK, OK, VERIFY_OK] });
    await svc.enable("u1", "db1");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "databases");
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "backups");
  });

  it("rejects non-Postgres (400) with no agent call", async () => {
    const { svc, sendCommand } = make({ row: { engine: "MYSQL" } });
    await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(BadRequestException);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("is idempotent when already ACTIVE (no agent call, no mutation)", async () => {
    const { svc, sendCommand, updateMany } = make({ row: ACTIVE });
    expect((await svc.enable("u1", "db1")).state).toBe("ACTIVE");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses BEFORE any mutation: offline agent (503), held lock, non-RUNNING, running backup/base/restore, missing capability", async () => {
    const offline = make({ online: false });
    await expect(offline.svc.enable("u1", "db1")).rejects.toBeInstanceOf(AgentOfflineException);
    for (const opts of [{ locked: true }, { row: { status: "STOPPED" } }, { inflight: { base: true } }, { inflight: { backup: true } }, { inflight: { restore: true } }, { capability: false }]) {
      const { svc, sendCommand, updateMany } = make(opts);
      await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
      expect(sendCommand).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it("a preflight refusal (wal_level=minimal, exit 4) is a 409 with the hint and NO claim / recreate", async () => {
    const { svc, updateMany, reprovision } = make({ results: [{ output: "tugra: wal_level=minimal", exitCode: 4 }] });
    await expect(svc.enable("u1", "db1")).rejects.toMatchObject({ message: expect.stringMatching(/wal_level/) });
    expect(updateMany).not.toHaveBeenCalled();
    expect(reprovision).not.toHaveBeenCalled();
  });

  it("a lost CAS (row changed under us) is a 409 after preflight, with no recreate", async () => {
    const { svc, reprovision } = make({ results: [OK], casFails: true });
    await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    expect(reprovision).not.toHaveBeenCalled();
  });

  it("re-checks in-flight work AFTER the claim and hands the row back untouched on a hit (scheduled backup started during preflight)", async () => {
    const { svc, row, backupFindFirst, updateMany, reprovision } = make({ results: [OK] });
    backupFindFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "b" }); // clear pre-lock, RUNNING post-claim
    await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).toHaveBeenCalledTimes(2); // claim, then revert
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ status: "RUNNING", pitrEnabled: false });
    expect(row).toMatchObject({ pitrEnabled: false, status: "RUNNING" });
    expect(reprovision).not.toHaveBeenCalled();
  });

  it("verify failure → AUTO-ROLLBACK: recreate(pitr:false), purge spool, clear flag LAST (guarded), 422 with a scrubbed tail", async () => {
    const { svc, row, sendCommand, reprovision, updateMany, log } = make({
      results: [OK, OK, { output: `tugra: archive_command failed (last failed wal: x) ${PW}`, exitCode: 9 }, OK, OK],
    });
    let err: unknown;
    try {
      await svc.enable("u1", "db1");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toMatch(/archive_command/);
    expect((err as Error).message).not.toContain(PW);
    expect((err as Error).message).toContain("turned back off");
    expect(reprovision).toHaveBeenNthCalledWith(2, expect.anything(), "u1", { pitr: false });
    const purgeIdx = scripts(sendCommand).findIndex((s) => s.includes("rm -rf '/etc/tugra/wal/db1'"));
    expect(purgeIdx).toBeGreaterThan(-1);
    const clear = updateMany.mock.calls.find((c) => c[0].data.pitrEnabled === false)!;
    expect(clear[0].where).toMatchObject({ pitrEnabled: true, pitrEnabledAt: null }); // guarded: only an ARMING row is cleared
    expect(clear[0].data).toMatchObject({ pitrEnabled: false, pitrEnabledAt: null, status: "RUNNING" });
    // ordering: non-archiving recreate → purge → clear
    expect(order(reprovision, 1)).toBeLessThan(sendCommand.mock.invocationCallOrder[purgeIdx]);
    expect(sendCommand.mock.invocationCallOrder[purgeIdx]).toBeLessThan(updateMany.mock.invocationCallOrder[updateMany.mock.calls.indexOf(clear)]);
    expect(row.pitrEnabled).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.enable_failed", meta: expect.objectContaining({ step: "verify", rolledBack: true }) }));
  });

  it("recreate failure → rollback too (step 'recreate')", async () => {
    const { svc, reprovision, row } = make({ reprovision: [{ status: "FAILED", exitCode: 1, output: "boom" }, { status: "RUNNING" }] });
    await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(reprovision).toHaveBeenCalledTimes(2);
    expect(row.pitrEnabled).toBe(false);
  });

  it("when the ROLLBACK recreate also fails: flag NOT cleared, spool NOT purged (it may still be archiving), 500", async () => {
    const { svc, row, sendCommand, updateMany, log } = make({
      results: [OK, OK, { output: "no WAL", exitCode: 10 }, OK],
      reprovision: [{ status: "RUNNING" }, { status: "FAILED", exitCode: 1 }],
    });
    await expect(svc.enable("u1", "db1")).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(updateMany.mock.calls.find((c) => c[0].data.pitrEnabled === false)).toBeUndefined();
    expect(scripts(sendCommand).some((s) => s.includes("rm -rf"))).toBe(false); // never purge an undrained spool
    expect(row).toMatchObject({ pitrEnabled: true, pitrEnabledAt: null });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.enable_failed", meta: expect.objectContaining({ rolledBack: false }) }));
  });

  it("resumes an ARMING row (hub crashed mid-enable) with the same guards but no re-claim / re-preflight", async () => {
    const { svc, row, sendCommand, updateMany } = make({ row: ARMING, results: [OK, VERIFY_OK] });
    expect((await svc.enable("u1", "db1")).state).toBe("ACTIVE");
    expect(row.pitrEnabledAt).toBeInstanceOf(Date);
    expect(scripts(sendCommand)[0]).toContain("docker stop"); // straight to the tail
    expect(updateMany.mock.calls.find((c) => c[0].data.pitrEnabled === true)).toBeUndefined();
    const guarded = make({ row: ARMING, capability: false });
    await expect(guarded.svc.enable("u1", "db1")).rejects.toBeInstanceOf(ConflictException); // capability still required
  });
});

describe("PitrService.disable", () => {
  it("ACTIVE happy path, strictly ordered: strict stop → drain → recreate(pitr:false) → purge → clear flag LAST", async () => {
    const { svc, row, sendCommand, reprovision, shipOnce, update, log, maintenance } = make({ row: ACTIVE, ship: [{ shipped: 3, failed: 0, backlog: 0 }] });
    const r = await svc.disable("u1", "db1");
    expect(r.state).toBe("OFF");
    expect(row).toMatchObject({ pitrEnabled: false, pitrEnabledAt: null, status: "RUNNING" });
    const s = scripts(sendCommand);
    expect(s[0]).toBe("docker stop -t 60 tugra_db_db1 2>&1"); // STRICT: exit code is trusted, not swallowed
    const purgeIdx = s.findIndex((x) => x.includes("rm -rf '/etc/tugra/wal/db1'"));
    expect(purgeIdx).toBeGreaterThan(0);
    const clear = update.mock.calls.find((c) => c[0].data.pitrEnabled === false)!;
    const clearOrder = update.mock.invocationCallOrder[update.mock.calls.indexOf(clear)];
    expect(sendCommand.mock.invocationCallOrder[0]).toBeLessThan(order(shipOnce)); // stop before drain
    expect(order(shipOnce)).toBeLessThan(order(reprovision)); // drain before the non-archiving recreate
    expect(reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: false });
    expect(order(reprovision)).toBeLessThan(sendCommand.mock.invocationCallOrder[purgeIdx]); // recreate before purge
    expect(sendCommand.mock.invocationCallOrder[purgeIdx]).toBeLessThan(clearOrder); // purge before the flag clears
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable", meta: { drained: true, purged: true } }));
    expect(maintenance.size).toBe(0);
  });

  it("a drain tick skipped by the scheduled sweep's lock is RETRIED, not treated as failure", async () => {
    const { svc, row, shipOnce, reprovision } = make({ row: ACTIVE, ship: [{ shipped: 0, failed: 0, backlog: -1, skipped: true }, { shipped: 2, failed: 0, backlog: 0 }] });
    await svc.disable("u1", "db1");
    expect(shipOnce).toHaveBeenCalledTimes(2);
    expect(reprovision).toHaveBeenCalledTimes(1); // one recreate (pitr:false), no spurious restore
    expect(row.pitrEnabled).toBe(false);
  });

  it("un-shipped WAL without purgeSpool → restores archiving (recreate pitr:true), keeps the flag, purges NOTHING, 502", async () => {
    const { svc, row, sendCommand, reprovision, update, log } = make({ row: ACTIVE, ship: [{ shipped: 1, failed: 1, backlog: 4 }, { shipped: 0, failed: 1, backlog: 4 }] });
    await expect(svc.disable("u1", "db1")).rejects.toMatchObject({ message: expect.stringMatching(/4 WAL segment.*archiving was left on/) });
    expect(reprovision).toHaveBeenCalledTimes(1);
    expect(reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: true }); // put back exactly as it was
    expect(scripts(sendCommand).some((s) => s.includes("rm -rf"))).toBe(false);
    expect(update.mock.calls.find((c) => c[0].data.pitrEnabled === false)).toBeUndefined();
    expect(row.pitrEnabled).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable_failed", meta: { backlog: 4 } }));
  });

  it("a shipper that THROWS mid-drain leaves the backlog unknown → restore + 502 (never a stuck PROVISIONING row)", async () => {
    const { svc, row, reprovision } = make({ row: ACTIVE, ship: [new Error("decrypt failed")] });
    await expect(svc.disable("u1", "db1")).rejects.toBeInstanceOf(BadGatewayException);
    expect(reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: true });
    expect(row.pitrEnabled).toBe(true);
  });

  it("an UNEXPECTED error after the claim (recreate rejects) restores the archiving container, audits, and rethrows", async () => {
    const { svc, row, reprovision, log } = make({ row: ACTIVE, ship: [{ shipped: 0, failed: 0, backlog: 0 }], reprovision: [new Error("prisma down"), { status: "RUNNING" }] });
    await expect(svc.disable("u1", "db1")).rejects.toThrow("prisma down");
    expect(reprovision).toHaveBeenNthCalledWith(2, expect.anything(), "u1", { pitr: true });
    expect(row.pitrEnabled).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable_failed", meta: expect.objectContaining({ error: "prisma down" }) }));
  });

  it("un-shipped WAL WITH purgeSpool → proceeds, purges, clears (explicit acceptance of loss)", async () => {
    const { svc, row, sendCommand, reprovision, log } = make({ row: ACTIVE, ship: [{ shipped: 0, failed: 1, backlog: 4 }, { shipped: 0, failed: 1, backlog: 4 }] });
    await svc.disable("u1", "db1", { purgeSpool: true });
    expect(row.pitrEnabled).toBe(false);
    expect(reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: false });
    expect(scripts(sendCommand).some((s) => s.includes("rm -rf '/etc/tugra/wal/db1'"))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable", meta: { drained: false, purged: true } }));
  });

  it("a failed/indeterminate STRICT stop aborts before any drain and RESTORES the real state (recreate pitr:true), 502", async () => {
    for (const first of [{ output: "Error response from daemon", exitCode: 1 }, new AgentOfflineException()]) {
      const { svc, row, shipOnce, reprovision, log } = make({ row: ACTIVE, results: [first] });
      await expect(svc.disable("u1", "db1")).rejects.toMatchObject({ message: expect.stringMatching(/could not be stopped/) });
      expect(shipOnce).not.toHaveBeenCalled();
      // never a bare "status back to RUNNING" over a container of unknown state — the archiving container is re-made
      expect(reprovision).toHaveBeenCalledTimes(1);
      expect(reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: true });
      expect(row).toMatchObject({ pitrEnabled: true, status: "RUNNING" });
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable_failed", meta: { step: "stop" } }));
    }
  });

  it("a MISSING container on strict stop counts as stopped — disable proceeds instead of failing forever", async () => {
    const { svc, row, reprovision } = make({ row: ACTIVE, results: [{ output: "Error response from daemon: No such container: tugra_db_db1", exitCode: 1 }], ship: [{ shipped: 0, failed: 0, backlog: 0 }] });
    await svc.disable("u1", "db1");
    expect(reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: false });
    expect(row.pitrEnabled).toBe(false);
  });

  it("refuses a missing capability BEFORE any mutation (no minutes of downtime chasing a revoked 'backup')", async () => {
    const { svc, updateMany, sendCommand } = make({ row: ACTIVE, capability: false });
    await expect(svc.disable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("a failure AFTER the flag is cleared (final audit throws) never re-arms archiving — committed state is kept", async () => {
    const { svc, row, reprovision, log } = make({ row: ACTIVE, ship: [{ shipped: 0, failed: 0, backlog: 0 }] });
    log.mockImplementation((e: { action: string }) => (e.action === "database.pitr.disable" ? Promise.reject(new Error("audit down")) : Promise.resolve(undefined)));
    await svc.disable("u1", "db1"); // best-effort audit: the disable still succeeds
    expect(reprovision).toHaveBeenCalledTimes(1); // only the pitr:false recreate — NO restore to pitr:true
    expect(row.pitrEnabled).toBe(false);
  });

  it("the non-archiving recreate failing keeps the flag TRUE (retry is idempotent) and is a 502", async () => {
    const { svc, row } = make({ row: ACTIVE, ship: [{ shipped: 0, failed: 0, backlog: 0 }], reprovision: [{ status: "FAILED" }] });
    await expect(svc.disable("u1", "db1")).rejects.toBeInstanceOf(BadGatewayException);
    expect(row.pitrEnabled).toBe(true);
  });

  it("a STOPPED database: no stop, drain, REMOVE the archiving-configured container (volume kept) and PROVE it is gone, then clear", async () => {
    const { svc, row, sendCommand, reprovision } = make({ row: { ...ACTIVE, status: "STOPPED" }, ship: [{ shipped: 0, failed: 0, backlog: 0 }] });
    await svc.disable("u1", "db1");
    const s = scripts(sendCommand);
    expect(s[0]).toContain("docker rm -f tugra_db_db1"); // not left around with archive_mode=on
    expect(s[0]).toContain("! docker inspect tugra_db_db1"); // exit 0 only when no such container remains
    expect(s.some((x) => x.includes("docker volume rm"))).toBe(false); // data volume kept
    expect(reprovision).not.toHaveBeenCalled();
    expect(row).toMatchObject({ pitrEnabled: false, status: "STOPPED" });
  });

  it("a STOPPED database whose container removal cannot be proven keeps the flag, purges nothing, 502", async () => {
    const { svc, row, sendCommand, log } = make({ row: { ...ACTIVE, status: "STOPPED" }, ship: [{ shipped: 0, failed: 0, backlog: 0 }], results: [{ output: "still there", exitCode: 1 }] });
    await expect(svc.disable("u1", "db1")).rejects.toMatchObject({ message: expect.stringMatching(/could not be removed/) });
    expect(scripts(sendCommand).some((x) => x.includes("rm -rf"))).toBe(false);
    expect(row).toMatchObject({ pitrEnabled: true, status: "STOPPED" });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable_failed", meta: { step: "remove" } }));
  });

  it("a typed agent error (offline) thrown mid-flow after the claim still restores state + audits (no HttpException blind spot)", async () => {
    const { svc, row, log } = make({ row: { ...ACTIVE, status: "STOPPED" }, ship: [{ shipped: 0, failed: 0, backlog: 0 }], results: [new AgentOfflineException()] });
    await expect(svc.disable("u1", "db1")).rejects.toBeInstanceOf(AgentOfflineException);
    expect(row).toMatchObject({ pitrEnabled: true, status: "STOPPED" }); // status released, never left PROVISIONING
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.disable_failed" }));
  });

  it("an ARMING row is disabled via the enable rollback (no drain); a failing rollback recreate keeps the flag + 502", async () => {
    const ok = make({ row: ARMING });
    expect((await ok.svc.disable("u1", "db1")).state).toBe("OFF");
    expect(ok.reprovision).toHaveBeenCalledWith(expect.anything(), "u1", { pitr: false });
    expect(ok.shipOnce).not.toHaveBeenCalled();
    const bad = make({ row: ARMING, reprovision: [{ status: "FAILED" }] });
    await expect(bad.svc.disable("u1", "db1")).rejects.toBeInstanceOf(BadGatewayException);
    expect(bad.row.pitrEnabled).toBe(true);
  });

  it("OFF is a no-op (only an explicit purgeSpool touches the agent); offline / held lock / in-flight work refuse before mutation", async () => {
    const a = make();
    await a.svc.disable("u1", "db1");
    expect(a.sendCommand).not.toHaveBeenCalled();
    const b = make();
    await b.svc.disable("u1", "db1", { purgeSpool: true });
    expect(scripts(b.sendCommand)).toEqual(["rm -rf '/etc/tugra/wal/db1' 2>/dev/null || true"]);
    await expect(make({ row: ACTIVE, online: false }).svc.disable("u1", "db1")).rejects.toBeInstanceOf(AgentOfflineException);
    await expect(make({ row: ACTIVE, locked: true }).svc.disable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    const c = make({ row: ACTIVE, inflight: { base: true } });
    await expect(c.svc.disable("u1", "db1")).rejects.toBeInstanceOf(ConflictException);
    expect(c.shipOnce).not.toHaveBeenCalled();
  });
});

describe("PitrService.status + reconcileArming", () => {
  it("reports OFF / ARMING / ACTIVE and needsBaseBackup (no SUCCESS base since enabling)", async () => {
    expect((await make().svc.status("u1", "db1")).state).toBe("OFF");
    expect((await make({ row: ARMING }).svc.status("u1", "db1")).state).toBe("ARMING");
    expect(await make({ row: ACTIVE }).svc.status("u1", "db1")).toMatchObject({ state: "ACTIVE", needsBaseBackup: true, destinationType: "LOCAL" });
  });

  function pastGrace() {
    const now = jest.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    return { second: () => now.mockReturnValue(1_000_000 + 7 * 60_000), restore: () => now.mockRestore() };
  }

  it("leaves an ARMING row alone inside the grace window, then verifies-and-stamps WITHOUT a restart", async () => {
    const { svc, row, findMany, sendCommand, reprovision } = make({ row: ARMING, results: [VERIFY_OK] });
    findMany.mockResolvedValue([{ ...row }]);
    const t = pastGrace();
    await svc.reconcileArming();
    expect(sendCommand).not.toHaveBeenCalled();
    t.second();
    await svc.reconcileArming();
    expect(scripts(sendCommand)[0]).toContain("TUGRA_PITR_VERIFY");
    expect(reprovision).not.toHaveBeenCalled();
    expect(row.pitrEnabledAt).toBeInstanceOf(Date);
    t.restore();
  });

  it("RE-READS the row under the lock and never acts on a stale snapshot (row became ACTIVE meanwhile)", async () => {
    const { svc, row, findMany, sendCommand, reprovision } = make({ row: ACTIVE });
    findMany.mockResolvedValue([{ ...row, pitrEnabledAt: null }]); // stale listing says ARMING
    const t = pastGrace();
    await svc.reconcileArming();
    t.second();
    await svc.reconcileArming();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(reprovision).not.toHaveBeenCalled();
    expect(row.pitrEnabledAt).toEqual(ACTIVE.pitrEnabledAt);
    t.restore();
  });

  it("verify failure past grace → rollback (flag cleared); an offline agent leaves the row untouched", async () => {
    const a = make({ row: ARMING, results: [{ output: "no WAL", exitCode: 10 }, OK] });
    a.findMany.mockResolvedValue([{ ...a.row }]);
    let t = pastGrace();
    await a.svc.reconcileArming();
    t.second();
    await a.svc.reconcileArming();
    expect(a.reprovision).toHaveBeenCalledWith(expect.anything(), "reconciler", { pitr: false });
    expect(a.row.pitrEnabled).toBe(false);
    expect(a.log).toHaveBeenCalledWith(expect.objectContaining({ action: "database.pitr.enable_failed", meta: expect.objectContaining({ step: "reconcile" }) }));
    t.restore();
    const b = make({ row: ARMING, online: false });
    b.findMany.mockResolvedValue([{ ...b.row }]);
    t = pastGrace();
    await b.svc.reconcileArming();
    t.second();
    await b.svc.reconcileArming();
    expect(b.sendCommand).not.toHaveBeenCalled();
    expect(b.row).toMatchObject({ pitrEnabled: true, pitrEnabledAt: null });
    t.restore();
  });
});
