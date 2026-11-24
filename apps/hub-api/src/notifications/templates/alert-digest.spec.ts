import { renderEvent, type NotificationEvent } from "../event";
import { NotifI18nService } from "../notif-i18n.service";

const env = { webBaseUrl: "https://app.example.com", t: new NotifI18nService().forLocale("en") };
const render = (ev: NotificationEvent) => renderEvent(ev, env);

describe("alert_summary template", () => {
  const items = [{ title: "Deploy failed — blog", count: 3, level: "failure" }, { title: "Backup ok", count: 1, level: "success" }];
  it("repeat: names the alert and the count, singular and plural", () => {
    const many = render({ type: "alert_summary", teamId: "t", ctx: { reason: "repeat", total: 5, windowSec: 600, items: items.slice(0, 1) } });
    expect(many.title).toBe("Deploy failed — blog — 5 more");
    expect(many.summary).toBe("Happened 5 more times in the last 10 min.");
    expect(many.level).toBe("failure");
    const one = render({ type: "alert_summary", teamId: "t", ctx: { reason: "repeat", total: 1, windowSec: 30, items: items.slice(0, 1) } });
    expect(one.summary).toBe("Happened once more in the last 1 min.");
  });
  it("quiet / rate: list the held alerts and carry the worst level", () => {
    const quiet = render({ type: "alert_summary", teamId: "t", ctx: { reason: "quiet", total: 4, windowSec: 0, items } });
    expect(quiet.title).toBe("While you were away");
    expect(quiet.level).toBe("failure");
    expect(quiet.fields).toEqual([{ label: "Deploy failed — blog", value: "3×" }, { label: "Backup ok", value: "1×" }]);
    const rate = render({ type: "alert_summary", teamId: "t", ctx: { reason: "rate", total: 1, windowSec: 60, items: items.slice(1) } });
    expect(rate.summary).toBe("1 alert was held back to stay within this channel's limit.");
    expect(rate.level).toBe("success");
  });
  it("survives a garbage ctx", () => {
    expect(() => render({ type: "alert_summary", teamId: "t", ctx: { items: "x", total: "y" } })).not.toThrow();
  });
});

describe("weekly_digest template", () => {
  const ctx = {
    teamName: "Acme",
    deploys: { total: 12, failed: 1 },
    backups: { total: 30, failed: 0 },
    incidents: 0,
    busiestServer: { name: "web-1", cpuPct: 41.6 },
    suggestions: [{ code: "failing_deploys", params: { app: "Acme API", count: 2 } }, { code: "../evil", params: {} }],
  };
  it("renders the week in a few short lines", () => {
    const m = render({ type: "weekly_digest", teamId: "t", ctx });
    expect(m.title).toBe("Your week in Tugra — Acme");
    expect(m.summary).toBe("12 deploys, 1 failed · 30 backups, all good · busiest server web-1");
    expect(m.level).toBe("warning");
    const byLabel = Object.fromEntries(m.fields.map((f) => [f.label, f.value]));
    expect(byLabel["Busiest server"]).toBe("web-1 (avg CPU 42%)");
    expect(byLabel["Worth a look"]).toBe("• Acme API had 2 failed deploys. Check its logs."); // the bogus code is dropped
    expect(m.links[0].url).toBe("https://app.example.com/");
  });
  it("a quiet week is a good week", () => {
    const m = render({ type: "weekly_digest", teamId: "t", ctx: { teamName: "Acme", deploys: { total: 0, failed: 0 }, backups: { total: 4, failed: 0 }, incidents: 0, busiestServer: null, suggestions: [] } });
    expect(m.level).toBe("success");
    expect(m.summary).toBe("No deploys · 4 backups, all good");
    expect(m.fields.map((f) => f.label)).not.toContain("Worth a look");
  });
});
