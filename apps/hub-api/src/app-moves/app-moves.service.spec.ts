import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

function make(opts: { transfer?: jest.Mock; app?: Record<string, unknown> | null; perms?: Set<string>; member?: boolean; targetTeam?: string; owner?: boolean; send?: jest.Mock; online?: Record<string, boolean>; supports?: boolean; moves?: Record<string, unknown>[]; importTasks?: Record<string, unknown>[] } = {}) {
  const app = opts.app === undefined ? APP : opts.app && { ...APP, ...opts.app };
  const servers: Record<string, ReturnType<typeof srv>> = { s1: srv("s1"), s2: srv("s2", { teamId: opts.targetTeam ?? "t1" }) };
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(app), findMany: jest.fn().mockResolvedValue([]) },
    server: { findUnique: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(servers[where.id] ?? null)) },
    user: { findUnique: jest.fn().mockResolvedValue({ isInstanceOwner: !!opts.owner }) },
    appDatabaseLink: { count: jest.fn().mockResolvedValue(0) },
    rolloutTarget: { count: jest.fn().mockResolvedValue(0) },
    deployment: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
    bulkTask: { findMany: jest.fn().mockResolvedValue(opts.importTasks ?? []) },
    appMove: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(opts.moves ?? []),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "mvNEW", createdAt: new Date(), ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    database: { findMany: jest.fn().mockResolvedValue([]) },
    volumeBackup: { findMany: jest.fn().mockResolvedValue([]) },
    backupDestination: { findMany: jest.fn().mockResolvedValue([]) },
    domain: { count: jest.fn().mockResolvedValue(0) },
    appServiceDomain: { count: jest.fn().mockResolvedValue(0) },
    environment: { findUnique: jest.fn().mockResolvedValue({ id: "env1", projectId: "p1" }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: undefined as unknown as jest.Mock,
  };
  prisma.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(prisma));

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
  const runner = { run: jest.fn().mockResolvedValue(undefined), requestCancel: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const svc = new AppMovesService(prisma as never, access as never, audit as never, pre, runner as never, agentWs as never);
  return { svc, pre, prisma, access, agentWs, send, transfers, runner, audit };
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

  it("env var NAMES in the stored warnings never reach a read-only member (a writer still sees them); other warnings keep their details", () => {
    const { svc } = make();
    const warnings = [{ code: "env_may_reference_old_host", details: { keys: ["DB_HOST", "SECRET_URL"] } }, { code: "apply_snapshot_kept", details: { volume: "data", snapshot: "tugra_restore_rb_x_0" } }, { code: "local_backups_stranded", details: { count: 2 } }];
    const r = svc.toView(row({ warnings }) as never, false);
    expect(r.warnings).toEqual([{ code: "env_may_reference_old_host" }, { code: "apply_snapshot_kept" }, { code: "local_backups_stranded", details: { count: 2 } }]);
    expect(JSON.stringify(r)).not.toMatch(/DB_HOST|SECRET_URL/);
    expect(svc.toView(row({ warnings }) as never, true).warnings).toEqual(warnings);
  });

  it("snapshotKept is true only while an apply rollback snapshot is kept", () => {
    const { svc } = make();
    expect(svc.toView(row() as never, true).snapshotKept).toBe(false);
    const kept = [{ name: "data", dockerName: "tugra_appv_capp_data", kind: "app", sizeBytes: 1, state: "APPLIED", parts: 1, partsDone: 1, bytesDone: 1, entries: 1, createdOnTarget: true, archiveOverwritten: false, rollbackKept: true }];
    expect(svc.toView(row({ phase: "ROLLED_BACK", volumes: kept }) as never, true).snapshotKept).toBe(true);
  });

  it("the runner's in-move PRECHECK re-run counts only a RUNNING non-move deploy as active; the first preflight counts queued ones too", async () => {
    const t = make();
    const s1 = srv("s1") as never;
    const s2 = srv("s2") as never;
    await t.pre.gatherFacts(APP as never, s1, s2, {}, "u1");
    expect((t.prisma.deployment.count as jest.Mock).mock.calls[0][0].where.status).toEqual({ in: ["QUEUED", "RUNNING"] });
    (t.prisma.deployment.count as jest.Mock).mockClear();
    await t.pre.gatherFacts(APP as never, s1, s2, {}, "u1", "mvX");
    expect((t.prisma.deployment.count as jest.Mock).mock.calls[0][0].where.status).toBe("RUNNING");
  });

  it("a migration import that still provisions or may still stream data into the app blocks the move (migration_import_active); a finished, cancelled-away or rolled-back one does not", async () => {
    const future = new Date(Date.now() + 60_000);
    const task = (op: Record<string, unknown>) => ({ operation: { meta: {}, migrationTokenHash: null, migrationTokenExpiresAt: null, tasks: [{ status: "DONE" }], ...op } });
    const blocked = async (importTasks: Record<string, unknown>[]) => (await make({ importTasks }).svc.preflight("u1", "capp", input)).blockers.some((b) => b.code === "migration_import_active");
    expect(await blocked([])).toBe(false);
    expect(await blocked([task({ tasks: [{ status: "DONE" }, { status: "AWAITING_CUTOVER" }] })])).toBe(true);
    expect(await blocked([task({ tasks: [{ status: "DONE" }, { status: "RUNNING" }] })])).toBe(true);
    expect(await blocked([task({ migrationTokenHash: "h", migrationTokenExpiresAt: future })])).toBe(true); // a live token may still ingest data
    expect(await blocked([task({ migrationTokenHash: "h", migrationTokenExpiresAt: new Date(Date.now() - 1) })])).toBe(false);
    expect(await blocked([task({})])).toBe(false);
    expect(await blocked([task({ meta: { rolledBackAt: "2026-11-01" }, tasks: [{ status: "RUNNING" }] })])).toBe(false);
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


describe("AppMovesService.start", () => {
  const startInput = { targetServerId: "s2", acknowledge: {}, repointDns: false, archiveRetainDays: 7, confirmName: "blog" } as never;

  it("re-runs the FULL preflight, inserts a frozen QUEUED job, audits (ids only) and kicks the runner in-process", async () => {
    const t = make();
    const r = await t.svc.start("u1", "capp", startInput);
    expect(r).toEqual({ moveId: "mvNEW", phase: "QUEUED" });
    expect(t.send).toHaveBeenCalledTimes(2); // both hosts probed again server-side
    const data = (t.prisma.appMove.create as jest.Mock).mock.calls[0][0].data;
    expect(data).toMatchObject({ appId: "capp", appName: "blog", teamId: "t1", requestedBy: "u1", sourceServerId: "s1", targetServerId: "s2", prevStatus: "RUNNING", repointDns: false, retainDays: 7 });
    expect(data.plan).toMatchObject({ cheap: false, totalBytes: 2048 * 1024, partBytes: 256 * 1024 * 1024 });
    expect(data.volumes).toEqual([expect.objectContaining({ name: "data", dockerName: "tugra_appv_capp_data", state: "PENDING", parts: 0, partsDone: 0, bytesDone: 0, entries: null, createdOnTarget: false })]);
    expect(data.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "history_splits" })]));
    expect(t.runner.run).toHaveBeenCalledWith("mvNEW");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ actor: "u1", action: "app.move.start", target: "capp", meta: expect.objectContaining({ moveId: "mvNEW", from: "s1", to: "s2" }) }));
    expect(JSON.stringify(t.audit.log.mock.calls)).not.toMatch(/hunter2|envEnc/);
  });

  it("rows are inserted under the app's FOR UPDATE lock", async () => {
    const t = make();
    await t.svc.start("u1", "capp", startInput);
    expect(String((t.prisma.$queryRaw as jest.Mock).mock.calls[0][0].join(""))).toContain('FOR UPDATE');
  });

  it("confirmName must equal the app name (400 confirm_name_mismatch) and nothing is probed", async () => {
    const t = make();
    const e = await t.svc.start("u1", "capp", { ...(startInput as object), confirmName: "Blog" } as never).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as BadRequestException).getResponse()).toMatchObject({ code: "confirm_name_mismatch" });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.runner.run).not.toHaveBeenCalled();
  });

  it("a preflight with blockers is 409 preflight_failed carrying the FRESH result; a stale/missing ack is one too; nothing is inserted", async () => {
    const t = make({ app: { hostMounts: [{ hostPath: "/mnt/x", containerPath: "/x" }] } });
    const e = (await t.svc.start("u1", "capp", startInput).catch((x: unknown) => x)) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    const body = e.getResponse() as { code: string; preflight: { ok: boolean; blockers: { code: string }[] } };
    expect(body.code).toBe("preflight_failed");
    expect(body.preflight.ok).toBe(false);
    expect(body.preflight.blockers.map((b) => b.code)).toContain("host_mounts");
    expect(t.prisma.appMove.create).not.toHaveBeenCalled();
    expect(t.runner.run).not.toHaveBeenCalled();
    // with the ack it starts (the target probe also reports the bind-mount path)
    const withHostPath = jest.fn(async (id: string) => ({ exitCode: 0, output: id === "s1" ? PROBE_OUT("tugra_appv_capp_data", 2048) : TARGET_PROBE("tugra_appv_capp_data").replace("TUGRA_PROBE_END", "TUGRA_HOSTPATH /mnt/x 1\nTUGRA_PROBE_END") }));
    const ok = await make({ send: withHostPath as never, app: { hostMounts: [{ hostPath: "/mnt/x", containerPath: "/x" }] } }).svc.start("u1", "capp", { ...(startInput as object), acknowledge: { hostMounts: true } } as never);
    expect(ok.moveId).toBe("mvNEW");
  });

  it("two concurrent starts: the partial unique index (P2002) is 409 move_active", async () => {
    const t = make();
    (t.prisma.appMove.create as jest.Mock).mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }));
    const e = (await t.svc.start("u1", "capp", startInput).catch((x: unknown) => x)) as ConflictException;
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: "move_active" });
    expect(t.runner.run).not.toHaveBeenCalled();
  });

  it("the locked re-check refuses a deploy that slipped in (409 deploy_active) or an app that changed (409 changed_under_us)", async () => {
    const busy = make();
    (busy.prisma.deployment.count as jest.Mock).mockImplementation(({ where }: { where: { status?: unknown } }) => Promise.resolve(where.status ? 1 : 0));
    // the preflight's own deploy count would block first; make ONLY the in-tx count see it
    (busy.prisma.deployment.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValue(1);
    expect(((await busy.svc.start("u1", "capp", startInput).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "deploy_active" });

    const changed = make();
    (changed.prisma.application.findUnique as jest.Mock).mockResolvedValueOnce(APP).mockResolvedValue({ serverId: "other", status: "RUNNING" });
    expect(((await changed.svc.start("u1", "capp", startInput).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "changed_under_us" });
  });

  it("authorization: a reader/other-permission member is 403; a cross-team target is 404; no probe, no row", async () => {
    const reader = make({ perms: new Set(["apps:config", "apps:deploy"]) }); // lacks backups
    await expect(reader.svc.start("u1", "capp", startInput)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ targetTeam: "t2" }).svc.start("u1", "capp", startInput)).rejects.toBeInstanceOf(NotFoundException);
    expect(reader.send).not.toHaveBeenCalled();
    expect(reader.prisma.appMove.create).not.toHaveBeenCalled();
  });

  it("a NEW app starts without touching any agent (cheap path)", async () => {
    const t = make({ app: { status: "NEW" }, online: { s1: false, s2: false } });
    const r = await t.svc.start("u1", "capp", startInput);
    expect(r.phase).toBe("QUEUED");
    expect(t.send).not.toHaveBeenCalled();
    expect((t.prisma.appMove.create as jest.Mock).mock.calls[0][0].data.plan.cheap).toBe(true);
  });
});

