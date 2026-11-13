import { ForbiddenException } from "@nestjs/common";
import { WalShipperRunnerService } from "./wal-shipper-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { AgentOfflineException, AgentCommandTimeoutException } from "../agent-gateway/agent-offline.exception";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";

const SEG1 = "000000010000000000000003";
const SEG2 = "000000010000000000000004";

const db = {
  id: "db1",
  name: "shop",
  teamId: "t1",
  serverId: "s1",
  engine: "POSTGRES",
  version: "16",
  backupDestinationId: null,
  credentials: "enc",
  pitrEnabled: true,
  pitrEnabledAt: new Date("2026-11-13T00:00:00Z"),
};
const spec = { id: "db1", engine: "POSTGRES", credentials: { username: "tugra", password: "s3cr3tPassw0rd", database: "appdb" } };

/** Queue of sendCommand results (list first, then ship); an Error rejects. */
function make(opts: { results?: Array<{ output: string; exitCode: number } | Error>; dbOverride?: Record<string, unknown>; dbRows?: Array<{ id: string }>; destThrows?: boolean; destRejectOnce?: boolean } = {}) {
  const results = [...(opts.results ?? [])];
  const sendCommand = jest.fn((..._args: unknown[]) => {
    const r = results.shift();
    if (r === undefined) return Promise.resolve({ output: "", exitCode: 0 });
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  const findUnique = jest.fn().mockResolvedValue(opts.dbOverride === null ? null : { ...db, ...opts.dbOverride });
  const findMany = jest.fn().mockResolvedValue(opts.dbRows ?? [{ id: "db1" }]);
  const backup = { findMany: jest.fn(), create: jest.fn(), update: jest.fn() };
  const baseBackup = { findMany: jest.fn(), create: jest.fn() };
  const prisma = {
    database: { findUnique, findMany },
    backup,
    baseBackup,
  } as unknown as PrismaService;
  const LOCAL = { type: "LOCAL", encryption: { enabled: false, key: "" } };
  let destinationSpecById: jest.Mock;
  if (opts.destThrows) destinationSpecById = jest.fn().mockRejectedValue(new Error("decrypt failed"));
  else if (opts.destRejectOnce) destinationSpecById = jest.fn().mockRejectedValueOnce(new Error("decrypt failed")).mockResolvedValue(LOCAL);
  else destinationSpecById = jest.fn().mockResolvedValue(LOCAL);
  const runner = {
    destinationSpecById,
    toSpec: jest.fn().mockReturnValue(spec),
  } as unknown as BackupRunnerService;
  const shouldNotifyFailure = jest.fn().mockResolvedValue(true);
  const recover = jest.fn().mockResolvedValue(false);
  const alerts = { shouldNotifyFailure, recover } as unknown as BackupAlertsService;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const notifications = { fireForEvent } as unknown as NotificationsService;
  const svc = new WalShipperRunnerService(prisma, { sendCommand } as unknown as AgentWsServer, runner, alerts, notifications);
  return { svc, sendCommand, findMany, backup, baseBackup, shouldNotifyFailure, recover, fireForEvent };
}

describe("WalShipperRunnerService", () => {
  describe("shipAll", () => {
    it("selects ONLY stamped PITR rows (pitrEnabled && pitrEnabledAt set)", async () => {
      const { svc, findMany } = make({ dbRows: [] });
      await svc.shipAll();
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { engine: "POSTGRES", pitrEnabled: true, pitrEnabledAt: { not: null } } }),
      );
    });

    it("isolates a failing database so one does not stall the sweep", async () => {
      const { svc, findMany, sendCommand } = make({ dbRows: [{ id: "a" }, { id: "b" }] });
      findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
      // Both dbs resolve via findUnique to the enabled row; sendCommand for 'a' throws an unexpected error.
      sendCommand.mockRejectedValueOnce(new Error("boom"));
      await expect(svc.shipAll()).resolves.toBeUndefined();
    });
  });

  describe("shipOnce", () => {
    it("lists then ships over the 'backup' capability and counts shipped segments", async () => {
      const { svc, sendCommand, recover } = make({
        results: [
          { output: `WAL ${SEG1} 16777216\nWAL ${SEG2} 16777216\nTUGRA_WAL_LIST total=2`, exitCode: 0 },
          { output: `TUGRA_WAL_OK ${SEG1}\nTUGRA_WAL_OK ${SEG2}`, exitCode: 0 },
        ],
      });
      const r = await svc.shipOnce("db1");
      expect(r).toMatchObject({ shipped: 2, failed: 0, backlog: 0 });
      expect(sendCommand.mock.calls[0][2]).toBe("backup"); // list capability
      expect(sendCommand.mock.calls[1][2]).toBe("backup"); // ship capability
      expect(sendCommand.mock.calls[0][1]).toContain("TUGRA_WAL_LIST"); // list script
      expect(recover).toHaveBeenCalledWith("walship", "db1", "t1", expect.anything()); // clean drain
    });

    it("skips a database that is not PITR-enabled / not stamped / not Postgres (no agent call)", async () => {
      for (const over of [{ pitrEnabled: false }, { pitrEnabledAt: null }, { engine: "MYSQL" }]) {
        const { svc, sendCommand } = make({ dbOverride: over });
        const r = await svc.shipOnce("db1");
        expect(r.skipped).toBe(true);
        expect(sendCommand).not.toHaveBeenCalled();
      }
    });

    it("is a clean no-op when the spool is empty (recover, no ship command)", async () => {
      const { svc, sendCommand, recover } = make({ results: [{ output: "TUGRA_WAL_LIST total=0", exitCode: 0 }] });
      const r = await svc.shipOnce("db1");
      expect(r).toMatchObject({ shipped: 0, backlog: 0 });
      expect(sendCommand).toHaveBeenCalledTimes(1); // only the list, never a ship
      expect(recover).toHaveBeenCalledWith("walship", "db1", "t1", expect.anything());
    });

    it("swallows an offline agent into {skipped} (never retry-spams the sweep)", async () => {
      const { svc, recover, fireForEvent } = make({ results: [new AgentOfflineException()] });
      const r = await svc.shipOnce("db1");
      expect(r.skipped).toBe(true);
      expect(recover).not.toHaveBeenCalled();
      expect(fireForEvent).not.toHaveBeenCalled();
    });

    it("swallows a 'capability not granted' Forbidden into {skipped}", async () => {
      const { svc } = make({ results: [new ForbiddenException("capability not granted")] });
      expect((await svc.shipOnce("db1")).skipped).toBe(true);
    });

    it("on a partial failure alerts backup_failed with the db password SCRUBBED from the tail", async () => {
      const { svc, shouldNotifyFailure, fireForEvent } = make({
        results: [
          { output: `WAL ${SEG1} 1\nWAL ${SEG2} 1\nTUGRA_WAL_LIST total=2`, exitCode: 0 },
          // ship command fails on SEG2 and leaks the password into stderr
          { output: `TUGRA_WAL_OK ${SEG1}\nmc: auth failed for s3cr3tPassw0rd\nTUGRA_WAL_FAIL ${SEG2}`, exitCode: 1 },
        ],
      });
      const r = await svc.shipOnce("db1");
      expect(r).toMatchObject({ shipped: 1, failed: 1 });
      expect(shouldNotifyFailure).toHaveBeenCalledWith("walship", "db1");
      const ctx = fireForEvent.mock.calls[0][2];
      expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.anything());
      expect(ctx.errorTail).not.toContain("s3cr3tPassw0rd");
      expect(ctx.errorTail).toContain("<redacted>");
    });

    it("alerts when the backlog stays high even if the tick itself did not fail", async () => {
      const { svc, shouldNotifyFailure, fireForEvent, recover } = make({
        results: [
          { output: `WAL ${SEG1} 1\nTUGRA_WAL_LIST total=5000`, exitCode: 0 },
          { output: `TUGRA_WAL_OK ${SEG1}`, exitCode: 0 },
        ],
      });
      const r = await svc.shipOnce("db1");
      expect(r.backlog).toBe(4999);
      expect(shouldNotifyFailure).toHaveBeenCalledWith("walship", "db1");
      expect(fireForEvent).toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
    });

    it("never touches the logical backup / base-backup tables (coexistence)", async () => {
      const { svc, backup, baseBackup } = make({
        results: [
          { output: `TUGRA_WAL_LIST total=0`, exitCode: 0 },
        ],
      });
      await svc.shipOnce("db1");
      for (const fn of [...Object.values(backup), ...Object.values(baseBackup)]) expect(fn).not.toHaveBeenCalled();
    });

    it("treats a non-zero ship exit with NO fail marker (killed / truncated output) as a failure", async () => {
      const { svc, shouldNotifyFailure, fireForEvent } = make({
        results: [
          { output: `WAL ${SEG1} 1\nTUGRA_WAL_LIST total=1`, exitCode: 0 },
          { output: "", exitCode: 137 }, // SIGKILL, no TUGRA_WAL_OK/FAIL line at all
        ],
      });
      const r = await svc.shipOnce("db1");
      expect(r.shipped).toBe(0);
      expect(shouldNotifyFailure).toHaveBeenCalledWith("walship", "db1");
      expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.anything());
    });

    it("alerts (throttled) on a shipping TIMEOUT instead of skipping silently (a hung upload grows the spool)", async () => {
      const { svc, shouldNotifyFailure, fireForEvent } = make({ results: [new AgentCommandTimeoutException()] });
      const r = await svc.shipOnce("db1");
      expect(r.skipped).toBe(true);
      expect(shouldNotifyFailure).toHaveBeenCalledWith("walship", "db1");
      expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.objectContaining({ errorTail: expect.stringContaining("timed out") }));
    });

    it("releases the inflight lock when destination resolution throws, so the NEXT tick retries (not stuck-skipped)", async () => {
      const { svc, sendCommand } = make({ destRejectOnce: true, results: [{ output: "TUGRA_WAL_LIST total=0", exitCode: 0 }] });
      await expect(svc.shipOnce("db1")).rejects.toThrow(); // 1st tick: dest decrypt throws → propagates
      const r = await svc.shipOnce("db1"); // 2nd tick on the SAME instance: dest now resolves
      expect(sendCommand).toHaveBeenCalled(); // reached the list command → the lock was released, not leaked
      expect(r.skipped).toBeUndefined();
    });

    it("surfaces an all-invalid spool as backlog (not a clean drain) so it never reads as healthy", async () => {
      const { svc, recover } = make({
        results: [{ output: `WAL evilname 1\nWAL ../x 1\nTUGRA_WAL_LIST total=2`, exitCode: 0 }],
      });
      const r = await svc.shipOnce("db1");
      expect(r.backlog).toBe(2); // two foreign/invalid files are dropped by the allow-list but still occupy the spool
      expect(recover).not.toHaveBeenCalled();
    });

    it("an UNREADABLE spool list (non-zero exit or no summary marker) is backlog UNKNOWN (-1, skipped) — never 'empty'", async () => {
      // a wrong "empty" here would let the PITR disable path purge an un-shipped spool
      for (const list of [
        { output: "", exitCode: 1 },
        { output: `WAL ${SEG1} 1`, exitCode: 0 }, // truncated: entries but no TUGRA_WAL_LIST marker
      ]) {
        const { svc, sendCommand, recover } = make({ results: [list] });
        const r = await svc.shipOnce("db1");
        expect(r).toMatchObject({ backlog: -1, skipped: true });
        expect(sendCommand).toHaveBeenCalledTimes(1); // no ship command on an unknown backlog
        expect(recover).not.toHaveBeenCalled();
      }
    });
  });
});
