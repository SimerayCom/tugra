import { BACKUP } from "./kuma-fixture";
import { mapKumaMonitor, mapKumaNotification } from "./kuma-map";
import { parseKumaBackup } from "./kuma-model";

const dump = parseKumaBackup(JSON.stringify(BACKUP));
const mon = (id: string) => mapKumaMonitor(dump.monitors.find((m) => m.id === id)!);
const note = (id: string) => mapKumaNotification(dump.notifications.find((n) => n.id === id)!);

describe("mapKumaMonitor", () => {
  it("maps an HTTP monitor: interval, retries, resend, timeout, accepted codes, tls, redirects", () => {
    const m = mon("10");
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.draft).toMatchObject({
      name: "Website", type: "HTTP", target: "https://example.com", intervalSec: 60, retries: 2, resendEvery: 3, timeoutMs: 48000,
      enabled: true, acceptedStatus: ["200-299", "401"], ignoreTls: true, maxRedirects: 5,
    });
    expect(m.draft.method).toBeUndefined(); // GET is the default
    expect(m.channelRefs.sort()).toEqual(["1", "2", "3"]);
  });

  it("keeps valid headers, drops framing headers, and warns about the retry interval", () => {
    const m = mon("10");
    if (!m.ok) throw new Error("expected ok");
    expect(m.draft.headers).toEqual({ Authorization: "Bearer s3cr3t" });
    expect(m.warnings).toEqual(expect.arrayContaining([
      { code: "retry_interval", params: { seconds: 20 } },
      { code: "headers_dropped", params: { count: 1 } },
    ]));
  });

  it("maps basic auth, a POST method and a JSON body (with a content type)", () => {
    const m = mon("11");
    if (!m.ok) throw new Error("expected ok");
    expect(m.draft).toMatchObject({ method: "POST", basicAuth: { user: "svc", pass: "pw" }, body: "{\"ping\":true}" });
    expect(m.draft.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("maps keyword monitors, including the inverted flag", () => {
    const m = mon("12");
    if (!m.ok) throw new Error("expected ok");
    expect(m.draft).toMatchObject({ type: "KEYWORD", keyword: "OK", keywordInvert: true, intervalSec: 120 });
  });

  it("maps TCP, ping and DNS targets", () => {
    const tcp = mon("13");
    const ping = mon("14");
    const dns = mon("15");
    if (!tcp.ok || !ping.ok || !dns.ok) throw new Error("expected ok");
    expect(tcp.draft).toMatchObject({ type: "TCP", target: "db.example.com:5432", retries: 3 });
    expect(ping.draft).toMatchObject({ type: "PING", target: "gw.example.com" });
    expect(dns.draft).toMatchObject({ type: "DNS", target: "example.com", dnsRecordType: "MX", dnsServer: "1.1.1.1" });
  });

  it("carries paused monitors as disabled", () => {
    const m = mon("18");
    if (!m.ok) throw new Error("expected ok");
    expect(m.draft.enabled).toBe(false);
  });

  it("flags what it cannot carry over", () => {
    const m = mon("22");
    if (!m.ok) throw new Error("expected ok");
    expect(m.warnings).toEqual(expect.arrayContaining([{ code: "auth_method", params: { method: "ntlm" } }, { code: "cert_expiry" }]));
  });

  it.each([
    ["16", "type"], // docker
    ["17", "group"],
    ["19", "target"], // not a URL
    ["20", "keyword"], // keyword monitor without a keyword
    ["21", "dns_type"], // SOA
  ])("does not import monitor %s (%s)", (id, reason) => {
    const m = mon(id);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toBe(reason);
  });

  it("never sends the draft a value Tugra's own create schema would refuse", async () => {
    const { CreateMonitorSchema } = await import("../dto");
    for (const k of dump.monitors) {
      const m = mapKumaMonitor(k);
      if (!m.ok) continue;
      const parsed = CreateMonitorSchema.safeParse({ ...m.draft, teamId: "t1", channelIds: [] });
      expect(parsed.success).toBe(true);
    }
  });
});

describe("mapKumaNotification", () => {
  it("maps telegram", () => {
    const n = note("1");
    expect(n).toMatchObject({ ok: true, type: "telegram", config: { botToken: "123:abc", chatId: "-100200", messageThreadId: 5 } });
  });

  it("maps a webhook with headers and warns that the payload format differs", () => {
    const n = note("2");
    expect(n).toMatchObject({ ok: true, type: "webhook", config: { url: "https://hooks.example.com/in", headers: { "X-Team": "acme" } } });
    if (n.ok) expect(n.warnings).toEqual([{ code: "webhook_format" }]);
  });

  it("maps smtp", () => {
    expect(note("4")).toMatchObject({ ok: true, type: "smtp", config: { host: "smtp.example.com", port: 587, secure: false, user: "u", pass: "p", from: "a@example.com", to: "b@example.com" } });
  });

  it("reports an unknown provider and an incomplete one", () => {
    expect(note("3")).toMatchObject({ ok: false, reason: "type", kumaType: "pagerduty" });
    expect(note("5")).toMatchObject({ ok: false, reason: "incomplete" });
  });

  it.each([
    [{ type: "discord", discordWebhookUrl: "https://d.example.com/w" }, "discord", { webhookUrl: "https://d.example.com/w" }],
    [{ type: "slack", slackwebhookURL: "https://s.example.com/w" }, "slack", { webhookUrl: "https://s.example.com/w" }],
    [{ type: "ntfy", ntfytopic: "alerts", ntfyserverurl: "https://ntfy.example.com", ntfyPriority: 4 }, "ntfy", { topic: "alerts", server: "https://ntfy.example.com", priority: 4 }],
    [{ type: "gotify", gotifyserverurl: "https://g.example.com", gotifyapplicationToken: "t" }, "gotify", { server: "https://g.example.com", token: "t" }],
    [{ type: "pushover", pushoveruserkey: "u", pushoverapptoken: "a" }, "pushover", { userKey: "u", token: "a" }],
    [{ type: "teams", webhookUrl: "https://t.example.com/w" }, "teams", { webhookUrl: "https://t.example.com/w" }],
    [{ type: "mattermost", mattermostWebhookUrl: "https://m.example.com/w" }, "mattermost", { webhookUrl: "https://m.example.com/w" }],
  ])("maps %j", (config, type, expected) => {
    expect(mapKumaNotification({ id: "9", name: "N", active: true, config })).toMatchObject({ ok: true, type, config: expected });
  });
});
