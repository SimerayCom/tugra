import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { BeszelImportService, type BeszelSource } from "./beszel-import.service";
import { BeszelError, type BeszelSnapshot } from "./beszel-client";

const NOW = Date.now();
const snapshot = (over: Partial<BeszelSnapshot> = {}): BeszelSnapshot => ({
  systems: [
    { id: "sysA", name: "app-1", host: "203.0.113.5", status: "up" },
    { id: "sysB", name: "db-1", host: "198.51.100.9", status: "up" },
  ],
  alerts: [
    { id: "a1", system: "sysA", name: "CPU", value: 80, min: 5 },
    { id: "a2", system: "sysA", name: "Status", value: 1, min: 1 },
    { id: "a3", system: "sysB", name: "Disk", value: 90, min: 1 },
  ],
  webhooks: ["telegram://1:AAA@telegram?chats=@ops", "zulip://bot:key@z.example.com/?stream=a"],
  emails: [],
  ...over,
});

function setup(opts: { perms?: string[] | null; snap?: BeszelSnapshot; session?: Record<string, unknown> | null; stats?: Array<{ created: string; type: string; stats: Record<string, unknown> }> } = {}) {
  const source: BeszelSource = {
    login: jest.fn().mockResolvedValue(undefined),
    snapshot: jest.fn().mockResolvedValue(opts.snap ?? snapshot()),
    stats: jest.fn().mockResolvedValue(opts.stats ?? []),
  };
  const session = opts.session === undefined
    ? { id: "sess1", teamId: "t1", actorId: "u1", sourceKind: "beszel", baseUrl: "https://beszel.example.com", tokenEnc: "enc", scopeKey: "", status: "active", expiresAt: new Date(NOW + 60_000) }
    : opts.session;
  const prisma: any = {
    importSession: {
      findUnique: jest.fn().mockResolvedValue(session),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: "sess1", ...data })),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    server: { findMany: jest.fn().mockResolvedValue([{ id: "srv1", name: "app-1", hostname: null, publicIp: "203.0.113.5", publicIpv6: null, reportedIps: [] }]) },
    monitor: { findMany: jest.fn().mockResolvedValue([]) },
    notificationChannel: { findMany: jest.fn().mockResolvedValue([]) },
    metric: { findFirst: jest.fn().mockResolvedValue(null) },
    metricRollup: { findFirst: jest.fn().mockResolvedValue(null), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const perms = opts.perms === undefined ? ["monitors", "integrations", "servers:ops"] : opts.perms;
  const access: any = { membershipPermissions: jest.fn().mockResolvedValue(perms ? new Set(perms) : null) };
  const crypto: any = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn(() => JSON.stringify({ identity: "me@example.com", password: "pw" })) };
  const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
  const config: any = { get: jest.fn().mockReturnValue(undefined) };
  const notifications: any = { create: jest.fn().mockResolvedValue({ id: "ch-new" }), update: jest.fn().mockResolvedValue({}) };
  const monitors: any = { create: jest.fn().mockResolvedValue({ id: "m-new" }) };
  const svc = new BeszelImportService(prisma, crypto, access, audit, config, notifications, monitors, () => source);
  return { svc, source, prisma, access, crypto, audit, notifications, monitors };
}

const applyBody = (hash: string, over: Record<string, unknown> = {}) => ({ sessionId: "sess1", previewHash: hash, parts: { alerts: true, channels: true, history: false }, ...over }) as any;

