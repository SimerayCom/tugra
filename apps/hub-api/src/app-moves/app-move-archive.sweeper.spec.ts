import { AppMoveArchiveSweeper } from "./app-move-archive.sweeper";
import { archiveVolumeNames, hasKeptSnapshots, purgeMoveSource, retryTargetCleanup, targetLeftovers } from "./app-move-archive";

const MVID = "ckmoveabcdefghijklmnopqrs";
const vol = (over: Record<string, unknown> = {}) => ({ name: "data", dockerName: "tugra_appv_capp_data", kind: "app", state: "APPLIED", createdOnTarget: true, archiveOverwritten: false, ...over });
const move = (over: Record<string, unknown> = {}) => ({
  id: MVID, appId: "capp", phase: "COMPLETED", sourceServerId: "s1", targetServerId: "s2", volumes: [vol()], archiveUntil: new Date(Date.now() - 1000), sourcePurgedAt: null, targetPurgedAt: null, ...over,
});
const removed = (...names: string[]) => `${names.map((n) => `TUGRA_VX_VOL ${n} removed`).join("\n")}\nTUGRA_VX_CLEANUP_DONE\n`;

function make(opts: { moves?: Record<string, unknown>[]; appServer?: string | null; otherLive?: boolean; online?: Record<string, boolean>; out?: { exitCode: number; output: string } | Error } = {}) {
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const sent: { server: string; script: string }[] = [];
  const all = opts.moves ?? [move()];
  const prisma = {
    appMove: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => all.filter((m) => (where.phase === m.phase) && (where.sourcePurgedAt === null ? m.sourcePurgedAt === null : true) && (where.targetPurgedAt === null ? m.targetPurgedAt === null : true))),
      findFirst: jest.fn(async () => (opts.otherLive ? { id: "other" } : null)),
      update: jest.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => void updates.push({ id: a.where.id, ...a })),
    },
    application: { findUnique: jest.fn(async () => (opts.appServer === null ? null : { serverId: opts.appServer ?? "s2" })) },
  };
  const online = opts.online ?? { s1: true, s2: true };
  const agentWs = {
    isOnline: (id: string) => online[id] ?? false,
    sendCommand: jest.fn(async (server: string, script: string) => {
      sent.push({ server, script });
      if (opts.out instanceof Error) throw opts.out;
      return opts.out ?? { exitCode: 0, output: removed("tugra_appv_capp_data") };
    }),
  };
  return { prisma, agentWs, updates, sent, sweeper: new AppMoveArchiveSweeper(prisma as never, agentWs as never) };
}

describe("archive helpers", () => {
  it("only APPLIED volumes with safe names are archive volumes; targetLeftovers is label-driven (not createdOnTarget) and excludes overwritten archives", () => {
    const vols = [vol(), vol({ name: "b", dockerName: "tugra_appv_capp_b", state: "SKIPPED" }), vol({ name: "c", dockerName: "bad;name" }), vol({ name: "d", dockerName: "tugra_appv_capp_d", createdOnTarget: false, archiveOverwritten: true })];
    expect(archiveVolumeNames({ volumes: vols } as never)).toEqual(["tugra_appv_capp_data", "tugra_appv_capp_d"]);
    expect(targetLeftovers({ id: MVID, volumes: vols } as never)).toEqual({
      removeVolumes: ["tugra_appv_capp_data"],
      removeRollbackFor: [`${MVID}_0`, `${MVID}_2`, `${MVID}_3`],
    });
    expect(archiveVolumeNames({ volumes: null } as never)).toEqual([]);
  });

  it("a prepare that died halfway (createdOnTarget never recorded) still has its labelled volumes cleaned", () => {
    const vols = [vol({ state: "PENDING", createdOnTarget: false }), vol({ name: "e", dockerName: "tugra_appv_capp_e", state: "PENDING", createdOnTarget: false })];
    expect(targetLeftovers({ id: MVID, volumes: vols } as never).removeVolumes).toEqual(["tugra_appv_capp_data", "tugra_appv_capp_e"]);
  });

  it("a kept apply rollback snapshot is excluded from automatic cleanup and only included for an explicit purge", () => {
    const vols = [vol(), vol({ name: "e", dockerName: "tugra_appv_capp_e", rollbackKept: true })];
    expect(targetLeftovers({ id: MVID, volumes: vols } as never).removeRollbackFor).toEqual([`${MVID}_0`]);
    expect(targetLeftovers({ id: MVID, volumes: vols } as never, { includeKept: true }).removeRollbackFor).toEqual([`${MVID}_0`, `${MVID}_1`]);
    expect(hasKeptSnapshots({ volumes: vols } as never)).toBe(true);
    expect(hasKeptSnapshots({ volumes: [vol()] } as never)).toBe(false);
  });
});

