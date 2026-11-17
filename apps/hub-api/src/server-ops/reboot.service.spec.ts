import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { RebootService } from "./reboot.service";
import { rebootTiming } from "./reboot-logic";

// ── an in-memory ServerReboot table + the few other models the service reads ────────────────────────────────────────
type Row = Record<string, unknown> & { id: string; serverId: string; state: string };

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ("not" in c) return v !== c.not;
      if ("in" in c) return (c.in as unknown[]).includes(v);
    }
    return v === cond;
  });
}

function makeTable() {
  const rows: Row[] = [];
  let seq = 0;
  const clone = (r: Row) => ({ ...r });
  return {
    rows,
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const active = rows.find((r) => r.serverId === data.serverId && r.state !== "DONE");
      if (active && data.state !== "DONE") throw new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" });
      const now = new Date();
      const row = { startedAt: null, agentBackAt: null, verifiedAt: null, result: null, snapshot: null, report: null, scheduledAt: null, ...data, id: `r${++seq}`, createdAt: now, updatedAt: now } as unknown as Row;
      rows.push(row);
      return clone(row);
    }),
    findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => {
      const r = [...rows].reverse().find((x) => matches(x, where));
      return r ? clone(r) : null;
    }),
    findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> }) => rows.filter((x) => matches(x, where)).map(clone)),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? clone(r) : null;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id);
      if (!r) throw new Error("not found");
      Object.assign(r, data, { updatedAt: new Date() });
      return clone(r);
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((x) => matches(x, where));
      for (const r of hit) Object.assign(r, data, { updatedAt: new Date() });
      return { count: hit.length };
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => {
      const i = rows.findIndex((x) => x.id === where.id);
      if (i >= 0) rows.splice(i, 1);
      return {};
    }),
  };
}

const SERVER = { id: "s1", name: "prod-1", teamId: "t1", isLocal: false, proxyBind: "public" };

/** Decode what a host-exec wrapper would run on the host (the payload travels as base64 in an env var). */
function hostInner(cmd: string): string | null {
  const m = /TUGRA_PATCH_B64='([A-Za-z0-9+/=]+)'/.exec(cmd);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : null;
}

const OLD_BOOT = "boot-old";
const NEW_BOOT = "boot-new";

interface World {
  online: boolean;
  bootId: string;
  docker: boolean;
  /** container lines `name state health policy swarm image` */
  containers: string[];
  domainCodes: Record<string, number>;
  patchRunning: boolean;
  systemd: boolean;
  rebootRequired: boolean;
  startOutput: string;
  startThrows: Error | null;
  stateThrows: boolean;
  probeUnavailable: boolean;
  /** the boot-id read (the watcher's look at a returned agent) always fails */
  bootThrows: boolean;
  /** an OS update's helper holds the host-exec container name */
  helperBusy: boolean;
  /** the host's reboot-required flag cannot be read */
  flagUnreadable: boolean;
}

const RUNNING = ["web running healthy unless-stopped 0 nginx:1", "db running none always 0 postgres:16", "scratch running none no 0 busybox"];

function makeWorld(over: Partial<World> = {}): World {
  return {
    online: true,
    bootId: OLD_BOOT,
    docker: true,
    containers: [...RUNNING],
    domainCodes: { "app.example.com": 200 },
    patchRunning: false,
    systemd: true,
    rebootRequired: false,
    startOutput: "TUGRA_REBOOT_SCHEDULED delay=15",
    startThrows: null,
    stateThrows: false,
    probeUnavailable: false,
    bootThrows: false,
    helperBusy: false,
    flagUnreadable: false,
    ...over,
  };
}

