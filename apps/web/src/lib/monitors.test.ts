import { describe, it, expect } from "vitest";
import { monitorColor, uptimeText, CHANNEL_FIELDS, heartbeatSummary } from "./monitors";
import type { Heartbeat } from "./types";

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