describe("AppMoveArchiveSweeper.sweep", () => {
  it("purges a due archive on the SOURCE host after archiveUntil and stamps sourcePurgedAt", async () => {
    const t = make();
    expect(await t.sweeper.sweep()).toEqual({ [MVID]: "archive:purged" });
    expect(t.sent).toEqual([{ server: "s1", script: expect.stringContaining("docker volume rm 'tugra_appv_capp_data'") }]);
    expect(t.updates).toEqual([expect.objectContaining({ id: MVID, data: { sourcePurgedAt: expect.any(Date) } })]);
  });

  it("only moves whose archiveUntil has passed are due (the query), and an unpurged one is not touched early", async () => {
    const t = make({ moves: [] });
    await t.sweeper.sweep(new Date("2026-11-20T00:00:00Z"));
    const where = t.prisma.appMove.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({ phase: "COMPLETED", sourcePurgedAt: null, archiveUntil: { lt: new Date("2026-11-20T00:00:00Z") } });
  });

  it("GUARD: the app runs on the archive's server again (a move back) -> nothing removed, the row is stamped so it is never retried", async () => {
    const t = make({ appServer: "s1" });
    expect(await t.sweeper.sweep()).toEqual({ [MVID]: "archive:skipped_live" });
    expect(t.sent).toEqual([]);
    expect(t.updates).toEqual([expect.objectContaining({ data: { sourcePurgedAt: expect.any(Date) } })]);
  });

  it("GUARD: another live move targets/uses that server for the app -> nothing removed and NOT stamped (that move may still roll back)", async () => {
    for (const appServer of ["s2", "s1"]) {
      const t = make({ otherLive: true, appServer });
      expect(await t.sweeper.sweep()).toEqual({ [MVID]: "archive:skipped_live" });
      expect(t.sent).toEqual([]);
      expect(t.updates).toEqual([]);
    }
  });

  it("GUARD (target): a rolled-back/failed move's target that holds the app's live data, or is used by another live move, is never cleaned", async () => {
    const rb = move({ phase: "ROLLED_BACK", archiveUntil: null });
    const onTarget = make({ moves: [rb], appServer: "s2" });
    expect(await onTarget.sweeper.sweep()).toEqual({ [MVID]: "target:skipped_live" });
    expect(onTarget.sent).toEqual([]);
    const busy = make({ moves: [rb], appServer: "s1", otherLive: true });
    expect(await busy.sweeper.sweep()).toEqual({ [MVID]: "target:skipped_live" });
    expect(busy.sent).toEqual([]);
  });

  it("an offline source is retried next tick (no stamp)", async () => {
    const t = make({ online: { s1: false, s2: true } });
    expect(await t.sweeper.sweep()).toEqual({ [MVID]: "archive:offline" });
    expect(t.sent).toEqual([]);
    expect(t.updates).toEqual([]);
  });

  it("a volume docker refused to remove (in use) is partial: not stamped, retried; an agent error is failed (also retried)", async () => {
    const kept = make({ out: { exitCode: 0, output: "TUGRA_VX_VOL tugra_appv_capp_data kept\nTUGRA_VX_CLEANUP_DONE\n" } });
    expect(await kept.sweeper.sweep()).toEqual({ [MVID]: "archive:partial" });
    expect(kept.updates).toEqual([]);
    expect(await make({ out: new Error("timeout") }).sweeper.sweep()).toEqual({ [MVID]: "archive:failed" });
    expect(await make({ out: { exitCode: 1, output: "" } }).sweeper.sweep()).toEqual({ [MVID]: "archive:failed" });
    expect(await make({ out: { exitCode: 0, output: removed("tugra_appv_capp_data").replace("TUGRA_VX_CLEANUP_DONE", "") } }).sweeper.sweep()).toEqual({ [MVID]: "archive:partial" }); // truncated: no end marker
  });

  it("re-validates every recorded docker name: a tampered/unsafe name is never sent to a shell", async () => {
    const t = make({ moves: [move({ volumes: [vol({ dockerName: "x; rm -rf /" }), vol({ dockerName: "tugra_appv_capp_ok" })] })], out: { exitCode: 0, output: removed("tugra_appv_capp_ok") } });
    await t.sweeper.sweep();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].script).not.toContain("rm -rf /");
    expect(t.sent[0].script).toContain("tugra_appv_capp_ok");
  });

  it("a move with nothing transferred (no APPLIED volume) is just stamped", async () => {
    const t = make({ moves: [move({ volumes: [vol({ state: "SKIPPED" })] })] });
    expect(await t.sweeper.sweep()).toEqual({ [MVID]: "archive:nothing" });
    expect(t.sent).toEqual([]);
    expect(t.updates).toHaveLength(1);
  });

  it("the app being deleted does not stop the purge (no app row = nothing is live there)", async () => {
    const t = make({ appServer: null });
    expect(await t.sweeper.sweep()).toEqual({ [MVID]: "archive:purged" });
  });

  it("ROLLED_BACK leftovers on the target are retried (label-checked cleanup) and stamped when fully gone", async () => {
    const rb = move({ phase: "ROLLED_BACK", targetPurgedAt: null, archiveUntil: null });
    const t = make({ moves: [rb], appServer: "s1", out: { exitCode: 0, output: removed("tugra_appv_capp_data", `tugra_restore_rb_${MVID}_0`) } });
    expect(await t.sweeper.sweep()).toEqual({ [MVID]: "target:purged" });
    expect(t.sent[0].server).toBe("s2");
    expect(t.sent[0].script).toContain(`rm -rf /etc/tugra/app-moves/${MVID}`);
    expect(t.sent[0].script).toContain(`tugra.move`);
    expect(t.updates).toEqual([expect.objectContaining({ data: { targetPurgedAt: expect.any(Date) } })]);
  });

  it("a FAILED move is NEVER touched automatically (a human purges it)", async () => {
    const t = make({ moves: [move({ phase: "FAILED", archiveUntil: null })] });
    expect(await t.sweeper.sweep()).toEqual({});
    expect(t.sent).toEqual([]);
    expect(t.updates).toEqual([]);
  });

  it("a rolled-back move whose target is offline waits; leftovers in use stay un-stamped", async () => {
    const rb = move({ phase: "ROLLED_BACK", archiveUntil: null });
    expect(await make({ moves: [rb], appServer: "s1", online: { s1: true, s2: false } }).sweeper.sweep()).toEqual({ [MVID]: "target:offline" });
    const inUse = make({ moves: [rb], appServer: "s1", out: { exitCode: 0, output: `TUGRA_VX_VOL tugra_appv_capp_data kept\nTUGRA_VX_VOL tugra_restore_rb_${MVID}_0 absent\nTUGRA_VX_CLEANUP_DONE\n` } });
    expect(await inUse.sweeper.sweep()).toEqual({ [MVID]: "target:partial" });
    expect(inUse.updates).toEqual([]);
  });

  it("purgeMoveSource / retryTargetCleanup are the same code the endpoint and app deletion use (stampWhenLive false never stamps a live archive)", async () => {
    const t = make({ appServer: "s1" });
    expect(await purgeMoveSource(t as never, move() as never, { stampWhenLive: false })).toBe("skipped_live");
    expect(t.updates).toEqual([]);
    const u = make({ moves: [move({ phase: "FAILED" })], appServer: "s1", out: { exitCode: 0, output: removed("tugra_appv_capp_data", `tugra_restore_rb_${MVID}_0`) } });
    expect(await retryTargetCleanup(u as never, move({ phase: "FAILED" }) as never)).toBe("purged");
  });
});