function setup(over: { world?: Partial<World>; deployRunning?: boolean; apps?: unknown[]; server?: Partial<typeof SERVER>; table?: ReturnType<typeof makeTable> } = {}) {
  const world = makeWorld(over.world);
  const table = over.table ?? makeTable();
  const server = { ...SERVER, ...over.server };
  const state = { deployRunning: over.deployRunning ?? false };
  const prisma = {
    server: { findUnique: jest.fn().mockResolvedValue(server) },
    serverReboot: table,
    application: {
      findMany: jest.fn().mockResolvedValue(over.apps ?? [{ status: "RUNNING", domain: "app.example.com", https: true, extraDomains: [], pathPrefix: null, serviceDomains: [] }]),
    },
    deployment: { count: jest.fn().mockImplementation(async () => (state.deployRunning ? 1 : 0)) },
  };
  const access = { requirePermission: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue("OWNER") };
  const order: string[] = [];
  const audit = { log: jest.fn().mockImplementation(async (e: { action: string }) => { order.push(`audit:${e.action}`); }) };
  const sent: { cap: string; kind: string }[] = [];
  const sendCommand = jest.fn().mockImplementation(async (_id: string, cmd: string, cap: string) => {
    if (!world.online) throw new AgentOfflineException();
    const inner = hostInner(cmd);
    let kind: string;
    let output: string;
    if (inner && world.helperBusy) {
      kind = "busy";
      output = 'docker: Error response from daemon: Conflict. The container name "/tugra-patch" is already in use\n';
    } else if (inner) {
      if (inner.includes("systemd-run --unit tugra-reboot")) {
        kind = "start";
        order.push("sendCommand:start");
        if (world.startThrows) throw world.startThrows;
        output = "TUGRA_HOST_ENTERED\n" + world.startOutput + "\n";
      } else {
        kind = "preflight";
        output = ["TUGRA_HOST_ENTERED", `TUGRA_RB_SYSTEMD=${world.systemd ? 1 : 0}`, world.patchRunning ? "TUGRA_RB_PATCH_RUNNING" : "", world.flagUnreadable ? "" : `TUGRA_RB_REQUIRED=${world.rebootRequired ? 1 : 0}`, ""].join("\n");
      }
    } else if (cmd.includes("reboot-probe")) {
      kind = "probe";
      output = world.probeUnavailable ? "TUGRA_RB_PROBE=unavailable\nTUGRA_RB_PROBE_END\n" : Object.entries(world.domainCodes).map(([h, c]) => `TUGRA_RB_D ${h} ${String(c).padStart(3, "0")}`).join("\n") + "\nTUGRA_RB_PROBE_END\n";
    } else if (cmd.includes("TUGRA_RB_END")) {
      kind = "state";
      if (world.stateThrows) throw new AgentDisconnectedException();
      output = [`TUGRA_RB_BOOT=${world.bootId}`, `TUGRA_RB_DOCKER=${world.docker ? "active" : "inactive"}`, ...world.containers.map((c) => `TUGRA_RB_C ${c}`), "TUGRA_RB_END", ""].join("\n");
    } else {
      kind = "boot";
      if (world.bootThrows) throw new AgentDisconnectedException();
      output = `TUGRA_RB_BOOT=${world.bootId}\n`;
    }
    sent.push({ cap, kind });
    return { exitCode: 0, output };
  });
  const agentWs = { isOnline: jest.fn().mockImplementation(() => world.online), sendCommand };
  const notifications = { fireForEvent: jest.fn().mockResolvedValue(undefined) };
  const queue = { scheduleAt: jest.fn().mockResolvedValue(undefined), unschedule: jest.fn().mockResolvedValue(undefined), start: jest.fn().mockResolvedValue(undefined) };
  const containerMetrics = { forServer: jest.fn().mockResolvedValue({ containers: [{ name: "a" }, { name: "b" }, { name: "c" }] }) };
  const make = () =>
    new RebootService(prisma as never, access as never, audit as never, agentWs as never, notifications as never, queue as never, containerMetrics as never);
  return { svc: make(), make, world, table, prisma, access, audit, sendCommand, sent, notifications, queue, order, state, server };
}

const NOW = new Date("2026-11-27T12:00:00.000Z").getTime();
const REQ_NOW = { mode: "now" as const, confirmName: "prod-1" };

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
});

const advance = (ms: number) => jest.setSystemTime(Date.now() + ms);

