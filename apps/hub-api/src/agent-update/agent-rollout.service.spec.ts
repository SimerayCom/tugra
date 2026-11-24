import { AgentRolloutService } from "./agent-rollout.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { InstanceSettingsService } from "../instance/instance-settings.service";
import type { UpdateService } from "../update/update.service";
import type { AgentUpdateService } from "./agent-update.service";

const ENTRY = { status: "ok" as const, channel: "stable", entry: { version: "0.2.0", agentSha256: { amd64: "aaa" } } };

type Row = { id: string; teamId: string; arch: string; agentVersion: string | null; status: "ONLINE" | "OFFLINE" };
const row = (id: string, agentVersion: string | null, status: Row["status"] = "ONLINE"): Row => ({ id, teamId: "t1", arch: "x86_64", agentVersion, status });

interface Req {
  target: string;
  createdAt: Date;
  meta: { to: string };
}

function make(opts: {
  autoUpdate?: boolean;
  rows: Row[];
  verified?: unknown;
  applyStatus?: "sent" | "offline" | "skipped";
  hubBehind?: boolean;
  requests?: Req[];
}) {
  const rows = opts.rows;
  const requests: Req[] = opts.requests ?? [];
  const clock = { t: 0 };
  const prisma = {
    server: { findMany: jest.fn(async () => rows) },
    auditLog: {
      findMany: jest.fn(async (args: { where: { target: { in: string[] }; createdAt: { gte: Date } } }) =>
        requests.filter((r) => args.where.target.in.includes(r.target) && r.createdAt >= args.where.createdAt.gte),
      ),
    },
  } as unknown as PrismaService;
  const settings = { get: jest.fn(async () => ({ autoUpdate: opts.autoUpdate ?? true })) } as unknown as InstanceSettingsService;
  const update = {
    verifyLatestEntry: jest.fn(async () => opts.verified ?? ENTRY),
    getStatus: jest.fn(async () => ({ updateAvailable: opts.hubBehind ?? false })),
  } as unknown as UpdateService;
  // A sent update is audited by the real service; the fake does the same at the test clock.
  const applyAuto = jest.fn(async (s: { id: string }) => {
    const status = opts.applyStatus ?? "sent";
    if (status === "sent") requests.push({ target: s.id, createdAt: new Date(clock.t), meta: { to: "0.2.0" } });
    return { serverId: s.id, status };
  });
  const agentUpdate = { applyAuto } as unknown as AgentUpdateService;
  const svc = new AgentRolloutService(prisma, update, agentUpdate, settings);
  const tick = (t: number) => {
    clock.t = t;
    return svc.tick(t);
  };
  return { svc, rows, applyAuto, update, prisma, settings, requests, tick };
}

