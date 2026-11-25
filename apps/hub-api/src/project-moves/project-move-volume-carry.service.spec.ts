import { ProjectMoveVolumeCarryService, VolumeCarryError } from "./project-move-volume-carry.service";

const MOVE = "cmproj0000000000000000001";
const SHA = "a".repeat(64);
const I = { moveId: MOVE, idx: 3, srcServerId: "s1", dstServerId: "s2", srcVolume: "tugra_dbv_d1_ext", dstVolume: "tugra_dbv_d1copy_ext" };

type Reply = { exitCode: number; output: string };
function make(o: { parts?: number; entries?: number; apply?: Reply; pack?: Reply; offlineOn?: "pack" | "stat" | "apply"; transfer?: Array<{ ok: true; bytes: number } | { ok: false; busy?: boolean; sendExit: number | null; recvExit: number | null; detail: string }> } = {}) {
  const sent: Array<{ server: string; script: string; cap: string }> = [];
  const parts = o.parts ?? 2;
  const entries = o.entries ?? 7;
  const agentWs = {
    sendCommand: jest.fn(async (server: string, script: string, cap: string): Promise<Reply> => {
      sent.push({ server, script, cap });
      const kind = script.includes("TUGRA_VX_PACKED") ? "pack" : script.includes("TUGRA_VX_APPLY_OK") ? "apply" : script.includes("TUGRA_VX_PART") ? "stat" : "other";
      if (o.offlineOn === kind) throw new Error("agent offline");
      if (kind === "pack") return o.pack ?? { exitCode: 0, output: `TUGRA_VX_PACKED parts=${parts} entries=${entries}` };
      if (kind === "stat") return { exitCode: 0, output: `TUGRA_VX_PART 1024 ${SHA}` };
      if (kind === "apply") return o.apply ?? { exitCode: 0, output: `TUGRA_VX_APPLY_OK entries=${entries}` };
      return { exitCode: 0, output: "" };
    }),
  };
  const queue = [...(o.transfer ?? [])];
  const transfers = { transfer: jest.fn(async () => queue.shift() ?? { ok: true as const, bytes: 1024 }) };
  const svc = new ProjectMoveVolumeCarryService(agentWs as never, transfers as never);
  svc.busyWaitMs = 0;
  return { svc, sent, agentWs, transfers };
}

describe("ProjectMoveVolumeCarryService", () => {
  it("packs on the source, relays every part with its size and sha256, applies on the target and clears the staging on both hosts", async () => {
    const t = make();
    await t.svc.carry(I);
    expect(t.transfers.transfer).toHaveBeenCalledTimes(2);
    expect(t.transfers.transfer).toHaveBeenNthCalledWith(1, { moveId: MOVE, idx: 3, part: 0, size: 1024, sha256: SHA, srcServerId: "s1", dstServerId: "s2" });
    expect(t.transfers.transfer).toHaveBeenNthCalledWith(2, expect.objectContaining({ part: 1 }));
    // the pack reads the source volume read-only on the source host; the apply replaces the TARGET volume on the target host
    const pack = t.sent.find((s) => s.script.includes("TUGRA_VX_PACKED"))!;
    expect(pack.server).toBe("s1");
    expect(pack.script).toContain("'tugra_dbv_d1_ext':/data:ro");
    const apply = t.sent.find((s) => s.script.includes("TUGRA_VX_APPLY_OK"))!;
    expect(apply.server).toBe("s2");
    expect(apply.script).toContain("tugra_dbv_d1copy_ext");
    expect(apply.script).not.toContain("tugra_dbv_d1_ext");
    // every command goes through the backup capability, and the staging directory is removed on both hosts
    expect(t.sent.every((s) => s.cap === "backup")).toBe(true);
    const cleanups = t.sent.filter((s) => s.script.includes("TUGRA_VX_CLEANUP_DONE"));
    expect(cleanups.map((c) => c.server).sort()).toEqual(["s1", "s2"]);
    // nothing removes a volume: the cleanup names none
    expect(cleanups.every((c) => !/docker volume rm/.test(c.script))).toBe(true);
  });

  it("a pack that fails ends the copy, and the staging is still cleared", async () => {
    const t = make({ pack: { exitCode: 67, output: "empty pack" } });
    await expect(t.svc.carry(I)).rejects.toMatchObject({ reason: "pack_failed" });
    expect(t.transfers.transfer).not.toHaveBeenCalled();
    expect(t.sent.filter((s) => s.script.includes("TUGRA_VX_CLEANUP_DONE"))).toHaveLength(2);
  });

  it("a busy relay seat waits and does not count against the part; three real failures end it without touching the target volume", async () => {
    const busy = make({ parts: 1, transfer: [{ ok: false, busy: true, sendExit: null, recvExit: null, detail: "relay busy" }, { ok: true, bytes: 1024 }] });
    await busy.svc.carry(I);
    expect(busy.transfers.transfer).toHaveBeenCalledTimes(2);
    const bad = { ok: false as const, sendExit: 1, recvExit: 66, detail: "sha mismatch" };
    const fail = make({ parts: 1, transfer: [bad, bad, bad] });
    await expect(fail.svc.carry(I)).rejects.toMatchObject({ reason: "transfer_failed" });
    expect(fail.transfers.transfer).toHaveBeenCalledTimes(3);
    expect(fail.sent.some((s) => s.script.includes("TUGRA_VX_APPLY_OK"))).toBe(false);
  });

  it("an entry count that does not match is a mismatch, whether the apply says so (68) or reports another count", async () => {
    await expect(make({ apply: { exitCode: 68, output: "entry count mismatch" } }).svc.carry(I)).rejects.toMatchObject({ reason: "entry_mismatch" });
    await expect(make({ apply: { exitCode: 0, output: "TUGRA_VX_APPLY_OK entries=99" } }).svc.carry(I)).rejects.toMatchObject({ reason: "entry_mismatch" });
    await expect(make({ apply: { exitCode: 71, output: "rolled back" } }).svc.carry(I)).rejects.toMatchObject({ reason: "apply_failed" });
  });

  it("an agent that is gone is an agent failure in each phase", async () => {
    for (const phase of ["pack", "stat", "apply"] as const) {
      const err = await make({ offlineOn: phase }).svc.carry(I).catch((e) => e);
      expect(err).toBeInstanceOf(VolumeCarryError);
      expect(err.reason).toBe("agent_offline");
    }
  });

  it("refuses names that could reach a shell before any command is sent", async () => {
    const t = make();
    await expect(t.svc.carry({ ...I, srcVolume: "x; rm -rf /" })).rejects.toThrow();
    expect(t.sent.some((s) => s.script.includes("x; rm"))).toBe(false); // the bad name never reached a script
    const before = t.sent.length;
    await expect(t.svc.carry({ ...I, moveId: "../etc" })).rejects.toThrow();
    expect(t.sent).toHaveLength(before); // a bad move id sends nothing at all
  });
});
