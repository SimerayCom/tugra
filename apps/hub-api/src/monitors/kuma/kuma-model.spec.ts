import { BACKUP } from "./kuma-fixture";
import { dumpFromRows, KumaParseError, parseKumaBackup, toMonitor, toNotification } from "./kuma-model";

describe("parseKumaBackup", () => {
  it("reads monitors and notifications and the per-monitor notification links", () => {
    const d = parseKumaBackup(JSON.stringify(BACKUP));
    expect(d.monitors).toHaveLength(13);
    expect(d.notifications).toHaveLength(5);
    const site = d.monitors.find((m) => m.id === "10")!;
    expect(site).toMatchObject({ type: "http", intervalSec: 60, maxRetries: 2, resendInterval: 3, ignoreTls: true, maxRedirects: 5 });
    expect(site.acceptedStatuses).toEqual(["200-299", "401"]);
    expect(site.notificationIds.sort()).toEqual(["1", "2", "3"]); // the false entry is not a link
    expect(d.notifications[0].config.type).toBe("telegram");
  });

  it("rejects text that is not JSON, not a Kuma backup, or has no monitors", () => {
    const code = (text: string) => {
      try {
        parseKumaBackup(text);
      } catch (e) {
        return (e as KumaParseError).code;
      }
      return null;
    };
    expect(code("nope")).toBe("not_json");
    expect(code("[]")).toBe("not_kuma");
    expect(code('{"hello":1}')).toBe("not_kuma");
    expect(code('{"monitorList":[],"notificationList":[]}')).toBe("empty");
  });
});

describe("database rows", () => {
  it("accepts snake_case columns, 0/1 booleans and JSON-string lists", () => {
    const m = toMonitor({
      id: 3, name: "Db row", type: "keyword", url: "https://example.com", keyword: "up", invert_keyword: 1, retry_interval: 30,
      resend_interval: 2, ignore_tls: 1, upside_down: 0, accepted_statuscodes_json: '["200-299"]', maxretries: 1, interval: 45, active: 1,
    })!;
    expect(m).toMatchObject({ invertKeyword: true, retryIntervalSec: 30, resendInterval: 2, ignoreTls: true, upsideDown: false, intervalSec: 45, active: true });
    expect(m.acceptedStatuses).toEqual(["200-299"]);
  });

  it("joins monitor_notification rows", () => {
    const d = dumpFromRows(
      [{ id: 1, name: "A", type: "http", url: "https://example.com", interval: 60 }],
      [{ id: 9, name: "N", config: '{"type":"discord","discordWebhookUrl":"https://discord.example.com/x"}' }],
      [{ id: 1, monitor_id: 1, notification_id: 9 }],
    );
    expect(d.monitors[0].notificationIds).toEqual(["9"]);
    expect(d.notifications[0].config.discordWebhookUrl).toBe("https://discord.example.com/x");
  });

  it("tolerates a notification whose config is not valid JSON", () => {
    expect(toNotification({ id: 1, name: "X", config: "{broken" })!.config).toEqual({});
  });

  it("skips rows without an id or type", () => {
    expect(toMonitor({ name: "x" })).toBeNull();
    expect(toMonitor({ id: 1 })).toBeNull();
  });
});
