import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AGENT_FEATURE_HUB_ORIGIN_ENV } from "@tugra/shared";
import { AppMovesService } from "./app-moves.service";
import { MovePreflightService } from "./move-preflight.service";
import { DOCKER_ROOT, MOVE_STAGING_ROOT } from "./app-move-scripts";

const APP = {
  id: "capp", teamId: "t1", environmentId: "env1", name: "blog", source: "IMAGE", serverId: "s1", status: "RUNNING", clusterId: null, isPreview: false,
  dbNetwork: false, hostPort: null, extraPorts: null, portMappings: null, containerAlias: null, networkAliases: [], networks: [], volumes: [{ name: "data", path: "/data" }],
  composeFile: null, configMounts: null, templateSlug: null, hostMounts: null, gpus: null, cpusetCpus: null, allowPrivilegedDockerOptions: false, domain: null,
  domainKind: "none", certType: "http", tunnelExposed: false, certPem: null, pushToRegistry: false, buildServerId: null, extraDomains: [], envEnc: null, env: {},
};
const srv = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, teamId: "t1", publicIp: id === "s1" ? "1.2.3.4" : "5.6.7.8", publicIpv6: null, wildcardDomain: null, magicSuffix: null, proxyBind: "all", cpuCores: 8,
  gpuInventory: null, swarmRole: null, capabilities: ["deploy", "backup"], ...over,
});

const PROBE_OUT = (vol: string, kb: number) =>
  [
    `TUGRA_DF ${DOCKER_ROOT} 100000000 1`,
    `TUGRA_DF ${MOVE_STAGING_ROOT} 100000000 2`,
    "TUGRA_TOOL curl 1", "TUGRA_TOOL split 1", "TUGRA_TOOL sha256sum 1", "TUGRA_TOOL gzip 1", "TUGRA_TOOL helper 1",
    `TUGRA_VOL ${vol} EXISTS ${kb} -`,
    "TUGRA_PORT 22",
    "TUGRA_PROBE_END",
  ].join("\n");
const TARGET_PROBE = (vol: string) =>
  [
    `TUGRA_DF ${DOCKER_ROOT} 100000000 1`, `TUGRA_DF ${MOVE_STAGING_ROOT} 100000000 2`,
    "TUGRA_TOOL curl 1", "TUGRA_TOOL split 1", "TUGRA_TOOL sha256sum 1", "TUGRA_TOOL gzip 1", "TUGRA_TOOL helper 1",
    `TUGRA_VOL ${vol} ABSENT`, "TUGRA_PORT 22", "TUGRA_PROBE_END",
  ].join("\n");

const LINK_SHA = "c".repeat(64);

