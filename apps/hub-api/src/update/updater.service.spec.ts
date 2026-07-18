import { UpdaterService, mapStatus, isTerminalPhase } from "./updater.service";
import type { RedisService } from "../redis/redis.service";
import type { LatestEntryResult, UpdateService } from "./update.service";

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
    const svc = new UpdaterService(r.svc, updateStub({ status: "unconfigured" }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "unconfigured", targetVersion: null });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("returns error when the manifest fails to verify", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "error", reason: "bad signature" }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "error", targetVersion: null });
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("DOWNGRADE GUARD: returns up-to-date (no queue) when latest is not newer than the running build", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.3" } }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "up-to-date", targetVersion: "1.2.3" });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("refuses to skip past a required intermediate (needs-intermediate)", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "2.0.0", minUpgradeFrom: "1.5.0" } }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "needs-intermediate", targetVersion: "2.0.0" });
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("FAIL-SAFE: a present-but-unparseable minUpgradeFrom refuses (needs-intermediate), never skips the bridge", async () => {
    const r = redisStub();
    // "v1.9" (leading v, no patch) is a publisher typo parseVersion rejects; must NOT fail open to a direct jump.
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "2.0.0", minUpgradeFrom: "v1.9" } }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "needs-intermediate", targetVersion: "2.0.0" });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("AUTO declines a non-patch bump (notify-only, no lock/queue)", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.3.0" } }));
    expect(await svc.requestUpdate({ actor: "scheduler", auto: true })).toEqual({ status: "notify-only", targetVersion: "1.3.0" });
    expect(r.firstInWindow).not.toHaveBeenCalled();
    expect(r.lpush).not.toHaveBeenCalled();
  });

  it("AUTO applies a patch bump — takes the lock + queues the job", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4" } }));
    expect(await svc.requestUpdate({ actor: "scheduler", auto: true })).toEqual({ status: "started", targetVersion: "1.2.4" });
    expect(r.firstInWindow).toHaveBeenCalledWith("instance:update:lock", 900);
    expect(r.set).toHaveBeenCalled();
    expect(r.lpush).toHaveBeenCalledWith("instance:update:queue", expect.stringContaining("1.2.4"));
  });

  it("MANUAL applies a minor bump (explicit consent) — queues the job", async () => {
    const r = redisStub();
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.3.0" } }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "started", targetVersion: "1.3.0" });
    expect(r.lpush).toHaveBeenCalled();
  });

  it("returns in-progress and does NOT queue a second job when the lock is held", async () => {
    const r = redisStub(false); // lock not acquired
    const svc = new UpdaterService(r.svc, updateStub({ status: "ok", channel: "stable", entry: { version: "1.2.4" } }));
    expect(await svc.requestUpdate({ actor: "u1", auto: false })).toEqual({ status: "in-progress", targetVersion: "1.2.4" });
    expect(r.lpush).not.toHaveBeenCalled();
  });
});

describe("getProgress + pure helpers", () => {
  it("getProgress maps the Redis status blob", async () => {
    const r = redisStub();
    r.get.mockResolvedValue(JSON.stringify({ phase: "pulling", targetVersion: "1.2.4" }));
    const svc = new UpdaterService(r.svc, updateStub({ status: "unconfigured" }));
    expect(await svc.getProgress()).toEqual({ phase: "pulling", targetVersion: "1.2.4", error: null });
  });

  it("mapStatus falls back to idle for absent/garbage/unknown-phase input", () => {
    expect(mapStatus(null)).toEqual({ phase: "idle", targetVersion: null, error: null });
    expect(mapStatus("{not json")).toEqual({ phase: "idle", targetVersion: null, error: null });
    expect(mapStatus(JSON.stringify({ phase: "bogus" }))).toMatchObject({ phase: "idle" });
    expect(mapStatus(JSON.stringify({ phase: "failed", error: "boom" }))).toEqual({ phase: "failed", targetVersion: null, error: "boom" });
  });

  it("isTerminalPhase is true only for done/failed", () => {
    expect(isTerminalPhase("done")).toBe(true);
    expect(isTerminalPhase("failed")).toBe(true);
    expect(isTerminalPhase("pulling")).toBe(false);
    expect(isTerminalPhase("idle")).toBe(false);
  });
});