describe("AgentRolloutService", () => {
  const prev = process.env.TUGRA_VERSION;
  beforeEach(() => {
    process.env.TUGRA_VERSION = "0.2.0"; // the hub is on the published release
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.TUGRA_VERSION;
    else process.env.TUGRA_VERSION = prev;
  });

  it("does nothing, and reads no fleet, when 'Apply updates automatically' is off", async () => {
    const { svc, applyAuto, prisma } = make({ autoUpdate: false, rows: [row("a", "0.1.0")] });
    expect(await svc.tick()).toEqual({ action: "off" });
    expect(applyAuto).not.toHaveBeenCalled();
    expect(prisma.server.findMany).not.toHaveBeenCalled();
  });

  it("is idle, and fetches no manifest, when every agent is current", async () => {
    const { svc, update, applyAuto } = make({ rows: [row("a", "0.2.0"), row("b", null)] });
    expect(await svc.tick()).toEqual({ action: "idle" });
    expect(update.verifyLatestEntry).not.toHaveBeenCalled();
    expect(applyAuto).not.toHaveBeenCalled();
  });

  it("updates one agent per pass and waits for it to come back before starting the next", async () => {
    const { applyAuto, rows, tick } = make({ rows: [row("a", "0.1.0"), row("b", "0.1.0"), row("c", "0.1.0")] });
    const t0 = 1_000_000;
    expect(await tick(t0)).toEqual({ action: "sent", serverId: "a" });
    expect(await tick(t0 + 60_000)).toEqual({ action: "waiting-agent", serverId: "a" });
    expect(applyAuto).toHaveBeenCalledTimes(1);
    rows[0].agentVersion = "0.2.0"; // a reconnected on the new version
    expect(await tick(t0 + 120_000)).toEqual({ action: "sent", serverId: "b" });
    rows[1].agentVersion = "0.2.0";
    expect(await tick(t0 + 180_000)).toEqual({ action: "sent", serverId: "c" });
    rows[2].agentVersion = "0.2.0";
    expect(await tick(t0 + 240_000)).toEqual({ action: "idle" });
    expect(applyAuto.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["a", "b", "c"]);
  });

  it("an agent that never comes back does not stall the fleet: after the settle time the next one goes first", async () => {
    const { applyAuto, tick } = make({ rows: [row("a", "0.1.0"), row("b", "0.1.0")] });
    const t0 = 5_000_000;
    expect(await tick(t0)).toEqual({ action: "sent", serverId: "a" });
    expect(await tick(t0 + 9 * 60_000)).toEqual({ action: "waiting-agent", serverId: "a" });
    expect(await tick(t0 + 11 * 60_000)).toEqual({ action: "sent", serverId: "b" }); // a goes to the back of the line
    expect(applyAuto.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["a", "b"]);
  });

  it("gives up on an agent after three failed attempts at the same release", async () => {
    const { applyAuto, rows, tick } = make({ rows: [row("a", "0.1.0"), row("b", "0.1.0")] });
    let t = 10_000_000;
    const sent = async () => {
      const r = await tick(t);
      t += 11 * 60_000; // past the settle time
      return r;
    };
    expect(await sent()).toEqual({ action: "sent", serverId: "a" });
    expect(await sent()).toEqual({ action: "sent", serverId: "b" });
    rows[1].agentVersion = "0.2.0"; // b recovered, a never does
    expect(await sent()).toEqual({ action: "sent", serverId: "a" }); // a: attempt 2
    expect(await sent()).toEqual({ action: "sent", serverId: "a" }); // a: attempt 3
    expect(await sent()).toEqual({ action: "idle" }); // out of attempts: left alone, still shown in the notice
    expect(applyAuto.mock.calls.filter((c) => (c[0] as { id: string }).id === "a")).toHaveLength(3);
  });

  it("waits while the hub is behind the published release, without fetching the manifest", async () => {
    const { svc, applyAuto, update } = make({ rows: [row("a", "0.1.0")], hubBehind: true });
    expect(await svc.tick()).toEqual({ action: "waiting-hub" });
    expect(applyAuto).not.toHaveBeenCalled();
    expect(update.verifyLatestEntry).not.toHaveBeenCalled();
  });

  it("also waits for the hub when the verified manifest is newer than the hub", async () => {
    process.env.TUGRA_VERSION = "0.1.5";
    const { svc, applyAuto } = make({ rows: [row("a", "0.1.0")] });
    expect(await svc.tick()).toEqual({ action: "waiting-hub" });
    expect(applyAuto).not.toHaveBeenCalled();
  });

  it("does not fetch the manifest every pass while the only agents behind are offline or out of attempts", async () => {
    const offline = make({ rows: [row("a", "0.1.0", "OFFLINE")] });
    await offline.svc.tick();
    await offline.svc.tick();
    expect(offline.update.verifyLatestEntry).not.toHaveBeenCalled();
    const old = new Date(0);
    const exhausted = make({
      rows: [row("a", "0.1.0")],
      requests: [1, 2, 3].map(() => ({ target: "a", createdAt: old, meta: { to: "0.2.0" } })),
    });
    const now = 3 * 60 * 60_000; // old enough to be settled, recent enough to count
    expect(await exhausted.svc.tick(now)).toEqual({ action: "idle" });
    expect(exhausted.update.verifyLatestEntry).not.toHaveBeenCalled();
  });

  it("keeps one-at-a-time across a hub restart: a fresh service still waits for an agent sent moments ago", async () => {
    const now = 9_000_000;
    const { svc, applyAuto } = make({
      rows: [row("a", "0.1.0", "OFFLINE"), row("b", "0.1.0")], // a is restarting onto the new version
      requests: [{ target: "a", createdAt: new Date(now - 2 * 60_000), meta: { to: "0.2.0" } }],
    });
    expect(await svc.tick(now)).toEqual({ action: "waiting-agent", serverId: "a" });
    expect(applyAuto).not.toHaveBeenCalled();
    expect(await svc.tick(now + 9 * 60_000)).toEqual({ action: "sent", serverId: "b" }); // past the settle time
  });

  it("skips offline agents (they are retried once they reconnect) and reports no manifest as unavailable", async () => {
    const off = make({ rows: [row("a", "0.1.0", "OFFLINE")] });
    expect(await off.svc.tick()).toEqual({ action: "idle" });
    expect(off.applyAuto).not.toHaveBeenCalled();
    const noManifest = make({ rows: [row("a", "0.1.0")], verified: { status: "error", reason: "fetch" } });
    expect(await noManifest.svc.tick()).toEqual({ action: "unavailable" });
    expect(noManifest.applyAuto).not.toHaveBeenCalled();
  });

  it("a refused update (capability not granted) is not retried every pass, but is retried after the back-off", async () => {
    const { svc, applyAuto } = make({ rows: [row("a", "0.1.0"), row("b", "0.1.0")], applyStatus: "skipped" });
    expect(await svc.tick(1)).toEqual({ action: "idle" });
    expect(await svc.tick(2)).toEqual({ action: "idle" });
    expect(applyAuto.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(["a", "b"]);
    expect(await svc.tick(2 * 60 * 60_000)).toEqual({ action: "idle" }); // an hour on, both are tried again
    expect(applyAuto).toHaveBeenCalledTimes(3);
  });

  it("only ever looks at remote servers that have an agent", async () => {
    const { svc, prisma } = make({ rows: [] });
    await svc.tick();
    const where = (prisma.server.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toEqual({ isLocal: false, status: { not: "PENDING" } });
  });
});