describe("RebootService.request: validation and refusals (nothing runs, nothing is audited)", () => {
  it("forbids a user without servers:ops", async () => {
    const t = setup();
    t.access.requirePermission.mockRejectedValueOnce(new ForbiddenException("insufficient role"));
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(/insufficient role/);
    expect(t.audit.log).not.toHaveBeenCalled();
    expect(t.sendCommand).not.toHaveBeenCalled();
  });

  it("404 for an unknown server", async () => {
    const t = setup();
    t.prisma.server.findUnique.mockResolvedValueOnce(null);
    await expect(t.svc.request("u1", "nope", REQ_NOW)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires the typed confirmation to equal the server name exactly", async () => {
    for (const confirmName of ["", "prod", "PROD-1", "prod-1 ", "prod-12"]) {
      const t = setup();
      await expect(t.svc.request("u1", "s1", { mode: "now", confirmName })).rejects.toBeInstanceOf(BadRequestException);
      expect(t.table.create).not.toHaveBeenCalled();
      expect(t.audit.log).not.toHaveBeenCalled();
      expect(t.sendCommand).not.toHaveBeenCalled();
    }
  });

  it("rejects a schedule in the past, under a minute away, past 7 days, or unparseable", async () => {
    for (const at of [new Date(NOW - 60_000).toISOString(), new Date(NOW + 20_000).toISOString(), new Date(NOW + 8 * 24 * 3600_000).toISOString(), "garbage"]) {
      const t = setup();
      await expect(t.svc.request("u1", "s1", { mode: "scheduled", at, confirmName: "prod-1" })).rejects.toBeInstanceOf(BadRequestException);
      expect(t.table.create).not.toHaveBeenCalled();
      expect(t.audit.log).not.toHaveBeenCalled();
    }
  });

  it("503 when the agent is offline", async () => {
    const t = setup({ world: { online: false } });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toBeInstanceOf(AgentOfflineException);
    expect(t.table.create).not.toHaveBeenCalled();
  });

  it("409 while a deploy is running on the server, with the reason, before any host work", async () => {
    const t = setup({ deployRunning: true });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(ConflictException);
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(/deploy is running/);
    expect(t.sendCommand).not.toHaveBeenCalled();
    expect(t.table.create).not.toHaveBeenCalled();
    expect(t.audit.log).not.toHaveBeenCalled();
    // the deploy lookup covers apps hosted, built and run on this server
    expect(t.prisma.deployment.count.mock.calls[0][0].where).toEqual({ status: "RUNNING", OR: [{ runServerId: "s1" }, { application: { serverId: "s1" } }, { application: { buildServerId: "s1" } }] });
  });

  it("409 while an OS update (patch unit) is running on the host", async () => {
    const t = setup({ world: { patchRunning: true } });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(/OS update is running/);
    expect(t.table.create).not.toHaveBeenCalled();
    expect(t.audit.log).not.toHaveBeenCalled();
    expect(t.sent.map((s) => s.kind)).toEqual(["preflight"]); // nothing was armed
  });

  it("400 on a host without systemd", async () => {
    const t = setup({ world: { systemd: false } });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(/no systemd/);
    expect(t.table.create).not.toHaveBeenCalled();
  });

  it("409 while another reboot is scheduled or running (and the DB's one-live-reboot index backs it up)", async () => {
    const t = setup();
    const at = new Date(NOW + 3600_000).toISOString();
    await t.svc.request("u1", "s1", { mode: "scheduled", at, confirmName: "prod-1" });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(/already scheduled.*cancel it first/);
    // a request that slips past the check still loses at the unique index
    t.table.findFirst.mockResolvedValueOnce(null);
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("RebootService.request: an immediate reboot", () => {
  it("audits BEFORE it runs anything on the host", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", REQ_NOW);
    const auditAt = t.order.indexOf("audit:server.reboot.request");
    const startAt = t.order.indexOf("sendCommand:start");
    expect(auditAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(auditAt);
    expect(t.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "server.reboot.request", target: "s1", meta: expect.objectContaining({ mode: "now", rebootId: "r1" }) });
  });

  it("does not run if the audit entry cannot be written (and leaves no row behind)", async () => {
    const t = setup();
    t.audit.log.mockRejectedValueOnce(new Error("audit down"));
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow("audit down");
    expect(t.order).not.toContain("sendCommand:start");
    expect(t.table.rows).toHaveLength(0);
  });

  it("snapshots what should come back, then arms the unit and reports REBOOTING", async () => {
    const t = setup();
    const v = await t.svc.request("u1", "s1", REQ_NOW);
    expect(v).toMatchObject({ state: "REBOOTING", mode: "now", result: null, serverId: "s1", requestedBy: "u1" });
    expect(v.startedAt).toBe(new Date(NOW).toISOString());
    expect(v.snapshot).toEqual({ containers: 3, domains: 1, hostsHub: false });
    const row = t.table.rows[0];
    expect(row.snapshot).toMatchObject({
      version: 1,
      bootId: OLD_BOOT,
      probe: "loopback",
      domains: [{ host: "app.example.com", scheme: "https", path: "/" }],
      containers: [
        { name: "web", image: "nginx:1", restartPolicy: "unless-stopped", health: "healthy", swarm: false },
        { name: "db", image: "postgres:16", restartPolicy: "always", health: "none", swarm: false },
        { name: "scratch", image: "busybox", restartPolicy: "no", health: "none", swarm: false },
      ],
    });
    // the snapshot is taken BEFORE the unit is armed; everything goes through the `patch` capability
    expect(t.sent.map((s) => s.kind)).toEqual(["preflight", "state", "probe", "start"]);
    expect(new Set(t.sent.map((s) => s.cap))).toEqual(new Set(["patch"]));
  });

  it("arms a delayed unit on the host (systemd-run --on-active=15s systemctl reboot), via the host-exec helper", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", REQ_NOW);
    const startCall = t.sendCommand.mock.calls.find(([, cmd]) => hostInner(cmd as string)?.includes("systemd-run --unit tugra-reboot"));
    expect(startCall).toBeTruthy();
    const inner = hostInner(startCall![1] as string)!;
    expect(inner).toContain("--on-active=15s");
    expect(inner).toContain("systemctl reboot");
    expect(startCall![1]).toContain("nsenter -t 1");
  });

  it("marks a server that hosts the hub", async () => {
    const t = setup({ server: { isLocal: true } });
    const v = await t.svc.request("u1", "s1", REQ_NOW);
    expect(v.snapshot?.hostsHub).toBe(true);
  });

  it("a proxy with no host port is recorded as not probeable", async () => {
    const t = setup({ server: { proxyBind: "none" } });
    await t.svc.request("u1", "s1", REQ_NOW);
    expect(t.table.rows[0].snapshot).toMatchObject({ probe: "skipped_no_host_port" });
  });

  it("only RUNNING apps' domains are snapshotted (the query asks for them)", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", REQ_NOW);
    expect(t.prisma.application.findMany.mock.calls[0][0].where).toEqual({ serverId: "s1", status: "RUNNING" });
  });

  it.each([
    ["systemd-run refuses", "TUGRA_REBOOT_START_FAILED\nAccess denied", ServiceUnavailableException, "start_failed"],
    ["an update unit appears in the meantime", "TUGRA_REBOOT_BUSY=patch", ConflictException, "busy_patch"],
    ["the host has no systemd", "TUGRA_REBOOT_UNSUPPORTED reason=no-systemd", BadRequestException, "unsupported"],
  ])("a failed arming (%s) is a clear error, the row ends FAILED, nothing is left pending", async (_n, output, errType, reason) => {
    const t = setup({ world: { startOutput: output } });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toBeInstanceOf(errType);
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe(reason);
  });

  it("a connection that drops while arming is NOT assumed to have failed: the watcher decides by boot id", async () => {
    const t = setup({ world: { startThrows: new AgentDisconnectedException() } });
    const v = await t.svc.request("u1", "s1", REQ_NOW);
    expect(v.state).toBe("REBOOTING");
  });

  it("does not notify for a refusal the caller saw synchronously", async () => {
    const t = setup({ world: { startOutput: "TUGRA_REBOOT_START_FAILED" } });
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
  });
});

describe("scheduled reboots", () => {
  const at = () => new Date(NOW + 2 * 3600_000).toISOString();
  const sched = { mode: "scheduled" as const, confirmName: "prod-1" };

  it("queues a delayed job and runs NOTHING on the host yet; audited as a schedule", async () => {
    const t = setup();
    const v = await t.svc.request("u1", "s1", { ...sched, at: at() });
    expect(v).toMatchObject({ state: "SCHEDULED", mode: "scheduled", scheduledAt: at() });
    expect(t.queue.scheduleAt).toHaveBeenCalledWith("r1", new Date(at()));
    expect(t.sent.map((s) => s.kind)).toEqual(["preflight"]); // only the read-only support check
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.reboot.schedule", meta: expect.objectContaining({ at: at() }) }));
  });

  it("a scheduled reboot is accepted even while a deploy runs now (it only has to be free when it fires)", async () => {
    const t = setup({ deployRunning: true });
    const v = await t.svc.request("u1", "s1", { ...sched, at: at() });
    expect(v.state).toBe("SCHEDULED");
  });

  it("cancel: DONE(cancelled), the queued job is dropped, audited, no notification", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    const v = await t.svc.cancel("u1", "s1");
    expect(v).toMatchObject({ state: "DONE", result: "cancelled" });
    expect(t.queue.unschedule).toHaveBeenCalledWith("r1");
    expect(t.audit.log).toHaveBeenCalledWith({ actor: "u1", action: "server.reboot.cancel", target: "s1", meta: { rebootId: "r1" } });
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
    // a cancelled reboot never fires, even when due
    advance(3 * 3600_000);
    await t.svc.tick();
    expect(t.sent.map((s) => s.kind)).toEqual(["preflight"]);
  });

  it("cancel: 404 when nothing is scheduled, 409 once the reboot has started", async () => {
    const t = setup();
    await expect(t.svc.cancel("u1", "s1")).rejects.toBeInstanceOf(NotFoundException);
    await t.svc.request("u1", "s1", REQ_NOW);
    await expect(t.svc.cancel("u1", "s1")).rejects.toThrow(/already started/);
  });

  it("cancel loses cleanly to a reboot that started in the same instant", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    t.table.rows[0].state = "STARTING"; // the watcher claimed it between the read and the write
    t.table.findFirst.mockResolvedValueOnce({ ...t.table.rows[0], state: "SCHEDULED" });
    await expect(t.svc.cancel("u1", "s1")).rejects.toThrow(/already started/);
    expect(t.table.rows[0].result).toBeNull();
  });

  it("is started by the watcher when due, even if its queue job was lost", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("SCHEDULED"); // not due yet
    advance(2 * 3600_000 + 1000);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "REBOOTING" });
    expect(t.order.indexOf("audit:server.reboot.start")).toBeLessThan(t.order.indexOf("sendCommand:start")); // the firing is audited before it runs
    expect(t.queue.unschedule).toHaveBeenCalledWith("r1");
  });

  it("survives a hub restart: a new instance re-queues every scheduled reboot with its original time and still fires it", async () => {
    const first = setup();
    await first.svc.request("u1", "s1", { ...sched, at: at() });
    // "restart": a fresh service + a fresh (empty) queue over the same database
    const second = setup({ table: first.table });
    expect(await second.svc.resyncScheduled()).toBe(1);
    expect(second.queue.scheduleAt).toHaveBeenCalledWith("r1", new Date(at()));
    advance(2 * 3600_000 + 1000);
    await second.svc.advanceById("r1"); // what the re-queued delayed job calls
    expect(first.table.rows[0].state).toBe("REBOOTING");
  });

  it("resync queues only scheduled reboots, not finished or running ones", async () => {
    const t = setup();
    t.table.rows.push({ id: "x1", serverId: "s9", state: "VERIFYING", scheduledAt: null });
    t.table.rows.push({ id: "x2", serverId: "s8", state: "DONE", scheduledAt: new Date(NOW + 1000) });
    t.table.rows.push({ id: "x3", serverId: "s7", state: "SCHEDULED", scheduledAt: new Date(NOW + 5000) });
    expect(await t.svc.resyncScheduled()).toBe(1);
    expect(t.queue.scheduleAt).toHaveBeenCalledTimes(1);
    expect(t.queue.scheduleAt).toHaveBeenCalledWith("x3", new Date(NOW + 5000));
  });

  it("waits while a deploy is running at the due time, then goes", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 1000);
    t.state.deployRunning = true;
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("SCHEDULED");
    expect(t.order).not.toContain("sendCommand:start");
    t.state.deployRunning = false;
    advance(60_000);
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("REBOOTING");
  });

  it("gives up (FAILED busy_deploy + notification) when the server stays busy past the retry window", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    t.state.deployRunning = true;
    advance(2 * 3600_000 + 1000);
    await t.svc.tick(); // due, blocked: keeps waiting
    expect(t.table.rows[0].state).toBe("SCHEDULED");
    advance(rebootTiming.busyRetryWindowMs);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe("busy_deploy");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.objectContaining({ serverName: "prod-1", reason: "busy_deploy" }));
  });

  it("an OS update that starts before the scheduled reboot fires blocks it (it is retried, nothing is armed)", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 1000);
    t.world.startOutput = "TUGRA_REBOOT_BUSY=patch";
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("SCHEDULED");
  });

  it("a hub that comes back long after the due time does NOT fire the reboot (missed), even on a free server", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + rebootTiming.busyRetryWindowMs + 60_000); // the hub (or Redis) was down meanwhile
    t.sent.length = 0;
    t.order.length = 0;
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe("missed");
    expect(t.sent).toEqual([]); // nothing was looked at or armed on the host
    expect(t.order).not.toContain("audit:server.reboot.start");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.objectContaining({ reason: "missed" }));
    expect(t.queue.unschedule).toHaveBeenCalledWith("r1");
  });

  it("a delayed job that fires a little late (inside the window) still runs it", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 5 * 60_000);
    await t.svc.advanceById("r1");
    expect(t.table.rows[0].state).toBe("REBOOTING");
  });

  it("re-checks the requester at fire time: a user who lost servers:ops (or left the team) does not reboot the server", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 1000);
    t.access.requirePermission.mockRejectedValueOnce(new ForbiddenException("insufficient permission for this team"));
    t.sent.length = 0;
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe("unauthorized");
    expect(t.access.requirePermission).toHaveBeenLastCalledWith("u1", "t1", "servers:ops");
    expect(t.sent).toEqual([]);
    expect(t.order).not.toContain("sendCommand:start");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.objectContaining({ reason: "unauthorized" }));
  });

  it("a scheduled reboot blocked by a running OS update leaves ONE audit entry once it finally starts, not one per retry", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 1000);
    t.world.patchRunning = true;
    for (let i = 0; i < 6; i++) {
      await t.svc.tick();
      advance(10_000);
    }
    expect(t.table.rows[0].state).toBe("SCHEDULED");
    expect(t.audit.log.mock.calls.filter((c) => c[0].action === "server.reboot.start")).toHaveLength(0);
    expect(t.sent.filter((s) => s.kind === "state")).toHaveLength(0); // no snapshot per retry either
    t.world.patchRunning = false;
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("REBOOTING");
    expect(t.audit.log.mock.calls.filter((c) => c[0].action === "server.reboot.start")).toHaveLength(1);
  });

  it("a start script that reports busy (a race after the preflight) is not audited again on every retry either", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 1000);
    t.world.helperBusy = true;
    for (let i = 0; i < 4; i++) {
      await t.svc.tick();
      advance(10_000);
    }
    expect(t.table.rows[0].state).toBe("SCHEDULED");
    expect(t.audit.log.mock.calls.filter((c) => c[0].action === "server.reboot.start")).toHaveLength(0);
  });

  it("a scheduled reboot is accepted even while an OS update's helper holds the host-exec name", async () => {
    const t = setup({ world: { helperBusy: true } });
    const view = await t.svc.request("u1", "s1", { ...sched, at: at() });
    expect(view).toMatchObject({ state: "SCHEDULED", mode: "scheduled" });
    // an immediate one is still refused
    t.table.rows.length = 0;
    await expect(t.svc.request("u1", "s1", REQ_NOW)).rejects.toThrow(/OS update is running/);
  });

  it("while the agent is offline at the due time it keeps waiting", async () => {
    const t = setup();
    await t.svc.request("u1", "s1", { ...sched, at: at() });
    advance(2 * 3600_000 + 1000);
    t.world.online = false;
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("SCHEDULED");
  });
});

