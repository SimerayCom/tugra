import { describe, expect, it } from "vitest";
import { eventKey, eventSubject, humanizeEvent, quietGroup, summarizeActivity } from "./dashboard-activity";
import { translate } from "../i18n/translate";
import dashboard from "../i18n/locales/en/dashboard.json";
import type { AuditEntry } from "./types";

const e = (id: string, action: string, actor = "me@example.com", meta: unknown = null): AuditEntry => ({ id, actor, action, target: null, meta, createdAt: `2026-11-24T10:${id.padStart(2, "0")}:00Z` });
const t = (key: string, vars?: Record<string, string | number>) => translate({ dashboard }, key, vars);

describe("quietGroup", () => {
  it("classifies MCP calls, automatic refreshes and profile chatter; leaves real changes alone", () => {
    expect(quietGroup("mcp.tools_call")).toBe("mcp");
    expect(quietGroup("server.gpus.refresh")).toBe("system");
    expect(quietGroup("auth.profile.update")).toBe("system");
    expect(quietGroup("app.deploy")).toBeNull();
    expect(quietGroup("auth.login.failed")).toBeNull(); // security-relevant: never hidden
    expect(quietGroup("auth.refresh.reuse_detected")).toBeNull();
  });
});

describe("summarizeActivity", () => {
  const entries = [e("9", "mcp.tools_call"), e("8", "mcp.tools_call"), e("7", "app.deploy"), e("6", "server.gpus.refresh"), e("5", "mcp.tools_call"), e("4", "team.rename"), e("3", "auth.profile.update")];
  it("folds quiet events into one counted line per group at the position of the newest member", () => {
    const { lines, quietCount } = summarizeActivity(entries, false, 10);
    expect(quietCount).toBe(5);
    expect(lines.map((l) => (l.kind === "group" ? `${l.group}:${l.count}` : l.entry.action))).toEqual(["mcp:3", "app.deploy", "system:2", "team.rename"]);
  });
  it("lists every event when system events are shown, still capped", () => {
    const { lines } = summarizeActivity(entries, true, 4);
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.kind === "event")).toBe(true);
  });
  it("applies the limit after grouping", () => {
    expect(summarizeActivity(entries, false, 2).lines).toHaveLength(2);
  });
});

describe("humanizeEvent", () => {
  it("turns an action into a sentence, saying 'You' for the signed-in user", () => {
    expect(humanizeEvent(e("1", "team.rename", "me@example.com", { name: "Acme" }), t, "me@example.com")).toBe("You renamed a team to Acme.");
    expect(humanizeEvent(e("1", "app.deploy", "dev@example.com", { name: "Shop" }), t, "me@example.com")).toBe("dev@example.com deployed Shop.");
  });
  it("falls back to a neutral subject and to a generic line for unknown actions", () => {
    expect(humanizeEvent(e("1", "app.deploy", "dev@example.com"), t, null)).toBe("dev@example.com deployed an item.");
    expect(humanizeEvent(e("1", "totally.new_thing", "dev@example.com"), t, null)).toBe("dev@example.com: totally new thing");
  });
  it("derives the template key and the subject safely", () => {
    expect(eventKey("server.proxy.restart")).toBe("dashboard.event.server_proxy_restart");
    expect(eventSubject({ name: "  Shop " })).toBe("Shop");
    expect(eventSubject({ foo: 1 })).toBe("");
    expect(eventSubject("x")).toBe("");
    expect(eventSubject({ name: "x".repeat(200) })).toHaveLength(60);
  });
});