describe("BeszelImportService.connect", () => {
  it("stores the credentials encrypted, never in the clear, and audits without them", async () => {
    const { svc, prisma, audit, source } = setup();
    const r = await svc.connect("u1", { teamId: "t1", baseUrl: "https://beszel.example.com", identity: "me@example.com", password: "s3cret" });
    expect(source.login).toHaveBeenCalledWith("me@example.com", "s3cret");
    const data = prisma.importSession.create.mock.calls[0][0].data;
    expect(data.sourceKind).toBe("beszel");
    expect(data.tokenEnc).toContain("enc(");
    expect(JSON.stringify({ ...data, tokenEnc: undefined })).not.toContain("s3cret"); // the password only ever sits inside tokenEnc
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain("s3cret");
    expect(r.credentialsKept).toBe(false);
    expect(r.expiresAt.getTime() - Date.now()).toBeLessThan(61 * 60_000);
  });

  it("keeps the session 30 days only when asked", async () => {
    const { svc } = setup();
    const r = await svc.connect("u1", { teamId: "t1", baseUrl: "https://beszel.example.com", identity: "a", password: "b", keepCredentials: true });
    expect(r.credentialsKept).toBe(true);
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);
  });

  it("refuses a non-member, a member with no import permission, loopback URLs and bad credentials", async () => {
    await expect(setup({ perms: null }).svc.connect("u1", { teamId: "t1", baseUrl: "https://b.example.com", identity: "a", password: "b" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup({ perms: ["apps:deploy"] }).svc.connect("u1", { teamId: "t1", baseUrl: "https://b.example.com", identity: "a", password: "b" })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup().svc.connect("u1", { teamId: "t1", baseUrl: "http://127.0.0.1:8090", identity: "a", password: "b" })).rejects.toBeInstanceOf(BadRequestException);
    const bad = setup();
    (bad.source.login as jest.Mock).mockRejectedValue(new BeszelError("badCredentials", "no"));
    await expect(bad.svc.connect("u1", { teamId: "t1", baseUrl: "https://b.example.com", identity: "a", password: "b" })).rejects.toMatchObject({ response: { code: "badCredentials" } });
    expect(bad.prisma.importSession.create).not.toHaveBeenCalled();
  });
});

describe("BeszelImportService session guards", () => {
  it("404 for a session of another kind, 403 for someone else's, 400 when expired", async () => {
    await expect(setup({ session: { id: "s", sourceKind: "coolify", actorId: "u1" } }).svc.preview("u1", { sessionId: "s" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup({ session: null }).svc.preview("u1", { sessionId: "s" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(setup().svc.preview("u2", { sessionId: "sess1" })).rejects.toBeInstanceOf(ForbiddenException);
    const expired = setup({ session: { id: "s", sourceKind: "beszel", actorId: "u1", teamId: "t1", status: "active", expiresAt: new Date(NOW - 1000), tokenEnc: "e", baseUrl: "https://b.example.com", scopeKey: "" } });
    await expect(expired.svc.preview("u1", { sessionId: "s" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("scopes the matching to the session's own team", async () => {
    const { svc, prisma } = setup();
    await svc.preview("u1", { sessionId: "sess1" });
    expect(prisma.server.findMany.mock.calls[0][0].where).toEqual({ teamId: "t1" });
    expect(prisma.monitor.findMany.mock.calls[0][0].where).toMatchObject({ teamId: "t1" });
    expect(prisma.notificationChannel.findMany.mock.calls[0][0].where).toEqual({ teamId: "t1" });
  });

  it("refuses a manual match to a server outside the team", async () => {
    await expect(setup().svc.preview("u1", { sessionId: "sess1", serverOverrides: { sysB: "foreign" } })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(setup().svc.preview("u1", { sessionId: "sess1", serverOverrides: { sysA: "srv1", sysB: "srv1" } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("drops the credentials on request, only for the member who connected", async () => {
    const { svc, prisma } = setup();
    await svc.disconnect("u1", "sess1");
    expect(prisma.importSession.delete).toHaveBeenCalledWith({ where: { id: "sess1" } });
    await expect(setup().svc.disconnect("u2", "sess1")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("BeszelImportService.listKept", () => {
  it("lists only the caller's own kept, unexpired connections the member may still use, without secrets", async () => {
    const t = setup();
    t.prisma.importSession.findMany = jest.fn().mockResolvedValue([
      { id: "k1", teamId: "t1", baseUrl: "https://beszel.example.com/path", expiresAt: new Date(NOW + 1000) },
      { id: "k2", teamId: "gone", baseUrl: "https://other.example.com", expiresAt: new Date(NOW + 1000) },
    ]);
    t.access.membershipPermissions.mockImplementation(async (_u: string, team: string) => (team === "t1" ? new Set(["monitors"]) : null));
    const out = await t.svc.listKept("u1");
    expect(out).toEqual([{ sessionId: "k1", teamId: "t1", host: "beszel.example.com", expiresAt: expect.any(Date) }]);
    expect(t.prisma.importSession.findMany.mock.calls[0][0].where).toMatchObject({ actorId: "u1", sourceKind: "beszel", scopeKey: "keep", status: "active" });
    expect(JSON.stringify(out)).not.toContain("enc");
  });
});

describe("BeszelImportService.preview", () => {
  it("returns the dry-run without writing anything and without a secret", async () => {
    const { svc, notifications, monitors, prisma } = setup();
    const p = await svc.preview("u1", { sessionId: "sess1" });
    expect(p.systems.map((s) => [s.id, s.match?.serverId ?? null])).toEqual([["sysA", "srv1"], ["sysB", null]]);
    expect(p.alerts.map((a) => [a.id, a.outcome])).toEqual([["a1", "create"], ["a2", "covered"], ["a3", "noServer"]]);
    expect(p.channels.map((c) => c.outcome)).toEqual(["create", "skip"]);
    expect(p.servers).toEqual([{ id: "srv1", name: "app-1" }]);
    expect(p.history.windowDays).toBe(30);
    expect(JSON.stringify(p)).not.toContain("AAA");
    expect(notifications.create).not.toHaveBeenCalled();
    expect(monitors.create).not.toHaveBeenCalled();
    expect(prisma.metricRollup.createMany).not.toHaveBeenCalled();
  });

  it("counts the history it would import, never over data Tugra holds", async () => {
    const created = new Date(NOW - 10 * 86_400_000).toISOString().replace("T", " ");
    const stats = [{ created, type: "480m", stats: { cpu: 3 } }];
    const a = setup({ stats });
    expect((await a.svc.preview("u1", { sessionId: "sess1" })).history.totalPoints).toBe(1);
    const b = setup({ stats });
    b.prisma.metricRollup.findFirst.mockResolvedValue({ bucket: new Date(NOW - 20 * 86_400_000) });
    expect((await b.svc.preview("u1", { sessionId: "sess1" })).history.totalPoints).toBe(0);
  });
});

describe("BeszelImportService.apply", () => {
  it("creates the channel and a monitor wired to it, then drops the credentials", async () => {
    const t = setup();
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    const r = await t.svc.apply("u1", applyBody(p.hash));
    expect(t.notifications.create).toHaveBeenCalledTimes(1);
    expect(t.notifications.create.mock.calls[0][1]).toMatchObject({ type: "telegram", teamId: "t1", eventTypes: ["server_offline", "server_online"], config: { botToken: "1:AAA", chatId: "@ops" } });
    expect(t.monitors.create).toHaveBeenCalledTimes(1);
    expect(t.monitors.create.mock.calls[0][1]).toMatchObject({ type: "METRIC", metric: "CPU", thresholdPct: 80, retries: 4, intervalSec: 60, serverId: "srv1", teamId: "t1", channelIds: ["ch-new"] });
    expect(r.channels).toMatchObject({ created: 1, skipped: 1 });
    expect(r.monitors).toMatchObject({ created: 1, covered: 1, skipped: 1 });
    expect(r.credentialsDropped).toBe(true);
    expect(t.prisma.importSession.delete).toHaveBeenCalledWith({ where: { id: "sess1" } });
    expect(JSON.stringify(t.audit.log.mock.calls)).not.toContain("AAA");
  });

  it("keeps the session when the operator chose to keep credentials", async () => {
    const t = setup({ session: { id: "sess1", teamId: "t1", actorId: "u1", sourceKind: "beszel", baseUrl: "https://beszel.example.com", tokenEnc: "e", scopeKey: "keep", status: "active", expiresAt: new Date(NOW + 60_000) } });
    t.prisma.importSession.findUnique.mockResolvedValue({ id: "sess1", teamId: "t1", actorId: "u1", sourceKind: "beszel", baseUrl: "https://beszel.example.com", tokenEnc: "e", scopeKey: "keep", status: "active", expiresAt: new Date(NOW + 60_000) });
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    const r = await t.svc.apply("u1", applyBody(p.hash));
    expect(r.credentialsDropped).toBe(false);
    expect(t.prisma.importSession.delete).not.toHaveBeenCalled();
  });

  it("refuses a stale preview (409) and writes nothing", async () => {
    const t = setup();
    await expect(t.svc.apply("u1", applyBody("0".repeat(32)))).rejects.toBeInstanceOf(ConflictException);
    expect(t.notifications.create).not.toHaveBeenCalled();
    expect(t.monitors.create).not.toHaveBeenCalled();
    expect(t.prisma.importSession.delete).not.toHaveBeenCalled();
  });

  it("checks each selected part's permission before writing anything", async () => {
    const t = setup({ perms: ["monitors"] });
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    await expect(t.svc.apply("u1", applyBody(p.hash))).rejects.toBeInstanceOf(ForbiddenException); // channels need integrations
    expect(t.monitors.create).not.toHaveBeenCalled();
    const ok = await t.svc.apply("u1", applyBody(p.hash, { parts: { alerts: true, channels: false, history: false } }));
    expect(ok.monitors.created).toBe(1);
    expect(t.notifications.create).not.toHaveBeenCalled();
  });

  it("reuses an equal channel and an existing monitor instead of duplicating (idempotent re-run)", async () => {
    const t = setup();
    t.prisma.notificationChannel.findMany.mockResolvedValue([{ id: "ch-old", type: "telegram", configEnc: "x", eventTypes: [] }]);
    t.crypto.decrypt.mockImplementation((s: string) => (s === "x" ? JSON.stringify({ chatId: "@ops", botToken: "1:AAA" }) : JSON.stringify({ identity: "a", password: "b" })));
    t.prisma.monitor.findMany.mockResolvedValue([{ serverId: "srv1", metric: "CPU", auto: false, thresholdPct: 80, thresholdValue: null, retries: 4 }]);
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    const r = await t.svc.apply("u1", applyBody(p.hash));
    expect(t.notifications.create).not.toHaveBeenCalled();
    expect(t.monitors.create).not.toHaveBeenCalled();
    expect(r.channels.existing).toBe(1);
    expect(r.monitors.existing).toBe(1);
    // the reused channel is subscribed to server down/up so the covered Status alert reaches it
    expect(t.notifications.update).toHaveBeenCalledWith("u1", "ch-old", { eventTypes: ["server_offline", "server_online"] });
  });

  it("reports a rejected channel or monitor without echoing the reason and keeps going", async () => {
    const t = setup();
    t.notifications.create.mockRejectedValue(new BadRequestException("private address http://10.0.0.1"));
    t.monitors.create.mockRejectedValue(new Error("db down"));
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    const r = await t.svc.apply("u1", applyBody(p.hash));
    expect(r.channels.failed).toBe(1);
    expect(r.monitors.failed).toBe(1);
    expect(r.failures).toEqual([
      { kind: "channel", ref: "0", reason: "rejected" },
      { kind: "alert", ref: "a1", reason: "error" },
    ]);
  });

  it("limits alerts to the chosen systems", async () => {
    const t = setup();
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    await t.svc.apply("u1", applyBody(p.hash, { systemIds: ["sysB"] }));
    expect(t.monitors.create).not.toHaveBeenCalled();
  });

  it("imports history into rollups without overwriting, only for matched servers", async () => {
    const created = new Date(NOW - 10 * 86_400_000).toISOString().replace("T", " ");
    const t = setup({ stats: [{ created, type: "480m", stats: { cpu: 3, la: [1, 2, 3] } }] });
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    const r = await t.svc.apply("u1", applyBody(p.hash, { parts: { alerts: false, channels: false, history: true } }));
    expect(t.source.stats).toHaveBeenCalledTimes(2 * 1); // once in the preview, once in the apply (one matched system)
    const call = t.prisma.metricRollup.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data[0]).toMatchObject({ serverId: "srv1", avgCpu: 3, avgLoad5: 2 });
    expect(r.history).toEqual({ systems: 1, points: 1 });
  });

  it("rejects an overlapping apply for the same session", async () => {
    const t = setup();
    const p = await t.svc.preview("u1", { sessionId: "sess1" });
    let release!: () => void;
    t.notifications.create.mockImplementation(() => new Promise((res) => { release = () => res({ id: "c" }); }));
    const first = t.svc.apply("u1", applyBody(p.hash));
    await new Promise((r) => setTimeout(r, 20));
    await expect(t.svc.apply("u1", applyBody(p.hash))).rejects.toBeInstanceOf(ConflictException);
    release();
    await first;
  });
});
