import { UpdaterService, buildUpdateJob, mapStatus, mapHalfState, isTerminalPhase, UPDATE_HALF_STATE_KEY } from "./updater.service";
import type { RedisService } from "../redis/redis.service";
import type { LatestEntryResult, UpdateService } from "./update.service";
import type { InFlightService } from "../in-flight/in-flight.service";
import type { InFlightItem } from "../in-flight/in-flight.dto";

function redisStub(lockAcquired = true) {
  const lpush = jest.fn().mockResolvedValue(1);
  const set = jest.fn().mockResolvedValue(undefined);
  const firstInWindow = jest.fn().mockResolvedValue(lockAcquired);
  const get = jest.fn().mockResolvedValue(null);
  const svc = { firstInWindow, set, get, client: { lpush } } as unknown as RedisService;
  return { svc, lpush, set, firstInWindow, get };
}

function updateStub(verified: LatestEntryResult) {
  return { verifyLatestEntry: jest.fn().mockResolvedValue(verified) } as unknown as UpdateService;
}

const noWork = { list: jest.fn().mockResolvedValue([]) } as unknown as InFlightService;
const work = (items: InFlightItem[]) => ({ list: jest.fn().mockResolvedValue(items) }) as unknown as InFlightService;
const RUN: InFlightItem = { kind: "migration-run", id: "run1", label: "coolify.example.com", serverIds: ["s1"], teamId: "t1", since: "2026-11-27T10:00:00.000Z" };

const NO_DETAIL = { code: null, needBytes: null, haveBytes: null, path: null };

const savedVersion = process.env.TUGRA_VERSION;
beforeEach(() => {
  process.env.TUGRA_VERSION = "1.2.3"; // the running build
});
afterEach(() => {
  if (savedVersion === undefined) delete process.env.TUGRA_VERSION;
  else process.env.TUGRA_VERSION = savedVersion;
});

