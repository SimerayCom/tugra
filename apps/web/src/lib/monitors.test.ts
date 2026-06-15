import { describe, it, expect } from "vitest";
import { monitorColor, uptimeText, CHANNEL_FIELDS } from "./monitors";

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