describe("watching a reboot through to verification (fake agent results)", () => {
  /** An armed reboot: REBOOTING, snapshot taken on the old boot. */
  async function armed(over: Parameters<typeof setup>[0] = {}) {
    const t = setup(over);
    await t.svc.request("u1", "s1", REQ_NOW);
    t.sent.length = 0;
    t.order.length = 0;
    return t;
  }
  /** The host went down and came back on a new boot with the given containers. */
  function back(t: ReturnType<typeof setup>, over: Partial<World> = {}) {
    Object.assign(t.world, { online: true, bootId: NEW_BOOT, ...over });
  }

  it("agent drops -> WAITING_AGENT; still down after a long time -> FAILED agent_never_returned, team notified", async () => {
    const t = await armed();
    t.world.online = false;
    advance(30_000);
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("WAITING_AGENT");
    advance(rebootTiming.agentDeadlineMs);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.objectContaining({ reason: "agent_never_returned", serverId: "s1" }));
  });

  it("agent back on the SAME boot id within the grace: keep waiting; past the grace: FAILED host_did_not_reboot", async () => {
    const t = await armed();
    advance(60_000);
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("REBOOTING");
    advance(rebootTiming.noRebootGraceMs);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe("host_did_not_reboot");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.anything());
  });

  it("everything back -> OK, verified, notified, audited with the counts", async () => {
    const t = await armed();
    t.world.online = false;
    advance(30_000);
    await t.svc.tick(); // WAITING_AGENT
    advance(60_000);
    back(t);
    await t.svc.tick(); // new boot seen -> VERIFYING and the first poll in the same pass
    const row = t.table.rows[0];
    expect(row).toMatchObject({ state: "DONE", result: "ok" });
    expect(row.agentBackAt).toEqual(new Date(NOW + 90_000));
    expect(row.verifiedAt).toBeInstanceOf(Date);
    const report = row.report as { rebooted: boolean; summary: unknown; rebootRequired: string; containers: { name: string; verdict: string }[]; domains: { host: string; verdict: string; status: number }[] };
    expect(report.rebooted).toBe(true);
    expect(report.summary).toEqual({ containersOk: 2, containersExpected: 2, domainsOk: 1, domainsExpected: 1 });
    expect(report.rebootRequired).toBe("cleared");
    expect(report.containers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "web", verdict: "ok" }), expect.objectContaining({ name: "scratch", verdict: "skipped" })]));
    expect(report.domains).toEqual([{ host: "app.example.com", verdict: "ok", status: 200 }]);
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_verified", expect.objectContaining({ serverName: "prod-1", containersOk: 2, containersExpected: 2, domainsOk: 1, domainsExpected: 1, problemCount: 0 }));
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.reboot.result", target: "s1", meta: expect.objectContaining({ result: "ok", containersOk: 2 }) }));
    // the host-exec flag read happened only once everything else was ok
    expect(t.sent.map((s) => s.kind)).toEqual(expect.arrayContaining(["state", "probe", "preflight"]));
  });

  it("a container that does not come back: polls through the window, then DEGRADED naming it", async () => {
    const t = await armed();
    back(t, { containers: ["web running healthy unless-stopped 0 nginx:1"] }); // db is gone
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING");
    expect((t.table.rows[0].report as { containers: { name: string; verdict: string }[] }).containers.find((c) => c.name === "db")?.verdict).toBe("missing"); // interim report is stored
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
    advance(5 * 60_000);
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING");
    advance(rebootTiming.verifyWindowMs);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "degraded" });
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_degraded", expect.objectContaining({ problems: "db", problemCount: 1, containersOk: 1, containersExpected: 2 }));
  });

  it("a container that is slow but comes back inside the window ends OK (not degraded)", async () => {
    const t = await armed();
    back(t, { containers: ["web running starting unless-stopped 0 nginx:1", "db created none always 0 postgres:16"] });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING");
    advance(30_000);
    t.world.containers = ["web running healthy unless-stopped 0 nginx:1", "db running none always 0 postgres:16"];
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
  });

  it("an unhealthy container and a domain that does not answer: DEGRADED listing both", async () => {
    const t = await armed();
    back(t, { containers: ["web running unhealthy unless-stopped 0 nginx:1", "db running none always 0 postgres:16"], domainCodes: { "app.example.com": 502 } });
    await t.svc.tick();
    advance(rebootTiming.verifyWindowMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0].result).toBe("degraded");
    const report = t.table.rows[0].report as { containers: { name: string; verdict: string }[]; domains: { verdict: string; status: number }[] };
    expect(report.containers.find((c) => c.name === "web")?.verdict).toBe("unhealthy");
    expect(report.domains[0]).toEqual({ host: "app.example.com", verdict: "not_answering", status: 502 });
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_degraded", expect.objectContaining({ problems: "web, app.example.com", problemCount: 2 }));
  });

  it("the host still asking for a reboot is DEGRADED straight away", async () => {
    const t = await armed();
    back(t, { rebootRequired: true });
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "degraded" });
    expect((t.table.rows[0].report as { rebootRequired: string }).rebootRequired).toBe("still_set");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_degraded", expect.objectContaining({ rebootRequired: "yes" }));
  });

  it("Docker never comes back: FAILED docker_inactive at the end of the window", async () => {
    const t = await armed();
    back(t, { docker: false, containers: [] });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING");
    advance(rebootTiming.verifyWindowMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe("docker_inactive");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.objectContaining({ reason: "docker_inactive" }));
  });

  it("a domain probe that cannot run is reported, never counted as answering", async () => {
    const t = await armed();
    back(t, { probeUnavailable: true });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING"); // not judged on the first poll
    advance(rebootTiming.verifyWindowMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "degraded" });
    expect((t.table.rows[0].report as { domainsNote: string }).domainsNote).toBe("probe_unavailable");
  });

  it("a probe that fails once right after boot and works on the next poll ends OK", async () => {
    const t = await armed();
    back(t, { probeUnavailable: true });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING");
    advance(10_000);
    t.world.probeUnavailable = false;
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
  });

  it("a domain that was not answering before the reboot is not blamed on it", async () => {
    const t = setup({ world: { domainCodes: { "app.example.com": 404 } } });
    await t.svc.request("u1", "s1", REQ_NOW);
    expect((t.table.rows[0].snapshot as { domainsDown: string[] }).domainsDown).toEqual(["app.example.com"]);
    back(t);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
    expect((t.table.rows[0].report as { domains: unknown[] }).domains).toEqual([{ host: "app.example.com", verdict: "not_answering_before", status: 404 }]);
  });

  it("a domain that answered before the reboot and 404s after it is DEGRADED", async () => {
    const t = await armed();
    expect((t.table.rows[0].snapshot as { domainsDown: string[] }).domainsDown).toEqual([]);
    back(t, { domainCodes: { "app.example.com": 404 } });
    await t.svc.tick();
    advance(rebootTiming.verifyWindowMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0].result).toBe("degraded");
  });

  it("a reboot-required flag that cannot be read never ends 'everything came back'", async () => {
    const t = await armed();
    back(t, { flagUnreadable: true });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING"); // looked at again next poll
    expect(t.notifications.fireForEvent).not.toHaveBeenCalled();
    advance(rebootTiming.verifyWindowMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "degraded" });
    expect((t.table.rows[0].report as { rebootRequired: string }).rebootRequired).toBe("unknown");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_degraded", expect.anything());
  });

  it("a flag that cannot be read once but can the next poll ends OK", async () => {
    const t = await armed();
    back(t, { flagUnreadable: true });
    await t.svc.tick();
    advance(10_000);
    t.world.flagUnreadable = false;
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
  });

  it("an online agent whose boot id can never be read ends FAILED within a bound, freeing the server for another reboot", async () => {
    const t = await armed();
    back(t, { bootThrows: true });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("REBOOTING");
    advance(rebootTiming.agentDeadlineMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((t.table.rows[0].report as { reason: string }).reason).toBe("state_unreadable");
    expect(t.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_failed", expect.objectContaining({ reason: "state_unreadable" }));
    t.world.bootThrows = false;
    await expect(t.svc.request("u1", "s1", REQ_NOW)).resolves.toMatchObject({ state: "REBOOTING" }); // the index no longer blocks it
  });

  it("a server whose proxy has no host port is not probed and can still end OK", async () => {
    const t = await armed({ server: { proxyBind: "none" } });
    back(t);
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
    expect(t.sent.map((s) => s.kind)).not.toContain("probe");
  });

  it("a flapping agent that cannot be read this round is simply looked at again next tick", async () => {
    const t = await armed();
    back(t, { stateThrows: true });
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("VERIFYING");
    advance(10_000);
    t.world.stateThrows = false;
    await t.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
  });

  it("the hub that sits on the rebooted server resumes from the database after ITS restart (a fresh service instance)", async () => {
    const t = await armed({ server: { isLocal: true } });
    expect(t.table.rows[0].snapshot).toMatchObject({ hostsHub: true });
    // the host (and the hub with it) goes down; a new hub process boots later and finds the row still REBOOTING
    t.world.online = false;
    advance(120_000);
    const restarted = setup({ table: t.table, world: { online: false, bootId: NEW_BOOT } });
    await restarted.svc.tick();
    expect(t.table.rows[0].state).toBe("WAITING_AGENT");
    restarted.world.online = true; // the agent reconnects to the new hub
    await restarted.svc.tick();
    expect(t.table.rows[0]).toMatchObject({ state: "DONE", result: "ok" });
    expect(restarted.notifications.fireForEvent).toHaveBeenCalledWith("t1", "server_reboot_verified", expect.anything());
  });

  it("settles once: a second pass over a finished reboot does nothing and notifies nothing more", async () => {
    const t = await armed();
    back(t);
    await t.svc.tick();
    await t.svc.tick();
    expect(t.notifications.fireForEvent).toHaveBeenCalledTimes(1);
  });

  it("a STARTING row abandoned by a dead hub: with a snapshot the boot id decides; without one it fails as interrupted", async () => {
    const t = setup();
    t.table.rows.push({ id: "a", serverId: "s1", state: "STARTING", mode: "now", requestedBy: "u1", snapshot: { version: 1, bootId: OLD_BOOT, containers: [], domains: [], probe: "loopback", hostsHub: false }, updatedAt: new Date(NOW), createdAt: new Date(NOW) });
    advance(rebootTiming.startingStaleMs + 1000);
    await t.svc.tick();
    expect(t.table.rows[0].state).toBe("REBOOTING");
    const u = setup();
    u.table.rows.push({ id: "b", serverId: "s1", state: "STARTING", mode: "scheduled", requestedBy: "u1", snapshot: null, updatedAt: new Date(NOW), createdAt: new Date(NOW) });
    advance(rebootTiming.startingStaleMs + 1000);
    await u.svc.tick();
    expect(u.table.rows[0]).toMatchObject({ state: "DONE", result: "failed" });
    expect((u.table.rows[0].report as { reason: string }).reason).toBe("interrupted");
  });
});

