import { describe, it, expect } from "vitest";
import { ApiError } from "./api";
import { takeoverStartBlock, busyServers, cleanupGuard, copyOntoSourceHost, freshnessOf, freshnessOfError, promoteBlocks, swapProxyBlock } from "./launch-guards";
import type { ImportPlan } from "./types";

const tugra = (serverId: string) => ({ serverId, name: serverId, teamId: "t1", via: "public-ip" as const, confidence: "certain" as const });
const plan = (hosts: NonNullable<ImportPlan["preflight"]>["hosts"], sourceKind: ImportPlan["sourceKind"] = "coolify"): ImportPlan => ({
  sourceKind,
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: [],
  totals: { apps: 0, databases: 0, volumes: 0, blockers: 0 },
  items: [],
  preflight: { databases: [], services: [], appsWithVolumeData: 0, hosts },
});

describe("swapProxyBlock", () => {
  const p = plan([{ ref: "s1", tugra: tugra("A") }, { ref: "s2", tugra: tugra("B") }, { ref: "cp", controlPlane: true, tugra: tugra("C") }]);
  it("lets a server go onto its own machine", () => {
    expect(swapProxyBlock({ plan: p, targetId: "A", placement: null, refs: ["s1"] })).toBeNull();
  });
  it("names each reason the hub would refuse at create", () => {
    expect(swapProxyBlock({ plan: plan([], "dokploy"), targetId: "A", placement: null })).toBe("unsupported-source");
    expect(swapProxyBlock({ plan: p, targetId: "A", placement: { s1: "A", s2: "B" }, refs: ["s1", "s2"] })).toBe("multi-target");
    expect(swapProxyBlock({ plan: p, targetId: "C", placement: null, refs: ["cp"] })).toBe("control-plane");
    expect(swapProxyBlock({ plan: p, targetId: "B", placement: null, refs: ["s1"] })).toBe("not-source-host");
  });
  it("a source server with no matched machine is not a pass", () => {
    expect(swapProxyBlock({ plan: plan([{ ref: "s1" }]), targetId: "A", placement: null, refs: ["s1"] })).toBe("not-source-host");
  });
  it("judges every server of the plan when the refs are not known", () => {
    expect(swapProxyBlock({ plan: p, targetId: "A", placement: null })).toBe("control-plane");
  });
  it("a map entry decides a server's target, the default decides the rest", () => {
    expect(swapProxyBlock({ plan: p, targetId: "B", placement: { s1: "B" }, refs: ["s1"] })).toBe("not-source-host");
    expect(swapProxyBlock({ plan: p, targetId: "A", placement: { s2: "A" }, refs: ["s1"] })).toBeNull();
  });
});

describe("copyOntoSourceHost", () => {
  const p = plan([{ ref: "s1", tugra: tugra("A") }, { ref: "s2", tugra: tugra("B") }]);
  it("lists the source servers whose own machine is the target of the copy", () => {
    expect(copyOntoSourceHost({ plan: p, targetId: "A", placement: null, refs: ["s1", "s2"] })).toEqual(["s1"]);
    expect(copyOntoSourceHost({ plan: p, targetId: "Z", placement: { s2: "B" }, refs: ["s1", "s2"] })).toEqual(["s2"]);
    expect(copyOntoSourceHost({ plan: p, targetId: "Z", placement: null, refs: ["s1", "s2"] })).toEqual([]);
  });
});

describe("busyServers", () => {
  it("a live real run holds its target; a dry run or a settled run holds none", () => {
    const m = busyServers([
      { id: "r1", targetServerId: "A", status: "RUNNING", dryRun: false },
      { id: "r2", targetServerId: "B", status: "RUNNING", dryRun: true },
      { id: "r3", targetServerId: "C", status: "COMPLETED", dryRun: false },
      { id: "r4", targetServerId: "D", status: "FAILED", dryRun: false },
    ]);
    expect([...m.entries()]).toEqual([["A", "r1"], ["D", "r4"]]);
  });
  it("a run holds every server it places something on, not only its main target", () => {
    const m = busyServers([
      { id: "r1", targetServerId: "A", targetServerIds: ["A", "B", "C"], status: "RUNNING", dryRun: false },
      { id: "r2", targetServerId: "D", targetServerIds: ["D", "E"], status: "RUNNING", dryRun: true },
      { id: "r3", targetServerId: "F", targetServerIds: ["F", "B"], status: "QUEUED", dryRun: false },
    ]);
    expect([...m.entries()]).toEqual([["A", "r1"], ["B", "r1"], ["C", "r1"], ["F", "r3"]]);
  });
  it("is empty while the runs are not loaded", () => {
    expect(busyServers(undefined).size).toBe(0);
  });
});

describe("freshness", () => {
  it("a 409 is a changed source, a 400 or 404 an ended session, anything else is unknown", () => {
    expect(freshnessOfError(new ApiError(409, "plan-changed"))).toBe("plan-changed");
    expect(freshnessOfError(new ApiError(400, "import session expired or revoked"))).toBe("session-ended");
    expect(freshnessOfError(new ApiError(404, "import session not found"))).toBe("session-ended");
    expect(freshnessOfError(new ApiError(500, "boom"))).toBeNull();
    expect(freshnessOfError(new Error("network"))).toBeNull();
  });
  it("a re-read with another hash is a changed source", () => {
    expect(freshnessOf("h1", { hash: "h2" })).toBe("plan-changed");
    expect(freshnessOf("h1", { hash: "h1" })).toBeNull();
    expect(freshnessOf("h1", { error: new ApiError(400, "x") })).toBe("session-ended");
    expect(freshnessOf("h1", {})).toBeNull();
  });
});

