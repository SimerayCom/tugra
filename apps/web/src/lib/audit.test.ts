import { describe, it, expect } from "vitest";
import { filterAudit, auditToCsv } from "./audit";
import type { AuditEntry } from "./types";

const e = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "1", actor: "demo@tugra.local", action: "app.deploy", target: "web", meta: null, createdAt: "2026-06-29T10:00:00Z", ...over,
});

const rows: AuditEntry[] = [
  e({ id: "1", actor: "ada@x.io", action: "project.create", target: "Storefront" }),
  e({ id: "2", actor: "demo@tugra.local", action: "app.deploy", target: "storefront-web" }),
  e({ id: "3", actor: "demo@tugra.local", action: "channel.delete", target: null }),
];

describe("filterAudit", () => {
  it("returns everything for an empty query", () => {
    expect(filterAudit(rows, "")).toHaveLength(3);
    expect(filterAudit(rows, "   ")).toHaveLength(3);
  });
  it("matches actor, action or target, case-insensitively", () => {
    expect(filterAudit(rows, "ADA").map((r) => r.id)).toEqual(["1"]);
    expect(filterAudit(rows, "deploy").map((r) => r.id)).toEqual(["2"]);
    expect(filterAudit(rows, "storefront").map((r) => r.id)).toEqual(["1", "2"]);
  });
  it("returns [] when nothing matches", () => {
    expect(filterAudit(rows, "zzz")).toEqual([]);
  });
});

describe("auditToCsv", () => {
  it("emits a header row plus one row per entry", () => {
    const csv = auditToCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Time,Actor,Action,Target");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("ada@x.io");
  });
  it("quotes and escapes cells containing commas or quotes", () => {
    const csv = auditToCsv([e({ id: "x", actor: "a", action: "did", target: 'a,"b"' })]);
    expect(csv.split("\n")[1]).toContain('"a,""b"""');
  });
  it("renders a null target as an empty cell", () => {
    const csv = auditToCsv([e({ id: "x", target: null, actor: "a", action: "act" })]);
    expect(csv.split("\n")[1].endsWith(",")).toBe(true);
  });
});
