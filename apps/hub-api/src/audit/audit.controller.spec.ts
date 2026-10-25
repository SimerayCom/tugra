import { AuditController, toCsv } from "./audit.controller";
import { REQUIRE_EDITION } from "../common/edition";
import type { AuditService, AuditView } from "./audit.service";
import type { AuthUser } from "../auth/strategies/jwt.strategy";

const USER = { userId: "u1", scopes: ["*"] } as AuthUser;

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
    send: jest.fn(),
  };
  return { res, headers };
}

const view = (over: Partial<AuditView> = {}): AuditView => ({
  id: "l1",
  actor: "me@x.io",
  action: "app.deploy",
  target: "a1",
  meta: { via: "session" },
  createdAt: new Date("2026-10-25T00:00:00.000Z"),
  ...over,
});

describe("toCsv", () => {
  it("emits a header row + one row per entry with ISO dates and stringified meta", () => {
    const csv = toCsv([view()]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,createdAt,actor,action,target,meta");
    expect(lines[1]).toContain("l1,2026-10-25T00:00:00.000Z,me@x.io,app.deploy,a1,");
    expect(lines[1]).toContain('"{""via"":""session""}"'); // JSON meta is quoted + inner quotes doubled
  });

  it("quotes cells containing a comma, quote or newline", () => {
    const csv = toCsv([view({ action: "a,b", target: 'x"y' })]);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"x""y"');
  });

  it("defuses spreadsheet formula injection (=,+,-,@) by prefixing a single quote", () => {
    const csv = toCsv([view({ actor: "=HYPERLINK(1)", action: "+1", target: "@x" })]);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@x");
  });

  it("renders null target as an empty cell", () => {
    const csv = toCsv([view({ target: null, meta: null })]);
    expect(csv.trimEnd().split("\r\n")[1]).toBe("l1,2026-10-25T00:00:00.000Z,me@x.io,app.deploy,,");
  });

  it("appends a truncation sentinel row only when truncated", () => {
    expect(toCsv([view()], false)).not.toContain("_truncated");
    const capped = toCsv([view()], true);
    expect(capped).toContain("_truncated");
    expect(capped).toContain("narrow the date range");
  });
});

describe("AuditController.export", () => {
  const svc = { exportEntries: jest.fn() } as unknown as AuditService;
  const ctrl = new AuditController(svc);
  afterEach(() => jest.clearAllMocks());

  it("is gated to the Pro edition", () => {
    expect(Reflect.getMetadata(REQUIRE_EDITION, AuditController.prototype.export)).toBe("pro");
  });

  it("actually ATTACHES RequireEditionGuard to the handler (metadata alone enforces nothing)", () => {
    const guards: unknown[] = Reflect.getMetadata("__guards__", AuditController.prototype.export) ?? [];
    expect(guards.map((g) => (g as { name: string }).name)).toContain("RequireEditionGuard");
  });

  it("CSV: sets a .csv download header + truncated=0 and sends CSV text", async () => {
    (svc.exportEntries as jest.Mock).mockResolvedValue({ entries: [view()], truncated: false });
    const { res, headers } = makeRes();
    await ctrl.export(res as never, USER, "csv");
    expect(headers["Content-Type"]).toContain("text/csv");
    expect(headers["Content-Disposition"]).toMatch(/attachment; filename="tugra-audit-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(headers["X-Tugra-Audit-Truncated"]).toBe("0");
    expect((res.send as jest.Mock).mock.calls[0][0]).toContain("id,createdAt,actor,action,target,meta");
  });

  it("JSON (default): sends a JSON envelope and flags truncated=1 in the header", async () => {
    (svc.exportEntries as jest.Mock).mockResolvedValue({ entries: [view()], truncated: true });
    const { res, headers } = makeRes();
    await ctrl.export(res as never, USER); // no format → JSON
    expect(headers["Content-Type"]).toContain("application/json");
    expect(headers["X-Tugra-Audit-Truncated"]).toBe("1");
    const body = JSON.parse((res.send as jest.Mock).mock.calls[0][0]);
    expect(body).toMatchObject({ count: 1, truncated: true });
    expect(body.entries[0].id).toBe("l1");
  });

  it("passes the filters through to the service (teamId/action/date), string-coerced", async () => {
    (svc.exportEntries as jest.Mock).mockResolvedValue({ entries: [], truncated: false });
    const { res } = makeRes();
    await ctrl.export(res as never, USER, "json", "t1", "app.deploy", "2026-10-01", undefined);
    expect(svc.exportEntries).toHaveBeenCalledWith("u1", "t1", expect.objectContaining({ action: "app.deploy", from: expect.any(Date) }));
  });
});
