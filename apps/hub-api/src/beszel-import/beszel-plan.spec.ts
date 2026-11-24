import { buildPlan, channelKey, type PlanInput } from "./beszel-plan";

const base = (over: Partial<PlanInput> = {}): PlanInput => ({
  systems: [
    { id: "sysA", name: "app-1", host: "203.0.113.5", status: "up" },
    { id: "sysB", name: "db-1", host: "198.51.100.9", status: "up" },
  ],
  alerts: [
    { id: "a1", system: "sysA", name: "CPU", value: 80, min: 5 },
    { id: "a2", system: "sysA", name: "Status", value: 1, min: 1 },
    { id: "a3", system: "sysA", name: "GPU", value: 90, min: 1 },
    { id: "a4", system: "sysB", name: "Disk", value: 90, min: 1 },
    { id: "a5", system: "sysA", name: "LoadAvg5", value: 4, min: 5 },
  ],
  webhooks: ["telegram://1:AAA@telegram?chats=@ops", "zulip://bot:key@z.example.com/?stream=a", "telegram://1:AAA@telegram?chats=@ops"],
  emails: ["ops@example.com"],
  servers: [{ id: "srv1", name: "app-1", hostname: null, publicIp: "203.0.113.5", publicIpv6: null, reportedIps: [] }],
  existingMonitors: [],
  existingChannelKeys: new Set(),
  ...over,
});

describe("buildPlan", () => {
  it("matches systems, plans monitors, covers Status, skips the rest and flags unmatched servers", () => {
    const { view, internals } = buildPlan(base());
    expect(view.systems.find((s) => s.id === "sysA")?.match).toMatchObject({ serverId: "srv1", by: "ip" });
    expect(view.systems.find((s) => s.id === "sysB")).toMatchObject({ match: null, unmatchedReason: "none" });
    const by = Object.fromEntries(view.alerts.map((a) => [a.id, a]));
    expect(by.a1).toMatchObject({ outcome: "create", metric: "CPU", limit: 80, unit: "%", minutes: 5 });
    expect(by.a2.outcome).toBe("covered");
    expect(by.a3).toMatchObject({ outcome: "skip", reason: "gpu" });
    expect(by.a4.outcome).toBe("noServer");
    expect(by.a5).toMatchObject({ outcome: "create", metric: "LOAD5", limit: 4 });
    expect(internals.monitors.get("a1")).toMatchObject({ serverId: "srv1", thresholdPct: 80, retries: 4, intervalSec: 60 });
    expect(internals.monitors.get("a5")).toMatchObject({ thresholdValue: 4 });
    expect(internals.hasStatusAlert).toBe(true);
    expect(view.emails).toBe(1);
  });

  it("applies a manual match and ignores a left-out system", () => {
    const input = base({ servers: [...base().servers, { id: "srv2", name: "db", hostname: null, publicIp: null, publicIpv6: null, reportedIps: [] }] });
    const { view } = buildPlan({ ...input, overrides: { sysB: "srv2" } });
    expect(view.systems.find((s) => s.id === "sysB")?.match).toEqual({ serverId: "srv2", serverName: "db", by: "manual" });
    expect(view.alerts.find((a) => a.id === "a4")?.outcome).toBe("create");
    const left = buildPlan({ ...input, overrides: { sysA: null } });
    expect(left.view.systems.find((s) => s.id === "sysA")?.match).toBeNull();
  });

  it("reuses an equal monitor and an equal channel instead of duplicating", () => {
    const key = channelKey("telegram", { botToken: "1:AAA", chatId: "@ops" });
    const { view } = buildPlan(base({ existingMonitors: [{ serverId: "srv1", metric: "CPU" }], existingChannelKeys: new Set([key]) }));
    expect(view.alerts.find((a) => a.id === "a1")?.outcome).toBe("exists");
    expect(view.channels[0]).toMatchObject({ outcome: "exists", type: "telegram" });
  });

  it("lists unsupported and duplicate webhooks and never puts a token in the preview", () => {
    const { view } = buildPlan(base());
    expect(view.channels.map((c) => [c.outcome, c.reason ?? null])).toEqual([["create", null], ["skip", "unsupportedService"], ["skip", "duplicate"]]);
    expect(JSON.stringify(view)).not.toContain("AAA");
  });

  it("changes the hash when the plan changes and not otherwise", () => {
    const a = buildPlan(base()).view.hash;
    expect(buildPlan(base()).view.hash).toBe(a);
    expect(buildPlan(base({ alerts: [] })).view.hash).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{32}$/);
  });

  it("ignores alerts of a system the login cannot list", () => {
    const { view } = buildPlan(base({ alerts: [{ id: "x", system: "ghost", name: "CPU", value: 50, min: 1 }] }));
    expect(view.alerts).toEqual([]);
  });
});
