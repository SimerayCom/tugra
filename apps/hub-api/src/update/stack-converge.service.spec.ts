import { StackConvergeService, isBehind } from "./stack-converge.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { AuditService } from "../audit/audit.service";
import type { RedisService } from "../redis/redis.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { LatestEntryResult, UpdateService } from "./update.service";
import { UPDATE_LOCK_KEY, UPDATE_STATUS_KEY } from "./updater.service";

const U = "a".repeat(64);
const A_AMD = "b".repeat(64);
const A_ARM = "d".repeat(64);
const H = "c".repeat(64);
const OWN = "0.1.0-beta.20";

const savedVersion = process.env.TUGRA_VERSION;
beforeEach(() => {
  process.env.TUGRA_VERSION = OWN;
});
afterEach(() => {
  if (savedVersion === undefined) delete process.env.TUGRA_VERSION;
  else process.env.TUGRA_VERSION = savedVersion;
});

const probeOut = (version: string | null) => `TUGRA_PROBE updater=present\nTUGRA_PROBE version=${version ?? ""}\nTUGRA_PROBE image=ghcr.io/simeraycom/tugra-updater:${version ?? "latest"}\nTUGRA_PROBE running=true\n`;

interface Opts {
  configured?: boolean;
  local?: { id: string; arch: string | null; agentVersion: string | null; capabilities: string[] } | null;
  online?: boolean;
  updaterVersion?: string | null;
  updaterAbsent?: boolean;
  entry?: LatestEntryResult;
  refreshExit?: number;
  refreshOut?: string;
  probeThrows?: boolean;
  redisInit?: Record<string, string>;
  onRefresh?: () => void;
}

function rig(o: Opts = {}) {
  const store = new Map<string, string>(Object.entries(o.redisInit ?? {}));
  const ttl = new Map<string, number | undefined>();
  const redis = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, t?: number) => {
      store.set(k, v);
      ttl.set(k, t);
    }),
    del: jest.fn(async (...ks: string[]) => ks.forEach((k) => store.delete(k))),
    firstInWindow: jest.fn(async (k: string, t: number) => {
      if (store.has(k)) return false;
      store.set(k, "1");
      ttl.set(k, t);
      return true;
    }),
    expire: jest.fn(async (k: string, t: number) => {
      ttl.set(k, t);
    }),
  } as unknown as RedisService;
  const local = o.local === undefined ? { id: "srv1", arch: "x86_64", agentVersion: "0.1.0-beta.18", capabilities: ["deploy", "logs"] } : o.local;
  const prisma = { server: { findFirst: jest.fn().mockResolvedValue(local) } } as unknown as PrismaService;
  const commands: string[] = [];
  const agentWs = {
    isOnline: jest.fn().mockReturnValue(o.online ?? true),
    sendCommand: jest.fn(async (_id: string, script: string) => {
      commands.push(script);
      if (!script.includes("TUGRA_PROBE")) o.onRefresh?.();
      if (script.includes("TUGRA_PROBE")) {
        if (o.probeThrows) throw new Error("agent offline");
        return { exitCode: 0, output: o.updaterAbsent ? "TUGRA_PROBE updater=absent" : probeOut(o.updaterVersion === undefined ? "0.1.0-beta.17" : o.updaterVersion) };
      }
      return { exitCode: o.refreshExit ?? 0, output: o.refreshOut ?? "TUGRA_STEP hostfiles=applied\nTUGRA_STEP scheduled=tugra-updater,agent\n" };
    }),
  } as unknown as AgentWsServer;
  const entry: LatestEntryResult = o.entry ?? {
    status: "ok",
    channel: "beta",
    entry: { version: OWN, imageDigests: { updater: U }, hostFilesDigest: H, agentSha256: { amd64: A_AMD, arm64: A_ARM } },
  };
  const update = { isConfigured: jest.fn().mockReturnValue(o.configured ?? true), isForcedOff: jest.fn().mockReturnValue(false), verifyLatestEntry: jest.fn().mockResolvedValue(entry) } as unknown as UpdateService;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const svc = new StackConvergeService(prisma, audit, redis, agentWs, update);
  const refreshCommands = () => commands.filter((c) => !c.includes("TUGRA_PROBE"));
  return { svc, redis, store, ttl, agentWs, audit, update, commands, refreshCommands, prisma };
}