describe("promoteBlocks", () => {
  const run = (over: Record<string, unknown> = {}) => ({ inPlace: false, targetServers: [{ serverId: "A", serverName: "box-a", primary: true }], sourceSession: { state: "active" as const, expiresAt: null, viaAgent: false, agentServerId: null, sourceTeamRef: null }, ...over });
  const ok = [{ id: "A", name: "box-a", teamId: "t", status: "ONLINE", capabilities: ["deploy"] }];
  it("has nothing to say when targets are ready and the session lives", () => {
    expect(promoteBlocks(run(), ok, false)).toEqual([]);
  });
  it("names a target that went offline, is pending or has no deploy grant", () => {
    expect(promoteBlocks(run(), [{ ...ok[0], status: "OFFLINE" }], false)).toEqual([{ kind: "target", serverId: "A", name: "box-a", why: "offline" }]);
    expect(promoteBlocks(run(), [{ ...ok[0], status: "PENDING" }], false)[0]).toMatchObject({ why: "pending" });
    expect(promoteBlocks(run(), [{ ...ok[0], capabilities: [] }], false)[0]).toMatchObject({ why: "no-deploy" });
  });
  it("does not judge a server the list does not show", () => {
    expect(promoteBlocks(run(), [], false)).toEqual([]);
  });
  it("a session that ended blocks until it is renewed here", () => {
    const ended = run({ sourceSession: { state: "expired", expiresAt: null, viaAgent: true, agentServerId: "H", sourceTeamRef: "t" } });
    expect(promoteBlocks(ended, ok, false)).toEqual([{ kind: "session", viaAgent: true, agentServerId: "H", sourceTeamRef: "t" }]);
    expect(promoteBlocks(ended, ok, true)).toEqual([]);
  });
  it("an older hub that says nothing about the session blocks nothing", () => {
    expect(promoteBlocks(run({ sourceSession: undefined }), ok, false)).toEqual([]);
  });
});

describe("cleanupGuard", () => {
  const now = Date.parse("2026-11-26T12:00:00Z");
  const fresh = { readAt: "2026-11-26T11:50:00Z" };
  it("the Coolify host itself is retired separately", () => {
    expect(cleanupGuard({ coolify: true, isCoolifyHub: true }, fresh, now)).toBe("control_plane");
  });
  it("a server no read knows has nothing to check against", () => {
    expect(cleanupGuard({ coolify: false, isCoolifyHub: false }, fresh, now)).toBe("no_coolify_link");
    expect(cleanupGuard({ coolify: true, isCoolifyHub: false }, null, now)).toBe("no_coolify_link");
  });
  it("a read older than the hub's limit must be taken again", () => {
    expect(cleanupGuard({ coolify: true, isCoolifyHub: false }, { readAt: "2026-11-26T11:00:00Z" }, now)).toBe("read_stale");
    expect(cleanupGuard({ coolify: true, isCoolifyHub: false }, { readAt: null }, now)).toBe("read_stale");
  });
  it("goes ahead on a recent read, and says nothing while the status is unknown", () => {
    expect(cleanupGuard({ coolify: true, isCoolifyHub: false }, fresh, now)).toBeNull();
    expect(cleanupGuard(undefined, fresh, now)).toBeNull();
  });
});

describe("takeoverStartBlock", () => {
  const base = { busyRunId: null, takeoverLive: false, proxyBind: "public" as string | undefined, proxy: "running" as const };
  it("a run or a takeover that holds the server comes first", () => {
    expect(takeoverStartBlock({ ...base, busyRunId: "r1" })).toBe("server_busy");
    expect(takeoverStartBlock({ ...base, takeoverLive: true })).toBe("server_busy");
  });
  it("Tugra's proxy that publishes ports and runs is in use; stopped, absent, not publishing or not known is not judged", () => {
    expect(takeoverStartBlock(base)).toBe("tugra_proxy_in_use");
    expect(takeoverStartBlock({ ...base, proxy: "stopped" as never })).toBeNull();
    expect(takeoverStartBlock({ ...base, proxyBind: "none" })).toBeNull();
    expect(takeoverStartBlock({ ...base, proxyBind: undefined })).toBeNull();
    expect(takeoverStartBlock({ ...base, proxy: undefined as never })).toBeNull();
  });
  it("names the live takeover statuses the hub holds a server for", async () => {
    const { takeoverIsLive } = await import("./launch-guards");
    for (const s of ["PLANNED", "TESTING", "SWAPPING", "SWAPPED", "VERIFIED", "GIVING_BACK"]) expect(takeoverIsLive(s)).toBe(true);
    for (const s of ["GIVEN_BACK", "FAILED", undefined]) expect(takeoverIsLive(s)).toBe(false);
  });
});