function make(opts: { transfer?: jest.Mock; app?: Record<string, unknown> | null; perms?: Set<string>; member?: boolean; targetTeam?: string; owner?: boolean; send?: jest.Mock; online?: Record<string, boolean>; supports?: boolean; moves?: Record<string, unknown>[] } = {}) {
  const app = opts.app === undefined ? APP : opts.app && { ...APP, ...opts.app };
  const servers: Record<string, ReturnType<typeof srv>> = { s1: srv("s1"), s2: srv("s2", { teamId: opts.targetTeam ?? "t1" }) };
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(app), findMany: jest.fn().mockResolvedValue([]) },
    server: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(servers[where.id] ?? null)) },
    user: { findUnique: jest.fn().mockResolvedValue({ isInstanceOwner: !!opts.owner }) },
    appDatabaseLink: { count: jest.fn().mockResolvedValue(0) },
    rolloutTarget: { count: jest.fn().mockResolvedValue(0) },
    deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    appMove: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue(opts.moves ?? []) },
    database: { findMany: jest.fn().mockResolvedValue([]) },
    volumeBackup: { findMany: jest.fn().mockResolvedValue([]) },
    backupDestination: { findMany: jest.fn().mockResolvedValue([]) },
    domain: { count: jest.fn().mockResolvedValue(0) },
    appServiceDomain: { count: jest.fn().mockResolvedValue(0) },
    environment: { findUnique: jest.fn().mockResolvedValue({ id: "env1", projectId: "p1" }) },
  };
  const perms = opts.perms ?? new Set(["apps:config", "apps:deploy", "backups"]);
  const access = {
    requirePermission: jest.fn(async (_u: string, _t: string, p: string) => {
      if (!perms.has(p)) throw new ForbiddenException("insufficient permission for this team");
    }),
    teamRole: jest.fn().mockResolvedValue(opts.member === false ? null : "VIEWER"),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    membershipPermissions: jest.fn().mockResolvedValue(perms),
  };
  const online = opts.online ?? { s1: true, s2: true };
  const send =
    opts.send ??
    jest.fn(async (id: string, script: string) => {
      if (script.includes("head -c")) return { exitCode: 0, output: `TUGRA_VX_PART 16777216 ${LINK_SHA}\n` }; // link-probe file on the source
      if (script.includes("TUGRA_VX_CLEANUP_DONE")) return { exitCode: 0, output: "TUGRA_VX_CLEANUP_DONE\n" };
      return { exitCode: 0, output: id === "s1" ? PROBE_OUT("tugra_appv_capp_data", 2048) : TARGET_PROBE("tugra_appv_capp_data") };
    });
  const transfers = { transfer: opts.transfer ?? jest.fn().mockResolvedValue({ ok: true, bytes: 16777216 }) };
  const agentWs = {
    isOnline: jest.fn((id: string) => online[id] ?? false),
    agentSupports: jest.fn((_id: string, f: string) => f === AGENT_FEATURE_HUB_ORIGIN_ENV && opts.supports !== false),
    sendCommand: send,
  };
  const crypto = { decrypt: (s: string) => s };
  const config = { get: (k: string) => ({ MOVE_PART_MIB: 256, TUGRA_HOSTPORT_MIN: 20000, TUGRA_HOSTPORT_MAX: 45000, MAGIC_DOMAIN_SUFFIX: "sslip.io" } as Record<string, unknown>)[k] };
  const pre = new MovePreflightService(prisma as never, agentWs as never, crypto as never, config as never, transfers as never);
  const svc = new AppMovesService(prisma as never, access as never, { log: jest.fn() } as never, pre);
  return { svc, pre, prisma, access, agentWs, send, transfers };
}

const input = { targetServerId: "s2", acknowledge: {}, probeLink: false } as never;

