import { describe, expect, it } from "vitest";
import { OS_CHECK_BATCH, certsExpiringSoon, checkUpdatesBatched, compareVersions, migrationDigest, osUpdateDigest, outdatedAgents, uptimeSummary } from "./dashboard-health";

const dom = (domain: string, state: string, days: number | null, https = true) => ({ appId: `a-${domain}`, domain, https, ssl: { state, daysRemaining: days, validTo: null, issuer: null } }) as never;

describe("certsExpiringSoon", () => {
  it("lists errors first, then the soonest expiry, within the warning window", () => {
    const out = certsExpiringSoon([dom("fine.example.com", "ok", 80), dom("soon.example.com", "ok", 20), dom("exp.example.com", "expiring", 5), dom("bad.example.com", "error", null), dom("http.example.com", "error", null, false), dom("none.example.com", "none", null)]);
    expect(out.map((c) => c.domain)).toEqual(["bad.example.com", "exp.example.com", "soon.example.com"]);
  });
});

describe("compareVersions", () => {
  it("compares betas by their number and a stable above its betas", () => {
    expect(compareVersions("0.1.0-beta.27", "0.1.0-beta.25")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-beta.25", "0.1.0-beta.27")).toBeLessThan(0);
    expect(compareVersions("0.1.0", "0.1.0-beta.27")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });
  it("never claims an update for unparseable input", () => {
    expect(compareVersions("dev", "0.1.0")).toBe(0);
    expect(compareVersions("", "")).toBe(0);
  });
});

describe("outdatedAgents", () => {
  const s = (id: string, status: string, agentVersion: string | null) => ({ id, status, agentVersion }) as never;
  it("flags agents older than the hub, ignoring pending servers and unknown versions", () => {
    const out = outdatedAgents([s("old", "ONLINE", "0.1.0-beta.25"), s("cur", "ONLINE", "0.1.0-beta.27"), s("wait", "PENDING", "0.0.1"), s("none", "ONLINE", null), s("off", "OFFLINE", "0.1.0-beta.20")], "0.1.0-beta.27");
    expect(out.map((x) => x.id)).toEqual(["old", "off"]);
    expect(outdatedAgents([s("old", "ONLINE", "0.0.1")], null)).toEqual([]);
  });
});

describe("uptimeSummary", () => {
  it("counts enabled monitors and online servers and picks the longest uptime", () => {
    const out = uptimeSummary(
      [{ status: "ONLINE", uptimeSeconds: 100 }, { status: "ONLINE", uptimeSeconds: 900 }, { status: "OFFLINE", uptimeSeconds: 5000 }] as never,
      [{ enabled: true, status: "UP" }, { enabled: true, status: "DOWN" }, { enabled: false, status: "DOWN" }, { enabled: true, status: "PENDING" }] as never,
    );
    expect(out).toEqual({ monitorsUp: 1, monitorsDown: 1, monitorsTotal: 3, serversOnline: 2, serversTotal: 3, longestUptimeSec: 900 });
    expect(uptimeSummary([], []).longestUptimeSec).toBeNull();
  });
});

describe("migrationDigest", () => {
  const r = (id: string, status: string, createdAt: string, dryRun = false) => ({ id, status, createdAt, dryRun }) as never;
  it("separates live, failed and the last completed real run; dry runs never count", () => {
    const out = migrationDigest([r("a", "RUNNING", "2026-11-24T00:00:00Z"), r("b", "COMPLETED", "2026-11-10T00:00:00Z"), r("c", "COMPLETED", "2026-11-20T00:00:00Z"), r("d", "FAILED", "2026-11-22T00:00:00Z"), r("e", "RUNNING", "2026-11-23T00:00:00Z", true)]);
    expect(out.live.map((x) => x.id)).toEqual(["a"]);
    expect(out.failed.map((x) => x.id)).toEqual(["d"]);
    expect(out.lastDone?.id).toBe("c");
    expect(migrationDigest([]).lastDone).toBeNull();
  });
});

describe("checkUpdatesBatched", () => {
  it("splits into batches the hub accepts and merges results and skipped ids", async () => {
    const ids = Array.from({ length: OS_CHECK_BATCH * 2 + 5 }, (_, i) => `s${i}`);
    const sizes: number[] = [];
    const out = await checkUpdatesBatched(ids, async (batch) => {
      sizes.push(batch.length);
      return { results: [{ serverId: batch[0], online: true }], skipped: [batch[1]] };
    });
    expect(sizes).toEqual([OS_CHECK_BATCH, OS_CHECK_BATCH, 5]);
    expect(out.results).toHaveLength(3);
    expect(out.skipped).toHaveLength(3);
  });
});

describe("osUpdateDigest", () => {
  const upd = (count: number, checkFailed = false) => ({ supported: true, manager: "apt", checkFailed, rebootRequired: false, packages: [], count });
  it("does not count skipped servers as checked", () => {
    const d = osUpdateDigest(3, { results: [{ serverId: "a", online: true, updates: upd(0) }], skipped: ["b", "c"] } as never);
    expect(d).toEqual({ checked: 1, total: 3, withUpdates: 0, failed: false });
  });
  it("counts servers with updates and flags failed checks", () => {
    const d = osUpdateDigest(3, { results: [{ serverId: "a", online: true, updates: upd(4) }, { serverId: "b", online: true, updates: upd(0, true) }, { serverId: "c", online: true, error: "x" }], skipped: [] } as never);
    expect(d).toEqual({ checked: 1, total: 3, withUpdates: 1, failed: true });
  });
  it("reports nothing checked when every server was skipped", () => {
    expect(osUpdateDigest(2, { results: [], skipped: ["a", "b"] }).checked).toBe(0);
  });
});
