import { ConflictException } from "@nestjs/common";
import { VerificationService } from "./verification.service";
import type { FetchTarget, PageTransport } from "./preview-fetch";

const ACTOR = { userId: "u1", scopes: ["*"], channel: "session" } as never;
const RUN = { id: "r1", teamId: "t1", opId: "op1", topology: "two-box", options: { healthPath: "/health" } };

const stats = (rows: Record<string, number>, over: Record<string, unknown> = {}) => ({
  itemRef: "database:s:db1", engine: "POSTGRES", kind: "tables", mode: "exact", state: "measured", reason: null, tableCount: Object.keys(rows).length, truncated: false,
  tables: Object.entries(rows).map(([name, r]) => ({ name, rows: r, estimated: false, expires: 0 })), ...over,
});

function make(o: { run?: unknown; transport?: PageTransport; topology?: string } = {}) {
  const created: unknown[] = [];
  const prisma = {
    cutoverDomain: {
      findMany: jest.fn(async ({ where }: { where: { role: unknown } }) => (typeof where.role === "string" ? [{ hostname: "app.example.com", applicationId: "a1" }] : [{ hostname: "app.example.com", applicationId: "a1" }, { hostname: "www.example.com", applicationId: "a1" }])),
    },
    application: {
      findMany: jest.fn(async (q: { select: Record<string, boolean> }) => (q.select.serverId ? [{ id: "a1", serverId: "s1" }] : q.select.envEnc ? [{ id: "a1", name: "api", envEnc: "enc" }] : [{ id: "a1", domain: "api-ab12cd.203-0-113-7.sslip.io", domainKind: "magic", https: false }])),
    },
    server: { findMany: jest.fn().mockResolvedValue([{ id: "s1", publicIp: "203.0.113.7", publicIpv6: null }]) },
    migrationRunCheck: {
      findMany: jest.fn().mockResolvedValue([
        { checkId: "source-stats", subject: "database:s:db1", evidence: stats({ users: 10, orders: 5 }) },
        { checkId: "target-stats", subject: "database:s:db1", evidence: stats({ users: 10, orders: 4 }) },
      ]),
    },
    bulkTask: {
      findMany: jest.fn(async ({ where }: { where: { kind: string } }) =>
        where.kind === "database"
          ? [{ itemRef: "database:s:db1", result: { name: "main" } }]
          : [{ itemRef: "app:s:a1", resourceId: "a1", result: { name: "api", unresolvedKeys: ["STRIPE_KEY"], droppedInvalidKeys: [] } }],
      ),
    },
    migrationVolumeTransfer: { findMany: jest.fn().mockResolvedValue([{ itemRef: "volume:_:x:uploads", state: "DONE", entries: 40, rawBytesFinal: 1000n, rawBytesDone: 1000n }]) },
    migrationVerification: {
      create: jest.fn(async (a: { data: unknown }) => { created.push(a.data); return a.data; }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn(),
    },
  };
  const crypto = { decrypt: () => JSON.stringify({ A: "secret-a", B: "secret-b", C: "c" }) };
  const audit = { log: jest.fn() };
  const runs = { get: jest.fn().mockResolvedValue("run" in o ? o.run : { ...RUN, ...(o.topology ? { topology: o.topology } : {}) }) };
  const svc = new VerificationService(prisma as never, crypto as never, audit as never, runs as never);
  const seen: FetchTarget[] = [];
  svc.transport = o.transport ?? (async (t) => { seen.push(t); return { status: 200, contentType: "text/html", location: null, body: Buffer.from("<title>Shop</title><p>hello</p>"), truncated: false }; });
  return { svc, prisma, created, seen, audit, runs };
}

describe("VerificationService.run", () => {
  it("compares pages, tables, volumes and env keys and stores a secret-free report", async () => {
    const t = make();
    const v = await t.svc.run(ACTOR, "r1", ["/pricing"]);
    const r = v.report!;
    expect(r.pages.map((p) => `${p.host}${p.path}`)).toEqual(["app.example.com/", "app.example.com/health", "app.example.com/pricing", "www.example.com/", "www.example.com/health", "www.example.com/pricing"]);
    expect(r.pages.every((p) => p.verdict === "same")).toBe(true);
    expect(r.databases).toHaveLength(1);
    expect(r.databases[0]).toMatchObject({ verdict: "differs", name: "main", sourceRows: 15, targetRows: 14, tables: [{ name: "orders", source: 5, target: 4 }] });
    expect(r.volumes[0]).toMatchObject({ verdict: "same", files: 40, name: "uploads" });
    expect(r.env[0]).toMatchObject({ verdict: "differs", targetKeys: 3, missing: [{ key: "STRIPE_KEY", reason: "unresolved" }] });
    expect(r.state).toBe("differences");
    expect(JSON.stringify(r)).not.toMatch(/secret-a|secret-b|203\.0\.113\.7/); // no env value, no target address
    expect(t.created).toHaveLength(1);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "migration.verification" }));
  });

  it("fetches the source by name and the target pinned to its server address", async () => {
    const t = make();
    await t.svc.run(ACTOR, "r1", []);
    const src = t.seen.filter((s) => !s.ip);
    const tgt = t.seen.filter((s) => s.ip);
    expect(src.length).toBeGreaterThan(0);
    expect(tgt.every((s) => s.ip === "203.0.113.7")).toBe(true);
  });

  it("reports a match when everything agrees", async () => {
    const t = make();
    (t.prisma.migrationRunCheck.findMany as jest.Mock).mockResolvedValue([
      { checkId: "source-stats", subject: "database:s:db1", evidence: stats({ users: 10 }) },
      { checkId: "target-stats", subject: "database:s:db1", evidence: stats({ users: 10 }) },
    ]);
    (t.prisma.bulkTask.findMany as jest.Mock).mockImplementation(async ({ where }: { where: { kind: string } }) => (where.kind === "database" ? [] : [{ itemRef: "app:s:a1", resourceId: "a1", result: { name: "api" } }]));
    const v = await t.svc.run(ACTOR, "r1", []);
    expect(v.report!.state).toBe("match");
    expect(v.report!.counts.differs).toBe(0);
  });

  it("a same-host takeover cannot be read by the hub: target pages are unknown, never a pass", async () => {
    const t = make({ topology: "swap-proxy" });
    const v = await t.svc.run(ACTOR, "r1", []);
    expect(v.report!.pages.every((p) => p.verdict === "unknown" && p.code === "same-host-needs-agent")).toBe(true);
    expect(t.seen.every((s) => !s.ip)).toBe(true);
  });

  it("an unreachable target is unknown (incomplete), not a difference nor a pass", async () => {
    const t = make({ transport: async (x) => { if (x.ip) throw new Error("timeout"); return { status: 200, contentType: "text/html", location: null, body: Buffer.from("x"), truncated: false }; } });
    (t.prisma.migrationRunCheck.findMany as jest.Mock).mockResolvedValue([]);
    (t.prisma.bulkTask.findMany as jest.Mock).mockResolvedValue([]);
    (t.prisma.migrationVolumeTransfer.findMany as jest.Mock).mockResolvedValue([]);
    const v = await t.svc.run(ACTOR, "r1", []);
    expect(v.report!.state).toBe("incomplete");
    expect(v.report!.pages[0]).toMatchObject({ verdict: "unknown", code: "target-unreachable" });
  });

  it("refuses a run that imported nothing yet and a second concurrent verification", async () => {
    await expect(make({ run: { ...RUN, opId: null } }).svc.run(ACTOR, "r1", [])).rejects.toBeInstanceOf(ConflictException);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const t = make({ transport: async () => { await gate; return { status: 200, contentType: null, location: null, body: Buffer.from("x"), truncated: false }; } });
    const first = t.svc.run(ACTOR, "r1", []);
    await new Promise((r) => setTimeout(r, 10));
    await expect(t.svc.run(ACTOR, "r1", [])).rejects.toBeInstanceOf(ConflictException);
    release();
    await first;
  });

  it("authorizes through the run facade first (a foreign run never reaches the database)", async () => {
    const t = make();
    t.runs.get.mockRejectedValue(new Error("not found"));
    await expect(t.svc.run(ACTOR, "other", [])).rejects.toThrow("not found");
    await expect(t.svc.latest(ACTOR, "other")).rejects.toThrow("not found");
    expect(t.prisma.cutoverDomain.findMany).not.toHaveBeenCalled();
    expect(t.prisma.migrationVerification.findFirst).not.toHaveBeenCalled();
  });

  it("offers a preview link only for an app that has a generated domain", async () => {
    const t = make();
    const v = await t.svc.latest(ACTOR, "r1");
    expect(v.previews).toEqual([{ host: "app.example.com", url: "http://api-ab12cd.203-0-113-7.sslip.io" }]);
    expect(v.report).toBeNull();
  });
});
