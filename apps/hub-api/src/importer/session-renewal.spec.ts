import { ImporterService } from "./importer.service";
import { SESSION_TTL_MS, renewImportSession, renewImportSessionsById, sessionHardEnd, sessionMaxAgeMs } from "./session-renewal";

const MIN = 60_000;
const HOUR = 60 * MIN;

type Row = { id: string; status: string; expiresAt: Date; createdAt: Date; lastUsedAt?: Date; actorId?: string; teamId?: string; sourceKind?: string; baseUrl?: string; tokenEnc?: string; scopeKey?: string; transport?: string; agentServerId?: string | null; hostLinks?: unknown; teamMap?: unknown; sourceTeamRef?: string | null };

/** A tiny in-memory import_session table: updateMany honours the same where the real one gets. */
function table(rows: Row[]) {
  const matches = (r: Row, where: any): boolean =>
    (where.id === undefined || (typeof where.id === "string" ? r.id === where.id : where.id.in.includes(r.id))) &&
    (where.status === undefined || r.status === where.status) &&
    (where.expiresAt === undefined || ((where.expiresAt.gt === undefined || r.expiresAt > where.expiresAt.gt) && (where.expiresAt.lt === undefined || r.expiresAt < where.expiresAt.lt)));
  const importSession = {
    findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null),
    findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  };
  return { importSession } as any;
}

const row = (over: Partial<Row> = {}): Row => ({ id: "s1", status: "active", expiresAt: new Date(Date.now() + 10 * MIN), createdAt: new Date(Date.now() - 50 * MIN), ...over });