describe("status and preview", () => {
  it("status returns the live reboot and the last finished one (cancelled ones do not count as 'last')", async () => {
    const t = setup();
    expect(await t.svc.status("u1", "s1")).toEqual({ active: null, last: null });
    t.table.rows.push({ id: "old", serverId: "s1", state: "DONE", mode: "now", result: "degraded", requestedBy: "u1", createdAt: new Date(NOW - 1000), report: null, snapshot: null });
    t.table.rows.push({ id: "cx", serverId: "s1", state: "DONE", mode: "scheduled", result: "cancelled", requestedBy: "u1", createdAt: new Date(NOW - 500), report: null, snapshot: null });
    await t.svc.request("u1", "s1", { mode: "scheduled", at: new Date(NOW + 3600_000).toISOString(), confirmName: "prod-1" });
    const s = await t.svc.status("u1", "s1");
    expect(s.active).toMatchObject({ state: "SCHEDULED" });
    expect(s.last).toMatchObject({ id: "old", result: "degraded" });
  });

  it("status needs team membership only; a non-member is refused", async () => {
    const t = setup();
    t.access.teamRole.mockResolvedValueOnce(null);
    await expect(t.svc.status("u9", "s1")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("preview counts running containers and routed domains and says whether the hub lives there", async () => {
    const t = setup({ server: { isLocal: true } });
    expect(await t.svc.preview("u1", "s1")).toEqual({ containers: 3, domains: 1, hostsHub: true, agentOnline: true });
    t.world.online = false;
    expect((await t.svc.preview("u1", "s1")).agentOnline).toBe(false);
  });
});