describe("UpdaterService.requestUpdate", () => {
  it("returns unconfigured and takes no lock when the check is unconfigured", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "unconfigured" }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "unconfigured", targetVersion: null });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("returns error when the manifest fails to verify", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "error", reason: "bad signature" }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "error", targetVersion: null });
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("DOWNGRADE GUARD: returns up-to-date (no queue) when latest is not newer than the running build", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.3" } }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "up-to-date", targetVersion: "1.2.3" });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("refuses to skip past a required intermediate (needs-intermediate)", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "2.0.0", minUpgradeFrom: "1.5.0" } }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "needs-intermediate", targetVersion: "2.0.0" });
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("FAIL-SAFE: a present-but-unparseable minUpgradeFrom refuses (needs-intermediate), never skips the bridge", async () => {
    const r = redisStub();
    // "v1.9" (leading v, no patch) is a publisher typo parseVersion rejects; must NOT fail open to a direct jump.
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "2.0.0", minUpgradeFrom: "v1.9" } }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "needs-intermediate", targetVersion: "2.0.0" });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("AUTO declines a non-patch bump (notify-only, no lock/queue)", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.3.0" } }), noWork);
    expect(await svc.requestUpdate({ actor: "scheduler", auto: true })).toEqual({ status: "notify-only", targetVersion: "1.3.0" });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("AUTO applies a patch bump — takes the lock + queues the job", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4" } }), noWork);
    expect(await svc.requestUpdate({ actor: "scheduler", auto: true })).toEqual({ status: "started", targetVersion: "1.2.4" });
    expect(r.firstInWindow).toHaveBeenCalledWith("instance:update:lock", 900);
    expect(r.set).toHaveBeenCalled();
    expect(r.lpush).toHaveBeenCalledWith("instance:update:queue", expect.stringContaining("1.2.4"));
  });

  describe("AUTO on a prerelease build", () => {
    beforeEach(() => {
      process.env.TUGRA_VERSION = "0.1.0-beta.16";
    });

    it("AUTO applies beta.N -> beta.N+1 (same family) — takes the lock + queues", async () => {
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "beta", entry: { version: "0.1.0-beta.17" } }), noWork);
      expect(await svc.requestUpdate({ actor: "auto-update", auto: true })).toEqual({ status: "started", targetVersion: "0.1.0-beta.17" });
      expect(r.firstInWindow).toHaveBeenCalledWith("instance:update:lock", 900);
      expect(r.lpush).toHaveBeenCalledWith("instance:update:queue", expect.stringContaining("0.1.0-beta.17"));
    });

    it("AUTO declines beta -> stable (notify-only, no lock/queue)", async () => {
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "beta", entry: { version: "0.1.0" } }), noWork);
      expect(await svc.requestUpdate({ actor: "auto-update", auto: true })).toEqual({ status: "notify-only", targetVersion: "0.1.0" });
      expect(r.firstInWindow).not.toHaveBeenCalled();
      expect(r.lpush).not.toHaveBeenCalled();
    });

    it("AUTO declines beta -> rc (notify-only)", async () => {
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "beta", entry: { version: "0.1.0-rc.1" } }), noWork);
      expect(await svc.requestUpdate({ actor: "auto-update", auto: true })).toEqual({ status: "notify-only", targetVersion: "0.1.0-rc.1" });
      expect(r.lpush).not.toHaveBeenCalled();
    });

    it("MANUAL still applies beta -> stable (explicit consent)", async () => {
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "beta", entry: { version: "0.1.0" } }), noWork);
      expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "started", targetVersion: "0.1.0" });
    });
  });

  it("MANUAL applies a minor bump (explicit consent) — queues the job", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.3.0" } }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "started", targetVersion: "1.3.0" });
    expect(r.lpush).toHaveBeenCalled();
  });

  describe("queue job shape (digest-pinned updates)", () => {
    const H = "a".repeat(64);
    const W = "b".repeat(64);
    const queued = (r: ReturnType<typeof redisStub>) => JSON.parse(r.lpush.mock.calls[0][1] as string) as Record<string, unknown>;

    it("queues {targetVersion, hubDigest, webDigest} when the verified entry carries BOTH digests", async () => {
      const r = redisStub();
      const entry = { version: "1.2.4", imageDigests: { hub: H, web: W, updater: "c".repeat(64), agent: "d".repeat(64) } };
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry }), noWork);
      expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "started", targetVersion: "1.2.4" });
      expect(r.lpush).toHaveBeenCalledWith("instance:update:queue", expect.any(String));
      // exactly the three flat string fields the grep-based sidecar parser reads (no updater/agent digests)
      expect(queued(r)).toEqual({ targetVersion: "1.2.4", hubDigest: H, webDigest: W });
    });

    it("queues the legacy {targetVersion} when the entry has no imageDigests (old manifest)", async () => {
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4" } }), noWork);
      await svc.requestUpdate({ actor: "u1", auto: false });
      expect(queued(r)).toEqual({ targetVersion: "1.2.4" });
    });

    it("queues the legacy job for a PARTIAL digest pair (never half-pins)", async () => {
      for (const imageDigests of [{ hub: H }, { web: W }, { updater: H, agent: W }]) {
        const r = redisStub();
        const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4", imageDigests } }), noWork);
        await svc.requestUpdate({ actor: "u1", auto: false });
        expect(queued(r)).toEqual({ targetVersion: "1.2.4" });
      }
    });

    it("adds hostFilesDigest (and only the digest, never file content) when the verified entry carries it", async () => {
      const F = "f".repeat(64);
      for (const [entry, expected] of [
        [{ version: "1.2.4", hostFilesDigest: F }, { targetVersion: "1.2.4", hostFilesDigest: F }],
        [{ version: "1.2.4", imageDigests: { hub: H, web: W }, hostFilesDigest: F }, { targetVersion: "1.2.4", hubDigest: H, webDigest: W, hostFilesDigest: F }],
      ] as const) {
        const r = redisStub();
        const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { ...entry } }), noWork);
        await svc.requestUpdate({ actor: "u1", auto: false });
        expect(queued(r)).toEqual(expected);
      }
    });

    it("an entry without hostFilesDigest (older release) queues no host-files key at all", async () => {
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4", imageDigests: { hub: H, web: W } } }), noWork);
      await svc.requestUpdate({ actor: "u1", auto: false });
      expect("hostFilesDigest" in queued(r)).toBe(false);
    });

    it("carries the signed per-platform AGENT digests so the sidecar can pull the local agent by digest (well-formed ones only)", async () => {
      const AMD = "1".repeat(64);
      const ARM = "2".repeat(64);
      const r = redisStub();
      const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4", agentSha256: { amd64: AMD, arm64: ARM } } }), noWork);
      await svc.requestUpdate({ actor: "u1", auto: false });
      expect(queued(r)).toEqual({ targetVersion: "1.2.4", agentAmd64Digest: AMD, agentArm64Digest: ARM });
      expect(buildUpdateJob("1.2.4", undefined, undefined, { amd64: AMD, arm64: "sha256:not-bare" })).toEqual({ targetVersion: "1.2.4", agentAmd64Digest: AMD });
      expect(buildUpdateJob("1.2.4", undefined, undefined, { riscv: AMD })).toEqual({ targetVersion: "1.2.4" });
      expect("agentAmd64Digest" in buildUpdateJob("1.2.4")).toBe(false); // an older manifest queues the legacy job exactly as before
    });

    it("buildUpdateJob is pure and does not add digest keys for an absent pair", () => {
      expect(buildUpdateJob("1.0.0")).toEqual({ targetVersion: "1.0.0" });
      expect("hubDigest" in buildUpdateJob("1.0.0", { hub: H })).toBe(false);
      expect(buildUpdateJob("1.0.0", { hub: H, web: W })).toEqual({ targetVersion: "1.0.0", hubDigest: H, webDigest: W });
    });
  });

  it("returns in-progress and does NOT queue a second job when the lock is held", async () => {
    const r = redisStub(false); // lock not acquired
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4" } }), noWork);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "in-progress", targetVersion: "1.2.4" });
    expect(r.lpush).not.toHaveBeenCalled();
  });
});

