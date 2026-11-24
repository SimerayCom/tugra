import { EVENT_TYPES, EVENT_CATEGORY, NOTIFICATION_CATEGORIES } from "@tugra/shared";
import {
  categoryOfNotification,
  channelWantsEvent,
  channelWantsMonitorEvent,
  eventSeverity,
  routedConfig,
  severityOfLevel,
  topicFor,
} from "./routing";

describe("event → category map", () => {
  it("covers every subscribable event and monitor up/down, with valid categories", () => {
    for (const e of [...EVENT_TYPES, "monitor_up", "monitor_down"]) {
      expect(NOTIFICATION_CATEGORIES).toContain(EVENT_CATEGORY[e as keyof typeof EVENT_CATEGORY]);
    }
  });
  it("puts monitors in uptime, deploys in deploy, ssl in security, image updates in updates", () => {
    expect(EVENT_CATEGORY.monitor_down).toBe("uptime");
    expect(EVENT_CATEGORY.deploy_failed).toBe("deploy");
    expect(EVENT_CATEGORY.backup_failed).toBe("backup");
    expect(EVENT_CATEGORY.server_offline).toBe("server");
    expect(EVENT_CATEGORY.ssl_expiring).toBe("security");
    expect(EVENT_CATEGORY.image_update_available).toBe("updates");
  });
});

describe("severity", () => {
  it("maps template levels to tiers", () => {
    expect(severityOfLevel("success")).toBe("info");
    expect(severityOfLevel("info")).toBe("info");
    expect(severityOfLevel("warning")).toBe("warning");
    expect(severityOfLevel("failure")).toBe("critical");
  });
  it("derives it from the rendered template, per event", () => {
    const sev = (type: string, ctx: Record<string, unknown> = {}) => eventSeverity({ type, teamId: "t", ctx });
    expect(sev("deploy_success")).toBe("info");
    expect(sev("deploy_failed")).toBe("critical");
    expect(sev("deploy_rolled_back")).toBe("warning");
    expect(sev("ssl_expiring")).toBe("warning");
    expect(sev("monitor_down")).toBe("critical");
    expect(sev("monitor_up")).toBe("info");
  });
  it("renders a severity for every subscribable event without throwing", () => {
    for (const e of EVENT_TYPES) expect(["info", "warning", "critical"]).toContain(eventSeverity({ type: e, teamId: "t", ctx: {} }));
  });
});

describe("channelWantsEvent", () => {
  it("legacy channel (no rule): eventTypes alone decides, any severity", () => {
    const legacy = { eventTypes: ["deploy_failed"] };
    expect(channelWantsEvent(legacy, "deploy_failed", "critical")).toBe(true);
    expect(channelWantsEvent(legacy, "deploy_success", "info")).toBe(false);
    expect(channelWantsEvent({ eventTypes: ["deploy_success"], categories: undefined, minSeverity: undefined }, "deploy_success", "info")).toBe(true);
  });
  it("a category subscribes every event in it", () => {
    const ch = { eventTypes: [], categories: ["backup"] };
    expect(channelWantsEvent(ch, "backup_failed", "critical")).toBe(true);
    expect(channelWantsEvent(ch, "volume_backup_success", "info")).toBe(true);
    expect(channelWantsEvent(ch, "deploy_failed", "critical")).toBe(false);
  });
  it("minSeverity drops milder events, for both eventTypes and categories", () => {
    const ch = { eventTypes: ["deploy_success"], categories: ["server"], minSeverity: "warning" };
    expect(channelWantsEvent(ch, "deploy_success", "info")).toBe(false);
    expect(channelWantsEvent(ch, "server_online", "info")).toBe(false);
    expect(channelWantsEvent(ch, "swarm_degraded", "critical")).toBe(true);
    expect(channelWantsEvent({ ...ch, minSeverity: "critical" }, "container_mem_pressure", "warning")).toBe(false);
  });
  it("unknown min severity falls back to everything", () => {
    expect(channelWantsEvent({ eventTypes: ["deploy_failed"], minSeverity: "bogus" }, "deploy_failed", "info")).toBe(true);
  });
});

describe("channelWantsMonitorEvent", () => {
  it("legacy (no categories) passes everything, as the monitor link always did", () => {
    expect(channelWantsMonitorEvent({}, "info")).toBe(true);
    expect(channelWantsMonitorEvent({ categories: [] }, "critical")).toBe(true);
  });
  it("requires the uptime category once categories are set", () => {
    expect(channelWantsMonitorEvent({ categories: ["deploy"] }, "critical")).toBe(false);
    expect(channelWantsMonitorEvent({ categories: ["uptime", "deploy"] }, "critical")).toBe(true);
  });
  it("honours the severity floor (down only, no recoveries)", () => {
    const ch = { categories: ["uptime"], minSeverity: "critical" };
    expect(channelWantsMonitorEvent(ch, "info")).toBe(false);
    expect(channelWantsMonitorEvent(ch, "critical")).toBe(true);
  });
});

describe("telegram topics", () => {
  it("topicFor reads a positive integer for the category and ignores junk", () => {
    expect(topicFor({ deploy: 12 }, "deploy")).toBe(12);
    expect(topicFor({ deploy: 12 }, "backup")).toBeUndefined();
    expect(topicFor({ deploy: "12" }, "deploy")).toBeUndefined();
    expect(topicFor({ deploy: 0 }, "deploy")).toBeUndefined();
    expect(topicFor(null, "deploy")).toBeUndefined();
    expect(topicFor({ deploy: 12 }, undefined)).toBeUndefined();
  });
  it("categoryOfNotification: registry first, then a valid test category, else undefined", () => {
    expect(categoryOfNotification({ type: "backup_failed", ctx: {} })).toBe("backup");
    expect(categoryOfNotification({ type: "test", ctx: { category: "uptime" } })).toBe("uptime");
    expect(categoryOfNotification({ type: "test", ctx: { category: "nope" } })).toBeUndefined();
    expect(categoryOfNotification({ type: "test", ctx: {} })).toBeUndefined();
  });
  it("routedConfig overrides messageThreadId for telegram only, and keeps the default otherwise", () => {
    const cfg = { chatId: "-100", botToken: "x", messageThreadId: 1 };
    const topics = { deploy: 42 };
    expect(routedConfig("telegram", cfg, topics, { type: "deploy_failed", ctx: {} })).toEqual({ ...cfg, messageThreadId: 42 });
    expect(routedConfig("telegram", cfg, topics, { type: "backup_failed", ctx: {} })).toBe(cfg); // unmapped → default topic
    expect(routedConfig("telegram", cfg, null, { type: "deploy_failed", ctx: {} })).toBe(cfg);
    expect(routedConfig("slack", cfg, topics, { type: "deploy_failed", ctx: {} })).toBe(cfg);
    expect(routedConfig("telegram", cfg, topics, { type: "test", ctx: { category: "deploy" } })).toEqual({ ...cfg, messageThreadId: 42 });
  });
});