describe("isBehind", () => {
  it("only a parseable strictly-older version is behind", () => {
    expect(isBehind("0.1.0-beta.20", "0.1.0-beta.17")).toBe(true);
    expect(isBehind("0.1.0-beta.20", "0.1.0-beta.20")).toBe(false);
    expect(isBehind("0.1.0-beta.20", "0.1.0")).toBe(false);
    expect(isBehind("0.1.0-beta.20", null)).toBe(false);
    expect(isBehind("0.1.0-beta.20", "nope")).toBe(false);
  });
});

describe("StackConvergeService.reconcile (bootstrap of an updater/agent that lags the hub)", () => {
  it("a lagging updater + agent: probes, then asks the LOCAL agent once to refresh both by signed digests, applying the signed host files", async () => {
    const r = rig();
    expect(await r.svc.reconcile()).toBe("scheduled");
    expect(r.agentWs.sendCommand).toHaveBeenCalledTimes(2);
    const [, script, capability] = (r.agentWs.sendCommand as jest.Mock).mock.calls[1];
    expect(capability).toBe("deploy");
    expect(script).toContain(`'${U}'`); // updater index digest
    expect(script).toContain(`'${A_AMD}'`); // the x86_64 agent's per-platform digest, not the arm64 one
    expect(script).not.toContain(A_ARM);
    expect(script).toContain(`--apply-host-files "$VERSION" '${H}'`);
    expect(script).toContain("tugra-updater agent");
    expect(script).toContain(`VERSION='${OWN}'`);
    expect(r.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance_update.stack_converge", target: "srv1" }));
  });

  it("an arm64 local agent gets the arm64 platform digest", async () => {
    const r = rig({ local: { id: "srv1", arch: "aarch64", agentVersion: "0.1.0-beta.18", capabilities: ["deploy"] } });
    await r.svc.reconcile();
    expect(r.refreshCommands()[0]).toContain(`'${A_ARM}'`);
    expect(r.refreshCommands()[0]).not.toContain(A_AMD);
  });

  it("ONCE PER RELEASE: a second pass (even after a restart of the hub, via the Redis marker) only probes", async () => {
    const r = rig();
    expect(await r.svc.reconcile()).toBe("scheduled");
    r.store.delete(UPDATE_LOCK_KEY); // the lock window passed
    expect(await r.svc.reconcile()).toBe("already-attempted");
    expect(r.refreshCommands()).toHaveLength(1);
    expect(r.store.get("instance:update:stack-converge")).toBe(OWN);
    // a fresh service instance (hub restart) sees the same marker
    const again = new StackConvergeService({ server: { findFirst: async () => ({ id: "srv1", arch: "x86_64", agentVersion: "0.1.0-beta.18", capabilities: ["deploy"] }) } } as never, r.audit, r.redis, r.agentWs, r.update);
    expect(await again.reconcile()).toBe("already-attempted");
    expect(r.refreshCommands()).toHaveLength(1);
  });

  it("NEVER MID-JOB: an update that is queued/pulling/recreating, or a held update lock, blocks it (nothing but the probe is sent)", async () => {
    for (const phase of ["queued", "pulling", "recreating"]) {
      const r = rig({ redisInit: { [UPDATE_STATUS_KEY]: JSON.stringify({ phase, targetVersion: "0.1.0-beta.21", error: null }) } });
      expect(await r.svc.reconcile()).toBe("update-in-progress");
      expect(r.refreshCommands()).toHaveLength(0);
    }
    const locked = rig({ redisInit: { [UPDATE_LOCK_KEY]: "1" } });
    expect(await locked.svc.reconcile()).toBe("update-in-progress");
    expect(locked.refreshCommands()).toHaveLength(0);
    expect(locked.store.get(UPDATE_LOCK_KEY)).toBe("1"); // someone else's lock is never released by us
  });

  it("takes the update lock for the recreate window (no 'Update now' can slip in) and keeps it after a successful start", async () => {
    const r = rig();
    await r.svc.reconcile();
    expect(r.redis.firstInWindow).toHaveBeenCalledWith(UPDATE_LOCK_KEY, expect.any(Number));
    expect(r.store.has(UPDATE_LOCK_KEY)).toBe(true);
  });

  it("the update lock covers the WHOLE refresh (pulls + host files can take minutes) and is only then shortened to the recreate window", async () => {
    let held: { has: boolean; ttl: number | undefined } | undefined;
    const r = rig({ onRefresh: () => undefined });
    // while the (long) refresh script runs, the lock must still be there for at least as long as the script may take
    (r.agentWs.sendCommand as jest.Mock).mockImplementationOnce(async () => ({ exitCode: 0, output: probeOut("0.1.0-beta.17") })).mockImplementationOnce(async () => {
      held = { has: r.store.has(UPDATE_LOCK_KEY), ttl: r.ttl.get(UPDATE_LOCK_KEY) };
      return { exitCode: 0, output: "TUGRA_STEP scheduled=tugra-updater,agent\n" };
    });
    expect(await r.svc.reconcile()).toBe("scheduled");
    expect(held?.has).toBe(true);
    expect(held?.ttl).toBeGreaterThanOrEqual(12 * 60 + 60); // REFRESH_TIMEOUT (12 min) + margin: a lock that lapsed mid-script lets "Update now" slip in
    expect(r.redis.expire).toHaveBeenCalledWith(UPDATE_LOCK_KEY, expect.any(Number));
    const after = r.ttl.get(UPDATE_LOCK_KEY) as number;
    expect(after).toBeGreaterThanOrEqual(60);
    expect(after).toBeLessThanOrEqual(300);
    expect(r.store.has(UPDATE_LOCK_KEY)).toBe(true);
  });

  it("an agent that lags on an install WITHOUT an updater container is refreshed too (agent only, by its signed platform digest)", async () => {
    const r = rig({ updaterAbsent: true });
    expect(await r.svc.reconcile()).toBe("scheduled");
    const s = r.refreshCommands()[0];
    expect(s).toContain(`pull_release "$AGENT_REPO" '${A_AMD}'`);
    expect(s).toMatch(/"\$VERSION" agent >/);
    expect(s).not.toContain("--apply-host-files");
  });

  it("a refresh that does not start: failure, lock released, short retry marker, the panel says failed", async () => {
    const r = rig({ refreshExit: 4, refreshOut: "TUGRA_STEP error=pull-updater\n" });
    expect(await r.svc.reconcile()).toBe("failed");
    expect(r.store.has(UPDATE_LOCK_KEY)).toBe(false);
    expect(r.ttl.get("instance:update:stack-converge")).toBe(6 * 3600);
    expect(await r.svc.view()).toMatchObject({ version: "0.1.0-beta.17", behind: true, state: "failed" });
  });

  it("the agent is only refreshed with a signed digest: a manifest for ANOTHER release gives the updater a plain-tag refresh and skips agent + host files", async () => {
    const r = rig({ entry: { status: "ok", channel: "beta", entry: { version: "0.1.0-beta.21", imageDigests: { updater: U }, agentSha256: { amd64: A_AMD }, hostFilesDigest: H } } });
    expect(await r.svc.reconcile()).toBe("scheduled");
    const s = r.refreshCommands()[0];
    expect(s).toContain(`pull_release "$UPD_REPO" ''`);
    expect(s).not.toContain("--apply-host-files");
    expect(s).not.toContain("pull_release \"$AGENT_REPO\"");
    expect(s).toMatch(/"\$VERSION" tugra-updater >/);
  });

  it("an agent that lags with no digest for its platform (and a current updater) cannot be refreshed: no-digest, lock released", async () => {
    const r = rig({ updaterVersion: OWN, entry: { status: "ok", channel: "beta", entry: { version: OWN, agentSha256: { arm64: A_ARM } } } });
    expect(await r.svc.reconcile()).toBe("no-digest");
    expect(r.refreshCommands()).toHaveLength(0);
    expect(r.store.has(UPDATE_LOCK_KEY)).toBe(false);
  });

  it("nothing lags: only the read-only probe runs", async () => {
    const r = rig({ updaterVersion: OWN, local: { id: "srv1", arch: "x86_64", agentVersion: OWN, capabilities: ["deploy"] } });
    expect(await r.svc.reconcile()).toBe("current");
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toContain("TUGRA_PROBE");
    expect(r.redis.firstInWindow).not.toHaveBeenCalled();
    expect(await r.svc.view()).toMatchObject({ version: OWN, behind: false, state: "current" });
  });

  it("does nothing when update checks are off, there is no local agent, it is offline, or it lacks the deploy capability", async () => {
    expect(await rig({ configured: false }).svc.reconcile()).toBe("disabled");
    expect(await rig({ local: null }).svc.reconcile()).toBe("no-local-agent");
    const offline = rig({ online: false });
    expect(await offline.svc.reconcile()).toBe("agent-offline");
    expect(offline.agentWs.sendCommand).not.toHaveBeenCalled();
    const noCap = rig({ local: { id: "srv1", arch: "x86_64", agentVersion: "0.1.0-beta.18", capabilities: ["logs"] } });
    expect(await noCap.svc.reconcile()).toBe("no-capability");
    expect(noCap.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("an install without an updater container, or an unlabeled/source-built one, is left alone", async () => {
    const absent = rig({ updaterAbsent: true, local: { id: "srv1", arch: "x86_64", agentVersion: OWN, capabilities: ["deploy"] } });
    expect(await absent.svc.reconcile()).toBe("current");
    const unknown = rig({ updaterVersion: null, local: { id: "srv1", arch: "x86_64", agentVersion: OWN, capabilities: ["deploy"] } });
    expect(await unknown.svc.reconcile()).toBe("current");
    expect(unknown.refreshCommands()).toHaveLength(0);
  });

  it("a probe that fails (agent hiccup) is reported, never throws, and changes nothing", async () => {
    const r = rig({ probeThrows: true });
    expect(await r.svc.reconcile()).toBe("probe-failed");
    expect(r.refreshCommands()).toHaveLength(0);
  });
});

describe("StackConvergeService.view (what the panel shows)", () => {
  it("unknown before any probe; behind after a probe that found an older helper; refreshing right after the refresh was scheduled", async () => {
    const r = rig({ probeThrows: true });
    expect(await r.svc.view()).toEqual({ version: null, behind: false, state: "unknown", checkedAt: null });
    const ok = rig();
    await ok.svc.reconcile();
    const v = await ok.svc.view();
    expect(v).toMatchObject({ version: "0.1.0-beta.17", behind: true, state: "refreshing" });
    expect(typeof v.checkedAt).toBe("string");
    // behind with no attempt yet (the once-per-release marker is the only thing holding it back)
    const waiting = rig({ redisInit: { "instance:update:stack-converge": OWN } });
    await waiting.svc.reconcile();
    expect(await waiting.svc.view()).toMatchObject({ behind: true, state: "behind" });
  });

  it("a refresh that was scheduled long ago and the helper still lags is a failure, not an eternal 'refreshing'", async () => {
    const r = rig();
    await r.svc.reconcile();
    const stored = JSON.parse(r.store.get("instance:update:updater-info") as string);
    stored.scheduledAt = new Date(Date.now() - 30 * 60_000).toISOString();
    r.store.set("instance:update:updater-info", JSON.stringify(stored));
    expect(await r.svc.view()).toMatchObject({ behind: true, state: "failed" });
  });

  it("after the refreshing window it does not cry 'failed' until a probe taken AFTER the helper had time to restart still sees the old version", async () => {
    const r = rig();
    await r.svc.reconcile();
    const stored = JSON.parse(r.store.get("instance:update:updater-info") as string);
    // scheduled 15 min ago; the last probe is from BEFORE that (the one that found the lag)
    stored.scheduledAt = new Date(Date.now() - 15 * 60_000).toISOString();
    stored.checkedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    r.store.set("instance:update:updater-info", JSON.stringify(stored));
    expect(await r.svc.view()).toMatchObject({ behind: true, state: "refreshing" });
    // a probe from after the window that still sees the old helper is a real failure
    stored.checkedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    r.store.set("instance:update:updater-info", JSON.stringify(stored));
    expect(await r.svc.view()).toMatchObject({ behind: true, state: "failed" });
    // and with no probe at all for over an hour the attempt counts as failed rather than "refreshing" forever
    stored.scheduledAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    stored.checkedAt = new Date(Date.now() - 4 * 3600_000).toISOString();
    r.store.set("instance:update:updater-info", JSON.stringify(stored));
    expect(await r.svc.view()).toMatchObject({ behind: true, state: "failed" });
  });

  it("becomes current once the helper reports the hub's release (old attempt state is dropped)", async () => {
    const r = rig();
    await r.svc.reconcile();
    const next = rig({ updaterVersion: OWN, local: { id: "srv1", arch: "x86_64", agentVersion: OWN, capabilities: ["deploy"] }, redisInit: Object.fromEntries(r.store) });
    await next.svc.reconcile();
    const view = await next.svc.view();
    expect(view).toMatchObject({ version: OWN, behind: false, state: "current" });
  });
});
