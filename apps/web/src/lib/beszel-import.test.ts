import { describe, it, expect } from "vitest";
import { buildApplyInput, connectErrorCode, summarizePreview, type BeszelPreview } from "./beszel-import";

const preview: BeszelPreview = {
  sessionId: "s1",
  host: "beszel.example.com",
  hash: "a".repeat(32),
  emails: 0,
  servers: [{ id: "srv1", name: "app-1" }],
  systems: [
    { id: "sysA", name: "app-1", host: "203.0.113.5", status: "up", match: { serverId: "srv1", serverName: "app-1", by: "ip" } },
    { id: "sysB", name: "db-1", host: "198.51.100.9", status: "up", match: null, unmatchedReason: "none" },
    { id: "sysC", name: "web-1", host: "192.0.2.1", status: "up", match: { serverId: "srv3", serverName: "web-1", by: "name" } },
  ],
  alerts: [
    { id: "a1", systemId: "sysA", systemName: "app-1", serverId: "srv1", name: "CPU", outcome: "create", metric: "CPU", limit: 80, unit: "%", minutes: 5 },
    { id: "a2", systemId: "sysC", systemName: "web-1", serverId: "srv3", name: "Disk", outcome: "create", metric: "DISK", limit: 90, unit: "%", minutes: 1 },
    { id: "a3", systemId: "sysB", systemName: "db-1", serverId: null, name: "Disk", outcome: "noServer", metric: "DISK", limit: 90, unit: "%", minutes: 1 },
    { id: "a4", systemId: "sysA", systemName: "app-1", serverId: "srv1", name: "GPU", outcome: "skip", reason: "gpu", minutes: 1 },
  ],
  channels: [
    { index: 0, service: "telegram", label: "chat @ops", type: "telegram", outcome: "create", notes: [] },
    { index: 1, service: "zulip", label: "z.example.com", type: null, outcome: "skip", reason: "unsupportedService", notes: [] },
  ],
  history: {
    windowDays: 30,
    totalPoints: 150,
    systems: [
      { systemId: "sysA", serverId: "srv1", points: 100, from: null, to: null },
      { systemId: "sysC", serverId: "srv3", points: 50, from: null, to: null },
    ],
  },
};

describe("summarizePreview", () => {
  it("counts what each part would write, following the systems left ticked", () => {
    expect(summarizePreview(preview)).toEqual({ systemsMatched: 2, systemsOpen: 1, alertsToCreate: 2, alertsSkipped: 2, channelsToCreate: 1, channelsSkipped: 1, historyPoints: 150 });
    expect(summarizePreview(preview, new Set(["sysC"]))).toMatchObject({ systemsMatched: 1, alertsToCreate: 1, historyPoints: 100 });
  });
});

describe("buildApplyInput", () => {
  it("binds the apply to the reviewed hash and sends only ticked, matched systems", () => {
    const body = buildApplyInput(preview, { overrides: {}, parts: { alerts: true, channels: true, history: false }, excluded: new Set(["sysC"]) });
    expect(body).toEqual({ sessionId: "s1", previewHash: "a".repeat(32), parts: { alerts: true, channels: true, history: false }, systemIds: ["sysA"] });
  });

  it("carries manual matches so the hub re-plans the same way", () => {
    const body = buildApplyInput(preview, { overrides: { sysB: "srv1" }, parts: { alerts: true, channels: false, history: false }, excluded: new Set() });
    expect(body.serverOverrides).toEqual({ sysB: "srv1" });
  });
});

describe("connectErrorCode", () => {
  it("reads the hub's stable code and falls back to generic", () => {
    expect(connectErrorCode({ code: "badCredentials" })).toBe("badCredentials");
    expect(connectErrorCode({ data: { code: "mfa" } })).toBe("mfa");
    expect(connectErrorCode({ data: { message: { code: "notBeszel" } } })).toBe("notBeszel");
    expect(connectErrorCode(new Error("boom"))).toBe("generic");
    expect(connectErrorCode(null)).toBe("generic");
  });
});
