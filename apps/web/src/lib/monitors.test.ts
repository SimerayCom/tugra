import { describe, it, expect } from "vitest";
import { monitorColor, uptimeText, CHANNEL_FIELDS, heartbeatSummary, cloudflareReasonKey, defaultChannelSelection, defaultMonitorSelection, limitFields, monitorLimit, metricUnit } from "./monitors";
import type { Heartbeat, KumaPlan } from "./types";

const beat = (status: Heartbeat["status"]): Heartbeat => ({ ts: 0, status, ms: 100, msg: null, important: false });

describe("heartbeatSummary", () => {
  it("counts up / down / total", () => {
    expect(heartbeatSummary([beat("UP"), beat("UP"), beat("DOWN"), beat("PENDING")])).toEqual({ up: 2, down: 1, total: 4 });
  });
  it("handles an empty window", () => {
    expect(heartbeatSummary([])).toEqual({ up: 0, down: 0, total: 0 });
  });
});

describe("monitor helpers", () => {
  it("maps status to a color", () => {
    expect(monitorColor("UP")).toContain("--c-g");
    expect(monitorColor("DOWN")).toContain("--c-r");
    expect(monitorColor("PENDING")).toContain("--c-am");
  });

  it("formats uptime text", () => {
    expect(uptimeText(100)).toBe("100%");
    expect(uptimeText(99.9)).toBe("99.90%");
  });

  it("knows the config fields per channel type", () => {
    expect(CHANNEL_FIELDS.telegram).toEqual(["botToken", "chatId"]);
    expect(CHANNEL_FIELDS.webhook).toEqual(["url"]);
  });
});

describe("cloudflareReasonKey", () => {
  it("maps each Cloudflare origin cause to its reason", () => {
    expect(cloudflareReasonKey("cf:520")).toBe("unknown_response");
    expect(cloudflareReasonKey("cf:521")).toBe("origin_down");
    expect(cloudflareReasonKey("cf:522")).toBe("connect_timeout");
    expect(cloudflareReasonKey("cf:523")).toBe("unreachable");
    expect(cloudflareReasonKey("cf:524")).toBe("timeout");
    expect(cloudflareReasonKey("cf:525")).toBe("ssl_handshake");
    expect(cloudflareReasonKey("cf:526")).toBe("ssl_invalid");
  });
  it("is null for anything else", () => {
    expect(cloudflareReasonKey("cf:530")).toBeNull();
    expect(cloudflareReasonKey(null)).toBeNull();
    expect(cloudflareReasonKey(undefined)).toBeNull();
  });
});

describe("kuma default selections", () => {
  const plan: KumaPlan = {
    monitors: [
      { ref: "1", name: "a", kumaType: "http", type: "HTTP", target: "https://example.com", action: "create", warnings: [], channelRefs: ["10"] },
      { ref: "2", name: "b", kumaType: "http", type: "HTTP", target: "https://example.org", action: "exists", warnings: [], channelRefs: ["11"] },
      { ref: "3", name: "c", kumaType: "docker", type: null, target: null, action: "unsupported", warnings: [], channelRefs: [] },
    ],
    channels: [
      { ref: "10", name: "x", kumaType: "telegram", type: "telegram", action: "create", warnings: [], usedBy: 1 },
      { ref: "11", name: "y", kumaType: "slack", type: "slack", action: "create", warnings: [], usedBy: 0 },
      { ref: "12", name: "z", kumaType: "discord", type: "discord", action: "reuse", warnings: [], usedBy: 1, existingId: "c1" },
    ],
    totals: { monitors: 3, create: 1, exists: 1, unsupported: 1, channelsToCreate: 2 },
  };
  it("selects only the monitors that would be created", () => {
    expect([...defaultMonitorSelection(plan)]).toEqual(["1"]);
  });
  it("ticks only the new alerts a selected monitor uses", () => {
    expect([...defaultChannelSelection(plan, defaultMonitorSelection(plan))]).toEqual(["10"]);
    expect([...defaultChannelSelection(plan, new Set())]).toEqual([]);
  });
});

describe("metric limits", () => {
  it("sends a percent for DISK/CPU/MEM and a value for the other kinds", () => {
    expect(limitFields("CPU", "85.4")).toEqual({ thresholdPct: 85 });
    expect(limitFields("CPU", "500")).toEqual({ thresholdPct: 100 });
    expect(limitFields("LOAD5", "2.5")).toEqual({ thresholdValue: 2.5 });
    expect(limitFields("TEMP", "")).toEqual({ thresholdValue: 1 });
  });
  it("reads the limit and unit of a monitor", () => {
    expect(monitorLimit({ metric: "DISK", thresholdPct: 90 })).toEqual({ metric: "DISK", value: 90, unit: "%" });
    expect(monitorLimit({ metric: "NET", thresholdPct: null, thresholdValue: 12 })).toEqual({ metric: "NET", value: 12, unit: "MB/s" });
    expect(monitorLimit({ metric: "LOAD1", thresholdPct: null, thresholdValue: 3 })).toEqual({ metric: "LOAD1", value: 3, unit: "" });
    expect(monitorLimit({ metric: null, thresholdPct: null })).toBeNull();
    expect(metricUnit("TEMP")).toBe("°C");
  });
});