describe("getProgress + pure helpers", () => {
  it("getProgress maps the Redis status blob", async () => {
    const r = redisStub();
    r.get.mockResolvedValue(JSON.stringify({ phase: "pulling", targetVersion: "1.2.4" }));
    const svc = new UpdaterService(r.svc, updateStub({ status: "unconfigured" }), noWork);
    expect(await svc.getProgress()).toEqual({ phase: "pulling", targetVersion: "1.2.4", error: null, ...NO_DETAIL });
  });

  it("getProgress carries the failure's cause and the disk numbers the sidecar measured", async () => {
    const r = redisStub();
    r.get.mockResolvedValue(
      JSON.stringify({
        phase: "failed",
        targetVersion: "1.2.4",
        error: "not enough free disk space: needs about 20.0 GB free on /var/lib/docker, has 5.0 GB. Free some space, then retry",
        code: "disk_space",
        needBytes: 21474836480,
        haveBytes: 5368709120,
        path: "/var/lib/docker",
      }),
    );
    const svc = new UpdaterService(r.svc, updateStub({ status: "unconfigured" }), noWork);
    expect(await svc.getProgress()).toEqual({
      phase: "failed",
      targetVersion: "1.2.4",
      error: "not enough free disk space: needs about 20.0 GB free on /var/lib/docker, has 5.0 GB. Free some space, then retry",
      code: "disk_space",
      needBytes: 21474836480,
      haveBytes: 5368709120,
      path: "/var/lib/docker",
    });
  });

  it("mapStatus drops detail fields of the wrong type (a hand-written status can not smuggle objects into the stream)", () => {
    expect(mapStatus(JSON.stringify({ phase: "failed", code: { a: 1 }, needBytes: "12", haveBytes: -5, path: 7 }))).toEqual({
      phase: "failed",
      targetVersion: null,
      error: null,
      ...NO_DETAIL,
    });
  });

  it("getHalfUpdate reads the sidecar's marker and reports THIS hub's version as the running one", async () => {
    const r = redisStub();
    r.get.mockImplementation(async (k: string) => (k === UPDATE_HALF_STATE_KEY ? JSON.stringify({ envVersion: "1.2.4", runningVersion: "1.2.0" }) : null));
    const svc = new UpdaterService(r.svc, updateStub({ status: "unconfigured" }), noWork);
    expect(await svc.getHalfUpdate()).toEqual({ envVersion: "1.2.4", runningVersion: "1.2.3" }); // appVersion() = 1.2.3 in this spec
  });

  it("mapHalfState ignores an absent, garbled or STALE marker (the hub already runs the version .env names)", () => {
    expect(mapHalfState(null, "1.2.3")).toBeNull();
    expect(mapHalfState("{nope", "1.2.3")).toBeNull();
    expect(mapHalfState(JSON.stringify({ envVersion: 4 }), "1.2.3")).toBeNull();
    expect(mapHalfState(JSON.stringify({ envVersion: "not-a-version", runningVersion: "1.2.3" }), "1.2.3")).toBeNull();
    expect(mapHalfState(JSON.stringify({ envVersion: "1.2.3", runningVersion: "1.2.0" }), "1.2.3")).toBeNull(); // caught up
    expect(mapHalfState(JSON.stringify({ envVersion: "1.2.2", runningVersion: "1.2.0" }), "1.2.3")).toBeNull(); // older than what runs
    expect(mapHalfState(JSON.stringify({ envVersion: "1.3.0", runningVersion: "1.2.0" }), "1.2.3")).toEqual({ envVersion: "1.3.0", runningVersion: "1.2.3" });
  });

  it("mapStatus falls back to idle for absent/garbage/unknown-phase input", () => {
    expect(mapStatus(null)).toEqual({ phase: "idle", targetVersion: null, error: null, ...NO_DETAIL });
    expect(mapStatus("{not json")).toEqual({ phase: "idle", targetVersion: null, error: null, ...NO_DETAIL });
    expect(mapStatus(JSON.stringify({ phase: "bogus" }))).toMatchObject({ phase: "idle" });
    expect(mapStatus(JSON.stringify({ phase: "failed", error: "boom" }))).toEqual({ phase: "failed", targetVersion: null, error: "boom", ...NO_DETAIL });
    // recovery_required is a recognised phase (must NOT fall back to idle — that would hide an unrecovered stack)
    expect(mapStatus(JSON.stringify({ phase: "recovery_required", targetVersion: "0.2.0", error: "recover manually" }))).toEqual({
      phase: "recovery_required",
      targetVersion: "0.2.0",
      error: "recover manually",
      ...NO_DETAIL,
    });
  });

  it("isTerminalPhase is true for done/failed/recovery_required", () => {
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("recovery_required")).toBe(true); // the SSE must complete here, not hang
    expect(isTerminalPhase("pulling")).toBe(false);
    expect(isTerminalPhase("idle")).toBe(false);
  });
});

