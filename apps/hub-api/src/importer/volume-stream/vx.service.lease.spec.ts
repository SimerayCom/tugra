import { createHash } from "node:crypto";
import { harness } from "./testing/vx-harness";
import { APP_VOL_REF, GiB, OP, RUN } from "./testing/vx-fixtures";
import { vxPartRawBytes } from "./vx-constants";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const R = vxPartRawBytes();
const ctxOp = { opId: OP, actorId: "user-1", expiresAt: new Date(Date.now() + 1_800_000) };
const fp = { containerId: "c".repeat(64), startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-14T10:00:00Z", exitCode: 0, mountType: "volume" as const, mountName: "5f3a9c_data", imageId: "sha256:img1" };
const beginBody = () => ({ runId: RUN, partRawBytes: R, rawTotal: 5 * GiB, fingerprint: fp });
function mkPart(raw: number, seed: string) {
  const member = Buffer.from(`member-${seed}-`.repeat(50));
  return { rawLen: raw, rawSha256: sha(`raw-${seed}`), size: member.length, sha256: sha(member), member };
}
const partBody = (p: ReturnType<typeof mkPart>, rawOffset: number) => ({ runId: RUN, rawOffset, rawLen: p.rawLen, rawSha256: p.rawSha256, size: p.size, sha256: p.sha256 });

afterEach(() => {
  jest.useRealTimers();
  delete process.env.MIGRATION_VX_STALE_MS;
});

describe("the part lease of a streamed copy (a slow link must not lose a part)", () => {
  it("registering a part renews the lease, so a part that starts late in the stale window is not taken over", async () => {
    process.env.MIGRATION_VX_STALE_MS = "30000";
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    const old = new Date(Date.now() - 25_000);
    h.transfers.rows[0].lastBeatAt = old;
    await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(mkPart(R, "a"), 0));
    expect((h.transfers.rows[0].lastBeatAt as Date).getTime()).toBeGreaterThan(old.getTime() + 20_000);
    // another run cannot claim it now: the lease is fresh
    await expect(h.svc.begin(ctxOp, APP_VOL_REF, { ...beginBody(), runId: "run_taker_00001" })).rejects.toThrow(/another migrator run is active/);
  });

  it("a rejected register (wrong run) never renews anything", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    const old = new Date(Date.now() - 25_000);
    h.transfers.rows[0].lastBeatAt = old;
    await expect(h.svc.registerPart(ctxOp, APP_VOL_REF, 0, { ...partBody(mkPart(R, "a"), 0), runId: "run_other_00009" })).rejects.toBeTruthy();
    expect(h.transfers.rows[0].lastBeatAt).toBe(old);
  });

  it("the relay reports the bytes the source has pushed so far", async () => {
    const h = harness();
    await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
    const p = mkPart(R, "a");
    const reg = (await h.svc.registerPart(ctxOp, APP_VOL_REF, 0, partBody(p, 0))) as { srcPath: string };
    const inflight = h.registry.get(String(h.transfers.rows[0].id))!;
    expect(inflight.reg.progress!()).toBe(0);
    const commit = h.svc.commitPart(ctxOp, APP_VOL_REF, 0, { runId: RUN });
    await h.put(reg.srcPath, p.member);
    await commit;
    expect(inflight.reg.progress!()).toBe(p.size);
  });

  describe("the relay watcher", () => {
    const watch = async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
      process.env.MIGRATION_VX_STALE_MS = "40000"; // a 10 s watch interval
      const h = harness();
      await h.svc.begin(ctxOp, APP_VOL_REF, beginBody());
      const t = h.transfers.rows[0];
      let bytes = 0;
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      (h.svc as unknown as { watchRelayProgress: (t: unknown, r: unknown) => void }).watchRelayProgress({ id: t.id, runId: t.runId }, { done, progress: () => bytes });
      const stamp = (ms: number) => {
        t.lastBeatAt = new Date(Date.now() - ms);
        return t.lastBeatAt as Date;
      };
      return { h, t, stamp, push: (n: number) => (bytes += n), finish };
    };

    it("renews the lease while bytes keep arriving", async () => {
      const w = await watch();
      const before = w.stamp(30_000);
      w.push(1_000_000);
      await jest.advanceTimersByTimeAsync(10_500);
      expect((w.t.lastBeatAt as Date).getTime()).toBeGreaterThan(before.getTime());
    });

    it("does not renew a stalled part: no new bytes, the lease goes stale as before", async () => {
      const w = await watch();
      const before = w.stamp(30_000);
      await jest.advanceTimersByTimeAsync(35_000);
      expect(w.t.lastBeatAt).toBe(before);
    });

    it("stops with the part", async () => {
      const w = await watch();
      w.finish();
      await jest.advanceTimersByTimeAsync(1);
      const before = w.stamp(30_000);
      w.push(5);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(w.t.lastBeatAt).toBe(before);
    });

    it("never revives a lease the run no longer holds", async () => {
      const w = await watch();
      const before = w.stamp(30_000);
      w.t.runId = "run_taker_00001";
      w.push(10);
      await jest.advanceTimersByTimeAsync(10_500);
      expect(w.t.lastBeatAt).toBe(before);
    });
  });
});