describe("AppMovesService.preflight — authorization", () => {
  it("a team member without apps:config / apps:deploy / backups is refused (403) and nothing is probed", async () => {
    for (const missing of ["apps:config", "apps:deploy", "backups"]) {
      const perms = new Set(["apps:config", "apps:deploy", "backups"]);
      perms.delete(missing);
      const t = make({ perms });
      await expect(t.svc.preflight("u1", "capp", input)).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.send).not.toHaveBeenCalled();
    }
  });

  it("a reader (no write permissions at all) gets 403", async () => {
    const t = make({ perms: new Set() });
    await expect(t.svc.preflight("u1", "capp", input)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404 for an unknown app", async () => {
    await expect(make({ app: null }).svc.preflight("u1", "nope", input)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a target in ANOTHER team is a uniform 404 (no existence oracle) and an unknown target is the same 404", async () => {
    await expect(make({ targetTeam: "t2" }).svc.preflight("u1", "capp", input)).rejects.toThrow(NotFoundException);
    await expect(make().svc.preflight("u1", "capp", { ...(input as object), targetServerId: "ghost" } as never)).rejects.toThrow(NotFoundException);
  });

  it("per-resource scoping is enforced (a restricted member cannot move an app they cannot access)", async () => {
    const t = make();
    t.access.requireResourceAccess.mockRejectedValueOnce(new ForbiddenException("no access"));
    await expect(t.svc.preflight("u1", "capp", input)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("AppMovesService.preflight — assembly with live probes", () => {
  it("probes BOTH hosts with the read-only script under the backup capability and returns a sized plan", async () => {
    const t = make();
    const r = await t.svc.preflight("u1", "capp", input);
    expect(r.ok).toBe(true);
    expect(r.plan.volumes[0]).toMatchObject({ dockerName: "tugra_appv_capp_data", sizeBytes: 2048 * 1024, state: "move" });
    expect(t.send).toHaveBeenCalledTimes(2);
    for (const call of t.send.mock.calls) {
      expect(call[2]).toBe("backup");
      expect(call[1]).toContain("TUGRA_PROBE_END");
      expect(call[3]).toBe(600_000);
    }
    expect(t.send.mock.calls.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
  });

  it("an offline agent is a blocker and is never probed", async () => {
    const t = make({ online: { s1: true, s2: false } });
    const r = await t.svc.preflight("u1", "capp", input);
    expect(r.blockers.map((b) => b.code)).toEqual(["agent_offline_target"]);
    expect(t.send.mock.calls.map((c) => c[0])).toEqual(["s1"]);
  });

  it("an agent without hub_origin_env_v1 is agent_too_old on both sides", async () => {
    const r = await make({ supports: false }).svc.preflight("u1", "capp", input);
    expect(r.blockers.filter((b) => b.code === "agent_too_old").map((b) => b.details)).toEqual([{ serverId: "s1" }, { serverId: "s2" }]);
  });

  it("malformed probe output / non-zero exit / agent error => probe_failed (fail closed)", async () => {
    for (const send of [
      jest.fn().mockResolvedValue({ exitCode: 0, output: "garbage" }),
      jest.fn().mockResolvedValue({ exitCode: 2, output: PROBE_OUT("tugra_appv_capp_data", 1) }),
      jest.fn().mockRejectedValue(new Error("timeout")),
    ]) {
      const r = await make({ send }).svc.preflight("u1", "capp", input);
      expect(r.blockers.filter((b) => b.code === "probe_failed").length).toBe(2);
      expect(r.ok).toBe(false);
    }
  });

  it("a NEW app never touches an agent", async () => {
    const t = make({ app: { status: "NEW" }, online: { s1: false, s2: false } });
    const r = await t.svc.preflight("u1", "capp", input);
    expect(r.ok).toBe(true);
    expect(r.plan.cheap).toBe(true);
    expect(t.send).not.toHaveBeenCalled();
  });

  it("DB facts feed the verdict: db links, previews, other moves, privileged grant by a non-owner", async () => {
    const t = make({ app: { allowPrivilegedDockerOptions: true } });
    t.prisma.appDatabaseLink.count.mockResolvedValue(2);
    t.prisma.application.findMany.mockImplementation(({ where }: { where: { parentAppId?: string; serverId?: string } }) => Promise.resolve(where.parentAppId ? [{ prNumber: 5 }] : []));
    t.prisma.appMove.findFirst.mockResolvedValue({ id: "other" });
    const r = await t.svc.preflight("u1", "capp", input);
    expect(r.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["db_links_exist", "previews_exist", "move_active", "move_active_on_server", "privileged_not_owner"]));
  });

  it("the instance owner may acknowledge dropping the privileged grant", async () => {
    const t = make({ app: { allowPrivilegedDockerOptions: true }, owner: true });
    const r = await t.svc.preflight("u1", "capp", { ...(input as object), acknowledge: { dropPrivilegedOptions: true } } as never);
    expect(r.ok).toBe(true);
  });

  it("reserved ports of OTHER apps/databases on the target and alias collisions are read from the DB", async () => {
    const t = make({ app: { hostPort: 8080, containerAlias: "blog" } });
    t.prisma.application.findMany.mockImplementation(({ where }: { where: { serverId?: string } }) =>
      Promise.resolve(where.serverId === "s2" ? [{ id: "x", teamId: "t1", hostPort: 8080, portMappings: [{ hostPort: 9000 }], extraPorts: [{ hostPort: 9100 }], containerAlias: "blog", networkAliases: [], networks: [], domain: null }] : []),
    );
    t.prisma.database.findMany.mockResolvedValue([{ hostPort: 5432 }]);
    const r = await t.svc.preflight("u1", "capp", input);
    expect(r.blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["alias_conflict", "host_port_changed"]));
    expect(r.plan.hostPort.to).toBe(20000);
  });

  it("never leaks env values: only key NAMES that mention the old host", async () => {
    const env = JSON.stringify({ PUBLIC_URL: "http://1.2.3.4:8080", SECRET: "hunter2", OTHER: "x" });
    const t = make({ app: { envEnc: env } });
    const r = await t.svc.preflight("u1", "capp", input);
    const w = r.warnings.find((x) => x.code === "env_may_reference_old_host")!;
    expect(w.details).toEqual({ keys: ["PUBLIC_URL"] });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

describe("AppMovesService.preflight — optional link probe", () => {
  const withLink = { ...(input as object), probeLink: true } as never;

  it("runs ONE real relay part (16 MiB) source->target, reports throughput, and deletes the probe dir on both hosts", async () => {
    const t = make();
    const r = await t.svc.preflight("u1", "capp", withLink);
    expect(r.ok).toBe(true);
    expect(r.plan.link).toEqual({ ok: true, mbps: expect.any(Number) });
    expect(t.transfers.transfer).toHaveBeenCalledTimes(1);
    const req = t.transfers.transfer.mock.calls[0][0];
    expect(req).toMatchObject({ idx: 0, part: 0, size: 16777216, sha256: LINK_SHA, srcServerId: "s1", dstServerId: "s2", maxTimeSec: 120 });
    expect(req.moveId).toMatch(/^probe[0-9a-f]{20}$/);
    const cleanups = t.send.mock.calls.filter((c) => String(c[1]).includes("TUGRA_VX_CLEANUP_DONE"));
    expect(cleanups.map((c) => c[0]).sort()).toEqual(["s1", "s2"]);
    for (const c of cleanups) expect(c[1]).toContain(`rm -rf /etc/tugra/app-moves/${req.moveId}`);
  });

  it("a failed transfer is link_probe_failed with a scrubbed hint, and the probe dir is still removed", async () => {
    const t = make({ transfer: jest.fn().mockResolvedValue({ ok: false, sendExit: 22, recvExit: 0, detail: "source exit 22: curl: (22) 413 https://hub.example.com/api/v1/agent-vx/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB" }) });
    const r = await t.svc.preflight("u1", "capp", withLink);
    const b = r.blockers.find((x) => x.code === "link_probe_failed")!;
    expect(b).toBeDefined();
    expect(String((b.details as { hint: string }).hint)).toContain("413");
    expect(JSON.stringify(r)).not.toContain("sig=");
    expect(JSON.stringify(r)).not.toContain("agent-vx/t/AAAA");
    expect(r.plan.link).toEqual({ ok: false, mbps: null });
    expect(t.send.mock.calls.filter((c) => String(c[1]).includes("TUGRA_VX_CLEANUP_DONE"))).toHaveLength(2);
  });

  it("cannot create the probe file -> link_probe_failed (no transfer attempted)", async () => {
    const send = jest.fn(async (_id: string, script: string) => (script.includes("head -c") ? { exitCode: 1, output: "disk full" } : { exitCode: 0, output: script.includes("TUGRA_VX_CLEANUP_DONE") ? "TUGRA_VX_CLEANUP_DONE\n" : "" }));
    const t = make({ send: send as never });
    const link = await t.pre.probeLinkBetween({ id: "s1", capabilities: ["backup"] } as never, { id: "s2", capabilities: ["backup"] } as never);
    expect(link).toEqual({ ok: false, mbps: null, hint: "could not create the probe file on the source" });
    expect(t.transfers.transfer).not.toHaveBeenCalled();
  });

  it("is skipped (null) when a side is offline / too old / lacks the backup capability — the preflight reports those itself", async () => {
    const t = make({ online: { s1: true, s2: false } });
    expect(await t.pre.probeLinkBetween({ id: "s1", capabilities: ["backup"] } as never, { id: "s2", capabilities: ["backup"] } as never)).toBeNull();
    expect(await make({ supports: false }).pre.probeLinkBetween({ id: "s1", capabilities: ["backup"] } as never, { id: "s2", capabilities: ["backup"] } as never)).toBeNull();
    expect(await make().pre.probeLinkBetween({ id: "s1", capabilities: ["deploy"] } as never, { id: "s2", capabilities: ["backup"] } as never)).toBeNull();
  });

  it("a busy relay is retried with backoff (not a failure)", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      const transfer = jest.fn().mockResolvedValueOnce({ ok: false, busy: true, sendExit: null, recvExit: null, detail: "relay busy" }).mockResolvedValueOnce({ ok: true, bytes: 16777216 });
      const t = make({ transfer });
      const p = t.pre.probeLinkBetween({ id: "s1", capabilities: ["backup"] } as never, { id: "s2", capabilities: ["backup"] } as never);
      await jest.advanceTimersByTimeAsync(1500);
      expect(await p).toMatchObject({ ok: true });
      expect(transfer).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("no link test unless asked (probeLink:false never transfers)", async () => {
    const t = make();
    await t.svc.preflight("u1", "capp", input);
    expect(t.transfers.transfer).not.toHaveBeenCalled();
    expect((await t.svc.preflight("u1", "capp", input)).plan.link).toBeNull();
  });
});

describe("AppMovesService views", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "mv1", appId: "capp", appName: "blog", teamId: "t1", requestedBy: "u1", sourceServerId: "s1", targetServerId: "s2", phase: "TRANSFERRING", prevStatus: "RUNNING",
    plan: { cheap: false }, acks: { hostMounts: true }, repointDns: false, retainDays: 7, snapshotBefore: { secret: "x" },
    volumes: [
      { name: "data", dockerName: "tugra_appv_capp_data", kind: "app", sizeBytes: 1000, state: "APPLIED", parts: 4, partsDone: 4, bytesDone: 500, entries: 3, createdOnTarget: true, archiveOverwritten: false },
      { name: "cache", dockerName: "tugra_appv_capp_cache", kind: "app", sizeBytes: 500, state: "PENDING", parts: 0, partsDone: 0, bytesDone: 0, entries: null, createdOnTarget: false, archiveOverwritten: false },
      { name: "skip", dockerName: "x", kind: "app", sizeBytes: null, state: "SKIPPED", parts: 0, partsDone: 0, bytesDone: 0, entries: null, createdOnTarget: false, archiveOverwritten: false },
    ],
    warnings: [{ code: "history_splits" }], failureReason: null, failurePhase: null, logTail: "tail", cancelRequested: false, deploymentId: null,
    cutoverAt: null, finishedAt: null, archiveUntil: null, sourcePurgedAt: null, targetPurgedAt: null, createdAt: new Date("2026-11-15T10:00:00Z"), ...over,
  });

  it("progress + cancel rules; writer-only plan/acks/logTail; snapshotBefore never exposed", () => {
    const { svc } = make();
    const w = svc.toView(row() as never, true);
    expect(w.progress).toEqual({ volumeIndex: 1, volumeCount: 2, bytesDone: 500, bytesTotal: 1500 });
    expect(w.canCancel).toBe(true);
    expect(w.plan).toEqual({ cheap: false });
    expect(w.acks).toEqual({ hostMounts: true });
    expect(w.logTail).toBe("tail");
    expect(JSON.stringify(w)).not.toContain("snapshotBefore");
    const r = svc.toView(row() as never, false);
    expect([r.plan, r.acks, r.logTail]).toEqual([null, null, null]);
  });

  it("canCancel is false from DEPLOYING on, after a cancel request, and in terminal phases; needsAttention only for an unpurged FAILED", () => {
    const { svc } = make();
    for (const phase of ["DEPLOYING", "FINALIZING", "COMPLETED", "ROLLING_BACK", "ROLLED_BACK", "FAILED"]) expect(svc.toView(row({ phase }) as never, true).canCancel).toBe(false);
    expect(svc.toView(row({ cancelRequested: true }) as never, true).canCancel).toBe(false);
    expect(svc.toView(row({ phase: "FAILED" }) as never, true).needsAttention).toBe(true);
    expect(svc.toView(row({ phase: "FAILED", sourcePurgedAt: new Date(), targetPurgedAt: new Date() }) as never, true).needsAttention).toBe(false);
    expect(svc.toView(row({ phase: "ROLLED_BACK" }) as never, true).needsAttention).toBe(false);
  });

  it("list(active) returns at most the live move; get 404s for a foreign move id", async () => {
    const t = make({ moves: [row()] });
    expect(await t.svc.list("u1", "capp", { active: true })).toHaveLength(1);
    expect(t.prisma.appMove.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1, where: expect.objectContaining({ appId: "capp", phase: { notIn: ["COMPLETED", "ROLLED_BACK", "FAILED"] } }) }));
    t.prisma.appMove.findMany.mockClear();
    await t.svc.list("u1", "capp", { limit: 500 });
    expect(t.prisma.appMove.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    t.prisma.appMove.findFirst.mockResolvedValue(null);
    await expect(t.svc.get("u1", "capp", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reads need team membership (a non-member gets 403) and hide writer fields from a reader", async () => {
    await expect(make({ member: false }).svc.list("u1", "capp")).rejects.toBeInstanceOf(ForbiddenException);
    const t = make({ perms: new Set(), moves: [row()] });
    const [v] = await t.svc.list("u1", "capp");
    expect(v.plan).toBeNull();
    expect(v.logTail).toBeNull();
  });
});