describe("UpdaterService.requestUpdate while work is in flight", () => {
  const verified = (): LatestEntryResult => ({ status: "ok", channel: "stable", entry: { version: "1.2.4" } });

  it("answers held with the list, takes no lock and queues nothing", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub(verified()), work([RUN]));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "held", targetVersion: "1.2.4", inFlight: [RUN] });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("holds an automatic update the same way", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub(verified()), work([RUN]));
    expect(await svc.requestUpdate({ actor: "auto-update", auto: true })).toMatchObject({ status: "held", inFlight: [RUN] });
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("force queues the update anyway and returns what it went over", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub(verified()), work([RUN]));
    expect(await svc.requestUpdate({ actor: "u1", auto: false, force: true })).toEqual({ status: "started", targetVersion: "1.2.4", overridden: [RUN] });
    expect(r.lpush).toHaveBeenCalledTimes(1);
  });

  it("an up-to-date hub is never reported as held", async () => {
    const r = redisStub();
    const inFlight = work([RUN]);
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.3" } }), inFlight);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "up-to-date", targetVersion: "1.2.3" });
    expect(inFlight.list).not.toHaveBeenCalled();
  });

  it("does not update blind: an unreadable in-flight state is an error, unless forced", async () => {
    const r = redisStub();
    const broken = { list: jest.fn().mockRejectedValue(new Error("db down")) } as unknown as InFlightService;
    const svc = new UpdaterService(r.svc, updateStub(verified()), broken);
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "error", targetVersion: "1.2.4" });
    expect(r.lpush).not.toHaveBeenCalled();
    expect(await svc.requestUpdate({ actor: "u1", auto: false, force: true })).toEqual({ status: "started", targetVersion: "1.2.4" });
  });

  it("records, reads and clears the hold; the first record keeps its start time", async () => {
    const store = new Map<string, string>();
    const redis = {
      set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
      get: jest.fn(async (k: string) => store.get(k) ?? null),
      del: jest.fn(async (k: string) => void store.delete(k)),
    } as unknown as RedisService;
    const svc = new UpdaterService(redis, updateStub(verified()), noWork);
    expect(await svc.getHold()).toBeNull();
    await svc.recordHold([RUN]);
    const first = await svc.getHold();
    expect(first?.items).toEqual([RUN]);
    await svc.recordHold([RUN, { ...RUN, id: "run2" }]);
    const second = await svc.getHold();
    expect(second?.since).toBe(first?.since);
    expect(second?.items).toHaveLength(2);
    await svc.clearHold();
    expect(await svc.getHold()).toBeNull();
  });

  it("bookkeeping never throws (a Redis error is logged, not raised)", async () => {
    const redis = { set: jest.fn().mockRejectedValue(new Error("down")), get: jest.fn().mockRejectedValue(new Error("down")), del: jest.fn().mockRejectedValue(new Error("down")) } as unknown as RedisService;
    const svc = new UpdaterService(redis, updateStub(verified()), noWork);
    await expect(svc.recordHold([RUN])).resolves.toBeUndefined();
    await expect(svc.clearHold()).resolves.toBeUndefined();
    await expect(svc.getHold()).resolves.toBeNull();
  });
});
