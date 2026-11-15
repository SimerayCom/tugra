import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AppMoveArchiveSweeper } from "../../app-moves/app-move-archive.sweeper";
import { AppMoveRecoveryService } from "../../app-moves/app-move-recovery.service";

/**
 * The migration volume stream stages its parts under `/etc/tugra/app-moves/<transferId>` — the SAME root app moves use.
 * That is only safe because nothing in the app-move machinery ever lists or sweeps that root: every cleanup is addressed
 * by an id taken from an `appMove` ROW. A transfer id is a cuid with no `appMove` row, so no app-move job can touch it.
 */
describe("the shared staging root is never swept by directory listing", () => {
  const DIR = join(__dirname, "../../app-moves");
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.includes("testing"));

  it("no app-move source lists, globs or recursively removes the staging root (only id-addressed paths)", () => {
    for (const f of files) {
      const src = readFileSync(join(DIR, f), "utf8");
      // a directory listing / glob / `find` over the root, or readdir of it
      expect(`${f}: ${src.match(/readdir(Sync)?\([^)]*app-moves/)?.[0] ?? ""}`).toBe(`${f}: `);
      expect(`${f}: ${src.match(/(ls|find)\s+[^\n]*(\/etc\/tugra\/app-moves|\$\{?MOVE_STAGING_ROOT)/)?.[0] ?? ""}`).toBe(`${f}: `);
      expect(`${f}: ${src.match(/rm\s+-rf\s+[^\n]*\/etc\/tugra\/app-moves\/?\s*['"`$]/)?.[0] ?? ""}`).toBe(`${f}: `);
      expect(`${f}: ${src.match(/rm\s+-rf\s+[^\n]*app-moves\/\*/)?.[0] ?? ""}`).toBe(`${f}: `);
    }
  });

  it("the sweeper and the recovery loop are driven ONLY by appMove rows: with no rows they send no command and touch nothing", async () => {
    const prisma = { appMove: { findMany: jest.fn().mockResolvedValue([]) } };
    const agentWs = { sendCommand: jest.fn(), isOnline: jest.fn().mockReturnValue(true) };
    const sweeper = new AppMoveArchiveSweeper(prisma as never, agentWs as never);
    expect(await sweeper.sweep()).toEqual({});
    expect(agentWs.sendCommand).not.toHaveBeenCalled();
    expect(prisma.appMove.findMany).toHaveBeenCalled();

    const lease = { bootId: "boot" };
    const runner = { isRunning: jest.fn(), run: jest.fn(), failNeedsAttention: jest.fn() };
    const recovery = new AppMoveRecoveryService(prisma as never, agentWs as never, lease as never, runner as never);
    expect(await recovery.recover()).toEqual([]);
    expect(runner.run).not.toHaveBeenCalled();
    expect(agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("every app-move cleanup the sweeper can issue names a move id from a row (a transfer cuid has none)", async () => {
    const row = { id: "ckmoverow00000000000000001", phase: "ROLLED_BACK", targetPurgedAt: null, targetServerId: "t", sourceServerId: "s", volumes: [] };
    const prisma = { appMove: { findMany: jest.fn().mockImplementation(async (a: { where: { phase?: string } }) => (a.where.phase === "ROLLED_BACK" ? [row] : [])), update: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_VX_CLEANUP_DONE\n" }), isOnline: jest.fn().mockReturnValue(true) };
    await new AppMoveArchiveSweeper(prisma as never, agentWs as never).sweep().catch(() => undefined);
    const TRANSFER = "cktransferabcdefghijklmnopq";
    for (const call of agentWs.sendCommand.mock.calls) {
      const script = String(call[1]);
      expect(script).not.toContain(TRANSFER);
      expect(script).not.toMatch(/app-moves\/?(\s|$|'|")/); // never the bare root
    }
  });
});