describe("sliding import-session expiry", () => {
  it("moves the end to now + 1 h when less than half an hour is left, and stamps lastUsedAt", async () => {
    const r = row();
    const prisma = table([r]);
    expect(await renewImportSession(prisma, r)).toBe(true);
    expect(r.expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5_000);
    expect(r.lastUsedAt).toBeInstanceOf(Date);
  });

  it("writes nothing while more than half an hour is left (a burst of calls is one write)", async () => {
    const r = row({ expiresAt: new Date(Date.now() + 40 * MIN) });
    const prisma = table([r]);
    expect(await renewImportSession(prisma, r)).toBe(false);
    expect(prisma.importSession.updateMany).not.toHaveBeenCalled();
  });

  it("never goes past the hard end (12 h from creation by default)", async () => {
    const created = new Date(Date.now() - (12 * HOUR - 20 * MIN));
    const r = row({ createdAt: created, expiresAt: new Date(Date.now() + 5 * MIN) });
    await renewImportSession(table([r]), r);
    expect(r.expiresAt.getTime()).toBe(created.getTime() + 12 * HOUR);
    // at the hard end there is nothing left to give
    const last = row({ createdAt: new Date(Date.now() - 12 * HOUR + MIN), expiresAt: new Date(Date.now() + MIN) });
    const before = last.expiresAt.getTime();
    expect(await renewImportSession(table([last]), last)).toBe(false);
    expect(last.expiresAt.getTime()).toBe(before);
  });

  it("never brings an ended session back: expired and revoked stay as they are", async () => {
    const expired = row({ expiresAt: new Date(Date.now() - MIN) });
    const revoked = row({ id: "s2", status: "revoked" });
    const prisma = table([expired, revoked]);
    expect(await renewImportSession(prisma, expired)).toBe(false);
    expect(await renewImportSession(prisma, revoked)).toBe(false);
    expect(await renewImportSessionsById(prisma, ["s1", "s2"])).toBe(0);
    expect(expired.expiresAt.getTime()).toBeLessThan(Date.now());
    expect(revoked.status).toBe("revoked");
  });

  it("a session that ended between the read and the write is not revived (the update re-checks)", async () => {
    const stale = row();
    const live = row({ expiresAt: new Date(Date.now() - MIN) }); // what the table holds now
    const prisma = table([live]);
    expect(await renewImportSession(prisma, stale)).toBe(false);
    expect(live.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("renews many sessions by id (the run keeper), each once", async () => {
    const a = row({ id: "a" });
    const b = row({ id: "b", expiresAt: new Date(Date.now() + 50 * MIN) });
    const prisma = table([a, b]);
    expect(await renewImportSessionsById(prisma, ["a", "a", "b", "ghost"])).toBe(1);
    expect(a.expiresAt.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5_000);
  });

  it("a failing write never fails the caller", async () => {
    const r = row();
    const prisma = { importSession: { updateMany: jest.fn().mockRejectedValue(new Error("db down")) } } as any;
    await expect(renewImportSession(prisma, r)).resolves.toBe(false);
  });

  it("the hard end is configurable, 1 to 72 hours", () => {
    expect(sessionMaxAgeMs({} as never)).toBe(12 * HOUR);
    expect(sessionMaxAgeMs({ IMPORT_SESSION_MAX_HOURS: "24" } as never)).toBe(24 * HOUR);
    expect(sessionMaxAgeMs({ IMPORT_SESSION_MAX_HOURS: "500" } as never)).toBe(72 * HOUR);
    expect(sessionMaxAgeMs({ IMPORT_SESSION_MAX_HOURS: "0" } as never)).toBe(12 * HOUR);
    expect(sessionHardEnd(new Date(0))).toBe(12 * HOUR);
  });
});

describe("ImporterService: every call on a session renews it", () => {
  function make(over: Partial<Row> = {}) {
    const r = row({ actorId: "u1", teamId: "t1", sourceKind: "coolify", baseUrl: "https://c.example.com", tokenEnc: "enc(TOK)", scopeKey: "", transport: "api", agentServerId: null, ...over });
    const prisma = { ...table([r]), server: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) }, coolifyInventory: { findFirst: jest.fn().mockResolvedValue({ id: "i" }) } } as any;
    const access = { requirePermission: jest.fn(), requireRole: jest.fn(), permissionsByTeam: jest.fn().mockResolvedValue(new Map()) };
    const source = { close: jest.fn(), discover: jest.fn().mockResolvedValue({ servers: [], apps: [], databases: [], services: [], warnings: [] }), currentTeam: jest.fn() };
    const sources = { create: jest.fn(() => source), createAgent: jest.fn(() => source), finishAgentRun: jest.fn() };
    const mappings = { getProfile: jest.fn().mockResolvedValue(null) };
    const svc = new ImporterService({} as never, prisma, { encrypt: (s: string) => s, decrypt: (s: string) => s } as never, access as never, { log: jest.fn() } as never, sources as never, mappings as never);
    return { svc, r, prisma };
  }
  const renewedTo = (r: Row): number => r.expiresAt.getTime() - Date.now();

  it("openSession (what plan, previews and apply go through) extends it", async () => {
    const m = make();
    await (await m.svc.openSession("u1", "s1")).source.close();
    expect(renewedTo(m.r)).toBeGreaterThan(SESSION_TTL_MS - 5_000);
  });

  it("a run's own read can ask not to renew (the run keeper does it for runs; a dry run stays read-only)", async () => {
    const m = make();
    await (await m.svc.openSession("u1", "s1", undefined, { renew: false })).source.close();
    expect(renewedTo(m.r)).toBeLessThan(11 * MIN);
    expect(m.prisma.importSession.updateMany).not.toHaveBeenCalled();
  });

  it("the profile routes (requireSession) extend it", async () => {
    const m = make();
    await m.svc.getMapping("u1", "s1");
    expect(renewedTo(m.r)).toBeGreaterThan(SESSION_TTL_MS - 5_000);
  });

  it("the team map and the host link extend it", async () => {
    const m = make({ transport: "agent", agentServerId: "srv", baseUrl: "agent://srv" });
    await m.svc.setTeamMap("u1", "s1", { teams: [] } as never);
    expect(renewedTo(m.r)).toBeGreaterThan(SESSION_TTL_MS - 5_000);
    m.r.expiresAt = new Date(Date.now() + 5 * MIN);
    await m.svc.setHostLink("u1", "s1", { coolifyServerUuid: "x", reset: true } as never).catch(() => undefined);
    expect(renewedTo(m.r)).toBeGreaterThan(SESSION_TTL_MS - 5_000);
  });

  it("a plan on an ended session is refused and does not revive it", async () => {
    const m = make({ expiresAt: new Date(Date.now() - MIN) });
    await expect(m.svc.openSession("u1", "s1")).rejects.toMatchObject({ response: { code: "session_ended" } });
    expect(m.r.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("renewSessions (the keeper) renews by id", async () => {
    const m = make();
    await m.svc.renewSessions(["s1"]);
    expect(renewedTo(m.r)).toBeGreaterThan(SESSION_TTL_MS - 5_000);
  });
});