describe("AppMovesService.cancel", () => {
  const mv = (phase: string) => ({ id: "mv1", appId: "capp", phase });
  it.each(["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"])("%s: flags the row (compare-and-set), kills in-flight work and audits", async (phase) => {
    const t = make();
    (t.prisma.appMove.findFirst as jest.Mock).mockResolvedValue(mv(phase));
    await t.svc.cancel("u1", "capp", "mv1");
    expect(t.prisma.appMove.updateMany).toHaveBeenCalledWith({ where: { id: "mv1", phase: { in: ["QUEUED", "PRECHECK", "STOPPING_SOURCE", "TRANSFERRING"] } }, data: { cancelRequested: true } });
    expect(t.runner.requestCancel).toHaveBeenCalledWith("mv1");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.move.cancel" }));
  });

  it.each(["DEPLOYING", "FINALIZING"])("%s: 409 move_past_cutover (nothing is flagged or killed)", async (phase) => {
    const t = make();
    (t.prisma.appMove.findFirst as jest.Mock).mockResolvedValue(mv(phase));
    const e = (await t.svc.cancel("u1", "capp", "mv1").catch((x: unknown) => x)) as ConflictException;
    expect(e.getResponse()).toMatchObject({ code: "move_past_cutover" });
    expect(t.prisma.appMove.updateMany).not.toHaveBeenCalled();
    expect(t.runner.requestCancel).not.toHaveBeenCalled();
  });

  it("losing the race to the cutover is also 409 move_past_cutover; a finished move is move_not_active; an unknown move 404", async () => {
    const raced = make();
    (raced.prisma.appMove.findFirst as jest.Mock).mockResolvedValue(mv("TRANSFERRING"));
    (raced.prisma.appMove.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    expect(((await raced.svc.cancel("u1", "capp", "mv1").catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "move_past_cutover" });
    for (const phase of ["COMPLETED", "ROLLED_BACK", "FAILED", "ROLLING_BACK"]) {
      const t = make();
      (t.prisma.appMove.findFirst as jest.Mock).mockResolvedValue(mv(phase));
      expect(((await t.svc.cancel("u1", "capp", "mv1").catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "move_not_active" });
    }
    await expect(make().svc.cancel("u1", "capp", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("needs the mutation permissions (a reader cannot cancel)", async () => {
    await expect(make({ perms: new Set() }).svc.cancel("u1", "capp", "mv1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("AppMovesService.purgeSource", () => {
  const MVID = "ckmv1abcdefghijklmnopqrst";
  const vols = [{ name: "data", dockerName: "tugra_appv_capp_data", kind: "app", state: "APPLIED", createdOnTarget: true, archiveOverwritten: false }];
  const move = (over: Record<string, unknown> = {}) => ({ id: MVID, appId: "capp", phase: "COMPLETED", sourceServerId: "s1", targetServerId: "s2", volumes: vols, sourcePurgedAt: null, targetPurgedAt: null, ...over });
  const purgeOut = (state: string) => ({ exitCode: 0, output: `TUGRA_VX_VOL tugra_appv_capp_data ${state}\nTUGRA_VX_CLEANUP_DONE\n` });

  function setup(m: Record<string, unknown>, opts: { appServer?: string; sendOut?: { exitCode: number; output: string }; online?: Record<string, boolean> } = {}) {
    const t = make({ online: opts.online ?? { s1: true, s2: true }, send: jest.fn().mockResolvedValue(opts.sendOut ?? purgeOut("removed")) as never });
    (t.prisma.appMove.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.id === MVID && where.appId === "capp" ? m : null));
    (t.prisma.application.findUnique as jest.Mock).mockResolvedValue({ ...APP, serverId: opts.appServer ?? "s2" });
    return t;
  }

  it("COMPLETED: removes the archived source volumes on the SOURCE host and stamps sourcePurgedAt", async () => {
    const t = setup(move());
    await t.svc.purgeSource("u1", "capp", MVID);
    expect(t.send).toHaveBeenCalledWith("s1", expect.stringContaining("docker volume rm 'tugra_appv_capp_data'"), "backup", expect.any(Number));
    expect(t.prisma.appMove.update).toHaveBeenCalledWith({ where: { id: MVID }, data: { sourcePurgedAt: expect.any(Date) } });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.move.purge_source" }));
  });

  it("409 archive_in_use when the app currently runs on that server (nothing removed, nothing stamped)", async () => {
    const t = setup(move(), { appServer: "s1" });
    expect(((await t.svc.purgeSource("u1", "capp", MVID).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "archive_in_use" });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.prisma.appMove.update).not.toHaveBeenCalled();
  });

  it("409 archive_in_use when another live move targets/uses that server for the app", async () => {
    const t = setup(move());
    (t.prisma.appMove.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.id === MVID ? move() : { id: "other" }));
    expect(((await t.svc.purgeSource("u1", "capp", MVID).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "archive_in_use" });
    expect(t.send).not.toHaveBeenCalled();
  });

  it("an offline source is 503; a volume docker refused to remove (in use) is 409 purge_incomplete with NO stamp", async () => {
    await expect(setup(move(), { online: { s1: false, s2: true } }).svc.purgeSource("u1", "capp", MVID)).rejects.toBeInstanceOf(ServiceUnavailableException);
    const t = setup(move(), { sendOut: purgeOut("kept") });
    expect(((await t.svc.purgeSource("u1", "capp", MVID).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "purge_incomplete" });
    expect(t.prisma.appMove.update).not.toHaveBeenCalled();
  });

  it("an already-purged archive is 409 nothing_to_purge", async () => {
    const t = setup(move({ sourcePurgedAt: new Date() }));
    expect(((await t.svc.purgeSource("u1", "capp", MVID).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "nothing_to_purge" });
  });

  const cleanOut = { exitCode: 0, output: `TUGRA_VX_VOL tugra_appv_capp_data removed\nTUGRA_VX_VOL tugra_restore_rb_${MVID}_0 absent\nTUGRA_VX_CLEANUP_DONE\n` };

  it("FAILED with the app back on the source: a human clears 'needs attention' - the target cleanup runs and BOTH stamps are written", async () => {
    const t = setup(move({ phase: "FAILED" }), { appServer: "s1", sendOut: cleanOut });
    await t.svc.purgeSource("u1", "capp", MVID);
    expect(t.send).toHaveBeenCalledWith("s2", expect.stringContaining(`rm -rf /etc/tugra/app-moves/${MVID}`), "backup", expect.any(Number));
    const stamps = (t.prisma.appMove.update as jest.Mock).mock.calls.map((c) => c[0].data);
    expect(stamps).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePurgedAt: expect.any(Date), targetPurgedAt: expect.any(Date) })]));
  });

  it("FAILED with the app LIVE on the target (the cutover had committed): NOTHING is removed, the alert is cleared, the audit says skipped_live", async () => {
    const t = setup(move({ phase: "FAILED" }), { appServer: "s2", sendOut: cleanOut });
    await t.svc.purgeSource("u1", "capp", MVID);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.prisma.appMove.update).toHaveBeenCalledWith({ where: { id: MVID }, data: { sourcePurgedAt: expect.any(Date), targetPurgedAt: expect.any(Date) } });
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.move.purge_source", meta: expect.objectContaining({ outcome: "skipped_live" }) }));
  });

  it("FAILED with another live move of the app on the target server: nothing is removed either", async () => {
    const t = setup(move({ phase: "FAILED" }), { appServer: "s1", sendOut: cleanOut });
    (t.prisma.appMove.findFirst as jest.Mock).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => (where.id === MVID ? move({ phase: "FAILED" }) : { id: "other" }));
    await t.svc.purgeSource("u1", "capp", MVID);
    expect(t.send).not.toHaveBeenCalled();
  });

  it("FAILED with the target offline is still cleared, but targetPurgedAt is NOT stamped (the leftovers are still there)", async () => {
    const t = setup(move({ phase: "FAILED" }), { appServer: "s1", online: { s1: true, s2: false } });
    await t.svc.purgeSource("u1", "capp", MVID);
    expect(t.prisma.appMove.update).toHaveBeenCalledWith({ where: { id: MVID }, data: { sourcePurgedAt: expect.any(Date) } });
    // a later retry is still possible: the move is not "nothing_to_purge"
    const again = setup(move({ phase: "FAILED", sourcePurgedAt: new Date() }), { appServer: "s1", sendOut: cleanOut });
    await again.svc.purgeSource("u1", "capp", MVID);
    expect(again.send).toHaveBeenCalled();
  });

  it("an explicit purge also removes the kept apply rollback snapshot and spends its flag + warning; automatic cleanup never does", async () => {
    const kept = [{ ...vols[0], rollbackKept: true }];
    const t = setup(move({ phase: "ROLLED_BACK", targetPurgedAt: new Date(), volumes: kept, warnings: [{ code: "apply_snapshot_kept" }, { code: "dns_repoint_failed" }] }), {
      appServer: "s1",
      sendOut: cleanOut,
    });
    await t.svc.purgeSource("u1", "capp", MVID); // not "nothing_to_purge": a kept snapshot is left
    expect(t.send.mock.calls[0][1]).toContain(`tugra_restore_rb_${MVID}_0`);
    expect(t.prisma.appMove.update).toHaveBeenCalledWith({
      where: { id: MVID },
      data: { targetPurgedAt: expect.any(Date), volumes: [{ ...vols[0], rollbackKept: false }], warnings: [{ code: "dns_repoint_failed" }] },
    });
  });

  it("ROLLED_BACK leftovers are retried; an active move is refused", async () => {
    const t = setup(move({ phase: "ROLLED_BACK" }), { appServer: "s1", sendOut: cleanOut });
    await t.svc.purgeSource("u1", "capp", MVID);
    expect(t.prisma.appMove.update).toHaveBeenCalledWith({ where: { id: MVID }, data: { targetPurgedAt: expect.any(Date) } });
    const live = setup(move({ phase: "TRANSFERRING" }));
    expect(((await live.svc.purgeSource("u1", "capp", MVID).catch((x: unknown) => x)) as ConflictException).getResponse()).toMatchObject({ code: "move_active" });
  });
});
